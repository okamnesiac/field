import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { sha256File, sha256Text } from '../hash.js';
import { formatLabel } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { deps, resolveLabel, type Graph, type GraphNode, type RuleNode } from './graph.js';

const execFileAsync = promisify(execFile);

// Action cache (project-core.md §3.5): outputs live in a content-addressed
// store under .bloom/cache/cas/<sha256>; the action index maps an action
// key — the hash of canonical JSON of {rule, rule_version, input hashes,
// parameters, project sample rate} — to its output hashes. Same key, no
// work. Rules carry an explicit rule_version bumped to invalidate.

const RULE_VERSIONS: Record<string, number> = {
  normalize: 1,
  'sc-render': 1,
};

export interface ActionEntry {
  rule: string;
  outputs: { sha256: string; bytes: number }[];
}

export interface BuildOutcome {
  label: string;
  cached: boolean; // action-cache hit, nothing executed
  outputPath?: string; // materialized path for rule targets
  sha256: string;
}

export interface Explanation {
  label: string;
  kind: 'asset' | 'rule';
  rule?: string;
  ruleVersion?: number;
  inputs: { label: string; sha256: string }[];
  parameters?: Record<string, unknown>;
  actionKey?: string;
  cached?: boolean;
  outputs?: { sha256: string; bytes: number }[];
}

export interface RunContext {
  sampleRate: number; // project sample rate
}

// Executes a rule: reads input file, writes output file. Injectable so
// tests can count executions or fake the tool.
export type RuleRunner = (
  rule: RuleNode,
  inputPath: string,
  outputPath: string,
  ctx: RunContext,
) => Promise<void>;

const SCLANG_APP_FALLBACK = '/Applications/SuperCollider.app/Contents/MacOS/sclang';

type ExecError = Error & {
  code?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

// sclang reports compile and runtime errors on *stdout*; Node's exec error
// message carries only stderr. Surface both, or the edit-retry loop this
// exists for is flying blind.
function formatScError(err: ExecError, programPath: string, timeoutMs: number): Error {
  if (err.killed) {
    return new Error(
      `sclang timed out after ${Math.round(timeoutMs / 1000)}s for ${programPath} — ` +
        `did the program call 0.exit?`,
    );
  }
  const stdoutTail = (err.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-15)
    .join('\n');
  const detail = stdoutTail ? `\n${stdoutTail}` : '';
  return new Error(`sclang failed for ${programPath}: ${err.message}${detail}`);
}

// Run an SC program under the sc-render contract: sclang gets the render
// parameters in the environment, and must write BLOOM_OUTPUT and exit.
export async function runScProgram(
  programPath: string,
  outputPath: string,
  params: {
    seed: number;
    duration: number;
    channels: number;
    sampleRate: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const env = {
    ...process.env,
    BLOOM_OUTPUT: outputPath,
    BLOOM_SEED: String(params.seed),
    BLOOM_DURATION: String(params.duration),
    BLOOM_SAMPLE_RATE: String(params.sampleRate),
    BLOOM_CHANNELS: String(params.channels),
  };
  // The ceiling scales with the render: NRT is usually faster than realtime,
  // but the schema admits hour-long renders, and the ceiling exists to catch
  // hangs, not to race legitimate work.
  const timeout = params.timeoutMs ?? Math.max(180_000, 60_000 + params.duration * 10_000);
  const options = { env, timeout };
  const override = process.env['BLOOM_SCLANG'];
  try {
    await execFileAsync(override ?? 'sclang', [programPath], options);
  } catch (err) {
    const e = err as ExecError;
    if (e.code === 'ENOENT') {
      if (override) {
        // The override is the determinism escape hatch (sc-render.md §2); a
        // typo'd wrapper must never silently render through the app bundle.
        throw new Error(`BLOOM_SCLANG points at a missing binary: ${override}`);
      }
      if (existsSync(SCLANG_APP_FALLBACK)) {
        try {
          await execFileAsync(SCLANG_APP_FALLBACK, [programPath], options);
          return;
        } catch (fallbackErr) {
          throw formatScError(fallbackErr as ExecError, programPath, timeout);
        }
      }
      throw new Error('sclang not found on PATH (install SuperCollider or set BLOOM_SCLANG)');
    }
    throw formatScError(e, programPath, timeout);
  }
}

export const defaultRunner: RuleRunner = async (node, inputPath, outputPath, ctx) => {
  const t = node.target;
  if (t.rule === 'normalize') {
    // afconvert is macOS-built-in with excellent SRC (project-core.md §5).
    await execFileAsync('afconvert', [
      '-f',
      'WAVE',
      '-d',
      `LEI${t.bit_depth}@${t.sample_rate}`,
      inputPath,
      outputPath,
    ]);
    return;
  }
  if (t.rule === 'sc-render') {
    await runScProgram(inputPath, outputPath, {
      seed: t.seed,
      duration: t.duration,
      channels: t.channels,
      sampleRate: ctx.sampleRate,
    });
    if (!existsSync(outputPath)) {
      throw new Error(
        `sc program ${t.program} exited without writing BLOOM_OUTPUT — ` +
          `it must render to the path in BLOOM_OUTPUT and call 0.exit`,
      );
    }
    return;
  }
  throw new Error(`unknown rule "${(t as { rule: string }).rule}"`);
};

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

// Wiring fields: identity plus what already contributes to the key as an
// input hash. Everything else is a knob that shapes the output.
const WIRING_FIELDS = new Set(['name', 'rule', 'input', 'program']);

function ruleParameters(node: RuleNode): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(node.target).filter(([k]) => !WIRING_FIELDS.has(k)),
  );
}

function actionKey(node: RuleNode, inputHashes: string[], projectSampleRate: number): string {
  return sha256Text(
    canonicalJson({
      rule: node.target.rule,
      rule_version: RULE_VERSIONS[node.target.rule],
      inputs: inputHashes,
      parameters: ruleParameters(node),
      project_sample_rate: projectSampleRate,
    }),
  );
}

function assetFilePath(project: LoadedProject, node: GraphNode): string {
  if (node.kind !== 'asset') throw new Error('not an asset node');
  return join(project.root, node.songDir, node.asset.file);
}

// Materialized outputs land under .bloom/out mirroring the label path, so
// humans can play what they built without digging in the CAS.
function outPath(project: LoadedProject, node: RuleNode): string {
  return join(project.root, '.bloom', 'out', node.label.pkg, `${node.label.name}.wav`);
}

async function buildNode(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
  runner: RuleRunner,
): Promise<BuildOutcome> {
  if (node.kind === 'asset') {
    // Source targets: the declared hash is the identity; check verifies
    // content, the build system trusts the declaration.
    return { label: formatLabel(node.label), cached: true, sha256: node.asset.sha256 };
  }

  const inputNodes = node.deps.map((d) => resolveLabel(graph, d));
  const inputHashes = inputNodes.map((d) => {
    if (d.kind !== 'asset') throw new Error('only asset inputs supported');
    return d.asset.sha256;
  });
  // An sc-render program is an input by content: hashing the actual bytes
  // keys the action to the code as-is (no declaration to disagree with),
  // so editing the program invalidates exactly its own renders.
  if (node.target.rule === 'sc-render') {
    inputHashes.push(await sha256File(join(project.root, node.target.program)));
  }
  const sampleRate = project.manifest?.data.sample_rate ?? 48000;
  const key = actionKey(node, inputHashes, sampleRate);

  const materialize = (sha256: string): string => {
    const out = outPath(project, node);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(casPath(project, sha256), out);
    return out;
  };

  const cached = readAction(project, key);
  if (cached) {
    const sha256 = cached.outputs[0]!.sha256;
    return { label: formatLabel(node.label), cached: true, outputPath: materialize(sha256), sha256 };
  }

  // The action key is the *declared* input hash, so before executing, the
  // consumed bytes must match the declaration — otherwise a tampered file
  // gets cached under the clean file's key and the poisoned entry outlives
  // the tampering. Only executed actions pay this cost; cache hits don't
  // read inputs at all.
  for (const input of inputNodes) {
    if (input.kind !== 'asset') continue;
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
  }

  const inputPath =
    node.target.rule === 'sc-render'
      ? join(project.root, node.target.program)
      : assetFilePath(project, inputNodes[0]!);
  const tmpDir = join(cacheDir(project), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpOut = join(tmpDir, `${key}.out`);
  await runner(node, inputPath, tmpOut, { sampleRate });
  if (!existsSync(tmpOut)) {
    throw new Error(`rule "${node.target.rule}" produced no output for ${formatLabel(node.label)}`);
  }

  // The program hash was read for the key before the render; if the file
  // changed underneath the run, the output came from code the key doesn't
  // describe — refuse to cache it.
  if (node.target.rule === 'sc-render') {
    const after = await sha256File(join(project.root, node.target.program));
    if (after !== inputHashes[inputHashes.length - 1]) {
      throw new Error(
        `refusing to cache: ${node.target.program} changed during the render of ` +
          `${formatLabel(node.label)} — re-run the build`,
      );
    }
  }

  const sha256 = await sha256File(tmpOut);
  const bytes = statSync(tmpOut).size;
  mkdirSync(join(cacheDir(project), 'cas'), { recursive: true });
  renameSync(tmpOut, casPath(project, sha256));

  // The action entry is the cache marker, written last: a crash between
  // CAS write and here just re-runs the rule next time.
  writeAction(project, key, { rule: node.target.rule, outputs: [{ sha256, bytes }] });

  return { label: formatLabel(node.label), cached: false, outputPath: materialize(sha256), sha256 };
}

// Build nodes in dependency order (deps() returns dependencies first).
export async function build(
  project: LoadedProject,
  graph: Graph,
  nodes: GraphNode[],
  runner: RuleRunner = defaultRunner,
): Promise<BuildOutcome[]> {
  const outcomes: BuildOutcome[] = [];
  const done = new Set<string>();
  for (const start of nodes) {
    for (const node of deps(graph, start)) {
      const label = formatLabel(node.label);
      if (done.has(label)) continue;
      done.add(label);
      outcomes.push(await buildNode(project, graph, node, runner));
    }
  }
  return outcomes;
}

export async function explain(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
): Promise<Explanation> {
  if (node.kind === 'asset') {
    return {
      label: formatLabel(node.label),
      kind: 'asset',
      inputs: [],
      outputs: [{ sha256: node.asset.sha256, bytes: node.asset.bytes }],
    };
  }
  const inputNodes = node.deps.map((d) => resolveLabel(graph, d));
  const inputs = inputNodes.map((d) => ({
    label: formatLabel(d.label),
    sha256: d.kind === 'asset' ? d.asset.sha256 : '',
  }));
  if (node.target.rule === 'sc-render') {
    // The program participates as an input by content hash; shown by path
    // since it is a file, not a graph node.
    inputs.push({
      label: node.target.program,
      sha256: await sha256File(join(project.root, node.target.program)),
    });
  }
  const sampleRate = project.manifest?.data.sample_rate ?? 48000;
  const key = actionKey(node, inputs.map((i) => i.sha256), sampleRate);
  const cached = readAction(project, key);
  return {
    label: formatLabel(node.label),
    kind: 'rule',
    rule: node.target.rule,
    ruleVersion: RULE_VERSIONS[node.target.rule]!,
    inputs,
    parameters: ruleParameters(node),
    actionKey: key,
    cached: cached !== undefined,
    ...(cached ? { outputs: cached.outputs } : {}),
  };
}
