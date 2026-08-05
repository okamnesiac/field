import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

// Executes a rule: reads input file, writes output file. Injectable so
// tests can count executions or fake the tool.
export type RuleRunner = (
  rule: RuleNode,
  inputPath: string,
  outputPath: string,
) => Promise<void>;

export const defaultRunner: RuleRunner = async (node, inputPath, outputPath) => {
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
  const entry = JSON.parse(readFileSync(path, 'utf8')) as ActionEntry;
  // A cache hit requires the outputs to still exist in the CAS.
  if (!entry.outputs.every((o) => existsSync(casPath(project, o.sha256)))) return undefined;
  return entry;
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

function ruleParameters(node: RuleNode): Record<string, unknown> {
  // Everything except identity and wiring: the knobs that shape the output.
  const { name: _name, rule: _rule, input: _input, ...params } = node.target;
  return params;
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

  const inputPath = assetFilePath(project, inputNodes[0]!);
  const tmpDir = join(cacheDir(project), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpOut = join(tmpDir, `${key}.out`);
  await runner(node, inputPath, tmpOut);
  if (!existsSync(tmpOut)) {
    throw new Error(`rule "${node.target.rule}" produced no output for ${formatLabel(node.label)}`);
  }

  const sha256 = await sha256File(tmpOut);
  const bytes = statSync(tmpOut).size;
  mkdirSync(join(cacheDir(project), 'cas'), { recursive: true });
  renameSync(tmpOut, casPath(project, sha256));

  // The action entry is the cache marker, written last: a crash between
  // CAS write and here just re-runs the rule next time.
  mkdirSync(join(cacheDir(project), 'actions'), { recursive: true });
  const entry: ActionEntry = { rule: node.target.rule, outputs: [{ sha256, bytes }] };
  writeFileSync(actionPath(project, key), JSON.stringify(entry, null, 2) + '\n');

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

export function explain(project: LoadedProject, graph: Graph, node: GraphNode): Explanation {
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
