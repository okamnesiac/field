import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { sha256File, sha256Text } from '../hash.js';
import { formatLabel } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { generatorFor, type ExtraInput, type RunContext } from '../generators/index.js';
import { deps, resolveLabel, type Graph, type GraphNode, type GeneratorNode } from './graph.js';

// Action cache (project-core.md §3.5): outputs live in a content-addressed
// store under .bloom/cache/cas/<sha256>; the action index maps an action
// key — the hash of canonical JSON of {rule, rule_version, input hashes,
// parameters, project sample rate} — to its output hashes. Same key, no
// work. Rule behavior lives in src/generators/; this engine only knows that
// rules exist.

export interface ActionEntry {
  rule: string;
  outputs: { sha256: string; bytes: number }[];
}

export interface BuildOutcome {
  label: string;
  cached: boolean; // action-cache hit, nothing executed
  // Where the output lives: the materialized .bloom/out path for rule
  // targets, the committed file for assets and generation labels — every
  // outcome names a playable path, so watch can hand any label's fresh
  // artifact to the daemon (#35 review: a chosen-variant repoint is
  // exactly a committed label whose path moved).
  outputPath?: string;
  sha256: string;
}

export interface Explanation {
  label: string;
  kind: 'asset' | 'rule' | 'generation';
  rule?: string;
  ruleVersion?: number;
  inputs: { label: string; sha256: string }[];
  parameters?: Record<string, unknown>;
  actionKey?: string;
  cached?: boolean;
  outputs?: { sha256: string; bytes: number }[];
}

// Executes a rule: reads input files, writes the output file. Injectable so
// tests can count executions or fake the tool.
export type GeneratorRunner = (
  rule: GeneratorNode,
  inputPaths: string[],
  outputPath: string,
  ctx: RunContext,
) => Promise<void>;

export const defaultRunner: GeneratorRunner = (node, inputPaths, outputPath, ctx) =>
  generatorFor(node.spec).execute(node.spec, inputPaths, outputPath, ctx);

function cacheDir(project: LoadedProject): string {
  return join(project.root, '.bloom', 'cache');
}

function casPath(project: LoadedProject, sha256: string): string {
  return join(cacheDir(project), 'cas', sha256);
}

function actionPath(project: LoadedProject, key: string): string {
  return join(cacheDir(project), 'actions', `${key}.json`);
}

function readAction(project: LoadedProject, key: string): ActionEntry | undefined {
  const path = actionPath(project, key);
  if (!existsSync(path)) return undefined;
  let entry: ActionEntry;
  try {
    entry = JSON.parse(readFileSync(path, 'utf8')) as ActionEntry;
  } catch {
    // Truncated by a crash mid-write: a corrupt entry is a cache miss, not
    // a wedged cache. Remove it so the rebuild can write a fresh one.
    rmSync(path, { force: true });
    return undefined;
  }
  // A cache hit requires the outputs to still exist in the CAS.
  if (!entry.outputs.every((o) => existsSync(casPath(project, o.sha256)))) return undefined;
  return entry;
}

function writeAction(project: LoadedProject, key: string, entry: ActionEntry): void {
  mkdirSync(join(cacheDir(project), 'actions'), { recursive: true });
  const path = actionPath(project, key);
  // tmp + rename so the entry appears atomically: a crash leaves either no
  // entry (re-run) or a complete one, never a truncated file.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  renameSync(tmp, path);
}

// Deterministic serialization for hashing: sorted keys, no whitespace.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The knobs that shape the output: everything except identity (name, type)
// and the rule's declared wiring, which already contributes as input hashes.
function ruleParameters(node: GeneratorNode): Record<string, unknown> {
  const wiring = new Set(['name', 'type', ...generatorFor(node.spec).wiringFields]);
  return Object.fromEntries(Object.entries(node.spec).filter(([k]) => !wiring.has(k)));
}

function actionKey(node: GeneratorNode, inputHashes: string[], projectSampleRate: number): string {
  // The serialized field stays spelled `rule` deliberately: it is pure
  // cache machinery, and renaming a hash key would invalidate every
  // cached action for zero semantic gain (project-layout.md §4 keeps
  // engine words in the engine). Only type *values* changing re-keys —
  // sc-render → supercollider, priced in by §4.4.
  return sha256Text(
    canonicalJson({
      rule: node.spec.type,
      rule_version: generatorFor(node.spec).version,
      inputs: inputHashes,
      parameters: ruleParameters(node),
      project_sample_rate: projectSampleRate,
    }),
  );
}

function assetFilePath(project: LoadedProject, node: GraphNode): string {
  if (node.kind !== 'asset') throw new Error('not an asset node');
  return join(project.root, node.scopeDir, node.asset.file);
}

// Materialized outputs land under .bloom/out mirroring the label path, so
// humans can play what they built without digging in the CAS.
function outPath(project: LoadedProject, node: GeneratorNode): string {
  return join(project.root, '.bloom', 'out', node.label.pkg, `${node.label.name}.wav`);
}

async function buildNode(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
  runner: GeneratorRunner,
  built: Map<string, BuildOutcome>,
): Promise<BuildOutcome> {
  if (node.kind === 'asset') {
    // Source targets: the declared hash is the identity; check verifies
    // content, the build system trusts the declaration.
    return {
      label: formatLabel(node.label),
      cached: true,
      sha256: node.asset.sha256,
      outputPath: assetFilePath(project, node),
    };
  }
  if (node.kind === 'generation') {
    // Deliberate sounds and their variants are committed sources like
    // assets — recorded hash as identity, nothing to execute. A chosen
    // sound's node is consumable by clips and rules like any committed
    // content (project-layout.md §1.4).
    return {
      label: formatLabel(node.label),
      cached: true,
      sha256: node.sha256,
      outputPath: join(project.root, node.songDir, node.file),
    };
  }

  const impl = generatorFor(node.spec);
  const inputNodes = node.deps.map((d) => resolveLabel(graph, d));
  // Asset inputs contribute their declared hash; rule inputs (mix ← stems)
  // contribute the output hash of the already-built dependency — build()
  // walks in dependency order, so it is always present.
  const declaredHashes = inputNodes.map((d) => {
    if (d.kind === 'asset') return d.asset.sha256;
    const dep = built.get(formatLabel(d.label));
    if (!dep) {
      throw new Error(`internal: ${formatLabel(d.label)} not built before ${formatLabel(node.label)}`);
    }
    return dep.sha256;
  });
  const extraInputs: ExtraInput[] = impl.extraInputs
    ? await impl.extraInputs(project.root, node.spec)
    : [];
  const inputHashes = [...declaredHashes, ...extraInputs.map((e) => e.sha256)];
  const sampleRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const key = actionKey(node, inputHashes, sampleRate);

  const materialize = (sha256: string): string => {
    const out = outPath(project, node);
    mkdirSync(dirname(out), { recursive: true });
    // Copy-to-temp + rename, never copy-in-place: under watch the daemon
    // may be streaming the previous artifact from this very path, and an
    // in-place copy truncates under its reader. A fresh inode leaves the
    // playing pass untouched until the swap (watch.md §1.6).
    const tmp = `${out}.tmp-${process.pid}`;
    copyFileSync(casPath(project, sha256), tmp);
    renameSync(tmp, out);
    return out;
  };

  const cached = readAction(project, key);
  if (cached) {
    const sha256 = cached.outputs[0]!.sha256;
    return { label: formatLabel(node.label), cached: true, outputPath: materialize(sha256), sha256 };
  }

  // The action key uses the *declared* asset hashes, so before executing,
  // the consumed bytes must match the declaration — otherwise a tampered
  // file gets cached under the clean file's key and the poisoned entry
  // outlives the tampering. Only executed actions pay this cost; cache hits
  // don't read inputs at all. Rule inputs need no such check: they are
  // materialized from the CAS this build just wrote — machine-managed
  // state, unlike asset files a human can edit.
  for (const input of inputNodes) {
    if (input.kind === 'asset') {
      const path = assetFilePath(project, input);
      const size = statSync(path).size;
      if (size !== input.asset.bytes) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} is ${size} bytes on disk but ` +
            `${input.asset.bytes} declared (bloom check, then re-import or restore the file)`,
        );
      }
      const actual = await sha256File(path);
      if (actual !== input.asset.sha256) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} content does not match its ` +
            `declared sha256 (bloom check, then re-import or restore the file)`,
        );
      }
    } else if (input.kind === 'generation') {
      // Committed variants are human-visible files too; same tamper guard.
      const actual = await sha256File(join(project.root, input.songDir, input.file));
      if (actual !== input.sha256) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} content does not match its ` +
            `recorded sha256 (bloom check)`,
        );
      }
    }
  }

  const inputPaths = inputNodes.map((d) => {
    if (d.kind === 'asset') return assetFilePath(project, d);
    if (d.kind === 'generation') return join(project.root, d.songDir, d.file);
    return built.get(formatLabel(d.label))!.outputPath!;
  });
  const tmpDir = join(cacheDir(project), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpOut = join(tmpDir, `${key}.out`);
  await runner(node, inputPaths, tmpOut, { root: project.root, sampleRate });
  if (!existsSync(tmpOut)) {
    throw new Error(`type "${node.spec.type}" produced no output for ${formatLabel(node.label)}`);
  }

  // Extra inputs were hashed for the key before the run; a rule may refuse
  // to cache output that came from since-changed inputs.
  if (impl.verifyAfterRun) {
    await impl.verifyAfterRun(project.root, node.spec, extraInputs);
  }

  const sha256 = await sha256File(tmpOut);
  const bytes = statSync(tmpOut).size;
  mkdirSync(join(cacheDir(project), 'cas'), { recursive: true });
  renameSync(tmpOut, casPath(project, sha256));

  // The action entry is the cache marker, written last: a crash between
  // CAS write and here just re-runs the rule next time.
  writeAction(project, key, { rule: node.spec.type, outputs: [{ sha256, bytes }] });

  return { label: formatLabel(node.label), cached: false, outputPath: materialize(sha256), sha256 };
}

// Build nodes in dependency order (deps() returns dependencies first).
export async function build(
  project: LoadedProject,
  graph: Graph,
  nodes: GraphNode[],
  runner: GeneratorRunner = defaultRunner,
): Promise<BuildOutcome[]> {
  const outcomes: BuildOutcome[] = [];
  const built = new Map<string, BuildOutcome>();
  for (const start of nodes) {
    for (const node of deps(graph, start)) {
      const label = formatLabel(node.label);
      if (built.has(label)) continue;
      const outcome = await buildNode(project, graph, node, runner, built);
      built.set(label, outcome);
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

export async function explain(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
  memo: Map<string, Explanation> = new Map(),
): Promise<Explanation> {
  const label = formatLabel(node.label);
  const seen = memo.get(label);
  if (seen) return seen;

  if (node.kind === 'asset') {
    const explanation: Explanation = {
      label,
      kind: 'asset',
      inputs: [],
      outputs: [{ sha256: node.asset.sha256, bytes: node.asset.bytes }],
    };
    memo.set(label, explanation);
    return explanation;
  }
  if (node.kind === 'generation') {
    // Recipes record the hash but not the size; the file is on disk (a
    // valid project has no dangling variants), so stat answers bytes.
    const explanation: Explanation = {
      label,
      kind: 'generation',
      inputs: [],
      outputs: [
        {
          sha256: node.sha256,
          bytes: statSync(join(project.root, node.songDir, node.file)).size,
        },
      ],
    };
    memo.set(label, explanation);
    return explanation;
  }
  const impl = generatorFor(node.spec);
  // A rule input's hash is its dependency's cached output — explaining
  // recursively without executing anything. An unbuilt dependency means
  // this node's action key cannot be known yet.
  const inputs: { label: string; sha256: string }[] = [];
  let unknown = false;
  for (const depLabel of node.deps) {
    const dep = await explain(project, graph, resolveLabel(graph, depLabel), memo);
    const sha256 = dep.cached !== false && dep.outputs ? dep.outputs[0]!.sha256 : '';
    if (sha256 === '') unknown = true;
    inputs.push({ label: dep.label, sha256 });
  }
  if (impl.extraInputs) {
    inputs.push(...(await impl.extraInputs(project.root, node.spec)));
  }
  const sampleRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const key = unknown ? undefined : actionKey(node, inputs.map((i) => i.sha256), sampleRate);
  const cached = key === undefined ? undefined : readAction(project, key);
  const explanation: Explanation = {
    label,
    kind: 'rule',
    rule: node.spec.type,
    ruleVersion: impl.version,
    inputs,
    parameters: ruleParameters(node),
    ...(key !== undefined ? { actionKey: key } : {}),
    cached: cached !== undefined,
    ...(cached ? { outputs: cached.outputs } : {}),
  };
  memo.set(label, explanation);
  return explanation;
}
