import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256File, sha256Text } from '../hash.js';
import { formatLabel } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { reaches, type Reach } from '../model/levels.js';
import type { Cable } from '../model/cables.js';
import { generatorFor, type ExtraInput, type RunContext } from '../generators/index.js';
import type { RemoteReads } from '../remote/cache.js';
import { assertGenerated, deps, resolveLabel, type Graph, type GraphNode, type GeneratorNode } from './graph.js';

// Action cache (project-core.md §3.5): outputs live in a content-addressed
// store under .field/cache/cas/<sha256>; the action index maps an action
// key — the hash of canonical JSON of {rule, rule_version, input hashes,
// parameters, the node's sample rate} — to its output hashes. Same key, no
// work. Rule behavior lives in src/generators/; this engine only knows that
// rules exist.

export interface ActionEntry {
  rule: string;
  outputs: { sha256: string; bytes: number }[];
}

export interface BuildOutcome {
  label: string;
  cached: boolean; // action-cache hit, nothing executed
  // Where the output lives: the materialized .field/out path for rule
  // targets, the committed file for assets and generation labels — every
  // outcome names a playable path, so watch can hand any label's fresh
  // artifact to the daemon (#35 review: a chosen-variant repoint is
  // exactly a committed label whose path moved).
  outputPath?: string;
  // The path names a committed source the build did not produce, not a
  // materialized output. `cached` cannot carry this: assets and chosen
  // variants report cached:true because nothing executed, which is not
  // the same claim as "this came out of the cache" (#35 review).
  committed?: boolean;
  // The entry came from the remote cache during this build (remote.md
  // §3.4): `cached` is true too, because nothing executed, but "a
  // server had it" and "this machine had it" are different claims —
  // the same honesty that separated `cached` from `committed`.
  fetched?: boolean;
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
  fetched?: boolean; // this explain brought the entry in from the remote
  outputs?: { sha256: string; bytes: number }[];
  // Generation nodes only: the committed file, and — on the node the
  // request's own label resolves to — which take is chosen, of how many.
  // This is the answer to "which variant are we using", so it lives on
  // the command whose job that question is (#115).
  file?: string;
  choice?: { chosen: number; takes: number };
  // Tracks only: where this track's signal goes and at what level
  // (model/levels.ts). The build graph runs the other way — a parent
  // depends on its children — so this is the one answer `explain` cannot
  // read off the node it was handed. An empty `reaches` means the track
  // is a root; `rootNote` says which kind. `cables` are the song's
  // cables touching this track, either end: a cable appears when either
  // end's level is questioned (nested-tracks.md §19 chunk 4).
  levels?: { track: string; reaches: Reach[]; cables: Cable[] };
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
  return join(project.root, '.field', 'cache');
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

function actionKey(node: GeneratorNode, inputHashes: string[]): string {
  // The serialized field stays spelled `rule` deliberately: it is pure
  // cache machinery, and renaming a hash key would invalidate every
  // cached action for zero semantic gain (project-layout.md §4 keeps
  // engine words in the engine). `sample_rate` was `project_sample_rate`
  // until multi-rate.md step 3 made the rate a property of the node —
  // that rename bought semantic truth at the priced-in cost of one full
  // re-render (multi-rate.md §3), the same deliberate trade §4.4's
  // sc-render → supercollider value change made.
  return sha256Text(
    canonicalJson({
      rule: node.spec.type,
      rule_version: generatorFor(node.spec).version,
      inputs: inputHashes,
      parameters: ruleParameters(node),
      sample_rate: node.sampleRate,
    }),
  );
}

// The committed file a source node names — an asset's path is relative to
// its scope, a generation label's to its song. Three call sites need it
// (the outcome, the tamper guard, the runner's inputs), so it lives in one
// place: the two spellings were drifting apart by construction (#35 review).
function sourceFilePath(project: LoadedProject, node: GraphNode): string {
  if (node.kind === 'asset') return join(project.root, node.scopeDir, node.asset.file);
  if (node.kind === 'generation') return join(project.root, node.songDir, node.file);
  throw new Error(`not a committed source node: ${formatLabel(node.label)}`);
}

// Materialized outputs land under .field/out mirroring the label path, so
// humans can play what they built without digging in the CAS.
function outPath(project: LoadedProject, node: GeneratorNode): string {
  return join(project.root, '.field', 'out', node.label.pkg, `${node.label.name}.wav`);
}

// Temporary paths carry a process-unique suffix: two builds can run in
// one process — the watch loop's recompile beside its background stem
// build — and identical actions sharing a literal `<key>.out` (or two
// materializations sharing `.tmp-<pid>`) would race their renames.
// Duplicate concurrent work is merely wasteful; the CAS write and
// rename are idempotent for identical content.
let nextTmp = 0;

// The read-through (remote.md §3.4): on a local miss, ask the remote for
// the action key, and on a hit bring its outputs into the CAS and the
// entry into the index so that everything below here — materialize,
// the next build, `explain` — sees an ordinary local hit. Every output
// is hashed on the way down and compared against the entry before it
// lands at casPath(): CAS reads are never verified (readAction checks
// existence and nothing else), which is fine for bytes this machine
// hashed on the way in and wrong for bytes that arrived over a network.
// A disagreeing download is discarded and the whole entry treated as a
// miss, so a wrong remote can cost a render but never poison the cache.
//
// Failure policy lives in RemoteReads, not here: it answers a miss for
// an unreachable or refused remote after saying so once, and `download`
// answers undefined the same way, so this function only knows about
// bytes and hashes.
async function fetchAction(
  project: LoadedProject,
  key: string,
  remote: RemoteReads,
): Promise<ActionEntry | undefined> {
  const entry = await remote.lookup(key);
  if (entry === undefined) return undefined;
  const tmpDir = join(cacheDir(project), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(cacheDir(project), 'cas'), { recursive: true });
  let downloaded = 0;
  for (const output of entry.outputs) {
    const target = casPath(project, output.sha256);
    // Bytes this machine already holds under that hash were hashed on
    // the way in (or arrived for another entry a moment ago — a stem
    // and a mix of one silent input are the same bytes); only the
    // entry is new.
    if (existsSync(target)) continue;
    const tmp = join(tmpDir, `${output.sha256}.fetch-${process.pid}-${nextTmp++}`);
    const got = await remote.download(output.url, tmp);
    if (got === undefined || got.sha256 !== output.sha256 || got.bytes !== output.bytes) {
      rmSync(tmp, { force: true });
      if (got !== undefined) remote.mismatch(key, output.sha256);
      return undefined;
    }
    renameSync(tmp, target);
    downloaded += got.bytes;
  }
  // One entry brought in, however many of its bytes were new.
  remote.record(downloaded);
  // The entry mirrors ActionEntry exactly, minus the download URLs,
  // which are presigned and expire; the index never stores them.
  const local: ActionEntry = {
    rule: entry.rule,
    outputs: entry.outputs.map(({ sha256, bytes }) => ({ sha256, bytes })),
  };
  writeAction(project, key, local);
  return local;
}

async function buildNode(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
  runner: GeneratorRunner,
  built: Map<string, BuildOutcome>,
  signal?: AbortSignal,
  remote?: RemoteReads,
): Promise<BuildOutcome> {
  if (node.kind === 'asset') {
    // Source targets: the declared hash is the identity; check verifies
    // content, the build system trusts the declaration.
    return {
      label: formatLabel(node.label),
      cached: true,
      sha256: node.asset.sha256,
      outputPath: sourceFilePath(project, node),
      committed: true,
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
      outputPath: sourceFilePath(project, node),
      committed: true,
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
  const key = actionKey(node, inputHashes);

  const materialize = (sha256: string): string => {
    const out = outPath(project, node);
    mkdirSync(dirname(out), { recursive: true });
    // Copy-to-temp + rename, never copy-in-place: under watch the daemon
    // may be streaming the previous artifact from this very path, and an
    // in-place copy truncates under its reader. A fresh inode leaves the
    // playing pass untouched until the swap (watch.md §1.6).
    const tmp = `${out}.tmp-${process.pid}-${nextTmp++}`;
    copyFileSync(casPath(project, sha256), tmp);
    renameSync(tmp, out);
    return out;
  };

  const cached = readAction(project, key);
  if (cached) {
    const sha256 = cached.outputs[0]!.sha256;
    return { label: formatLabel(node.label), cached: true, outputPath: materialize(sha256), sha256 };
  }
  // A local miss asks the remote before running the rule (remote.md
  // §3.4). Reads only: a build never uploads.
  if (remote !== undefined) {
    const fetched = await fetchAction(project, key, remote);
    if (fetched) {
      const sha256 = fetched.outputs[0]!.sha256;
      return {
        label: formatLabel(node.label),
        cached: true,
        fetched: true,
        outputPath: materialize(sha256),
        sha256,
      };
    }
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
      const path = sourceFilePath(project, input);
      const size = statSync(path).size;
      if (size !== input.asset.bytes) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} is ${size} bytes on disk but ` +
            `${input.asset.bytes} declared (field check, then re-import or restore the file)`,
        );
      }
      const actual = await sha256File(path);
      if (actual !== input.asset.sha256) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} content does not match its ` +
            `declared sha256 (field check, then re-import or restore the file)`,
        );
      }
    } else if (input.kind === 'generation') {
      // Committed variants are human-visible files too; same tamper guard.
      const actual = await sha256File(sourceFilePath(project, input));
      if (actual !== input.sha256) {
        throw new Error(
          `refusing to build: input ${formatLabel(input.label)} content does not match its ` +
            `recorded sha256 (field check)`,
        );
      }
    }
  }

  const inputPaths = inputNodes.map((d) =>
    d.kind === 'rule' ? built.get(formatLabel(d.label))!.outputPath! : sourceFilePath(project, d),
  );
  const tmpDir = join(cacheDir(project), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpOut = join(tmpDir, `${key}.out-${process.pid}-${nextTmp++}`);
  await runner(node, inputPaths, tmpOut, {
    root: project.root,
    sampleRate: node.sampleRate,
    ...(signal !== undefined ? { signal } : {}),
  });
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
// `remote` is injected where the runner is (remote.md §5 decision 11),
// and defaults to none: the engine never reads Git or the environment to
// find one, so a build test is a build test. The command layer resolves
// the project's remote (commands/build.ts `remoteReads`) and passes it.
export async function build(
  project: LoadedProject,
  graph: Graph,
  nodes: GraphNode[],
  runner: GeneratorRunner = defaultRunner,
  signal?: AbortSignal,
  remote?: RemoteReads,
): Promise<BuildOutcome[]> {
  // Across every requested target at once, before any per-target walk:
  // a queue where each target hides its own takeless request must
  // report one list, not throw per target (Codex on #119).
  assertGenerated(graph, nodes);
  const outcomes: BuildOutcome[] = [];
  const built = new Map<string, BuildOutcome>();
  for (const start of nodes) {
    for (const node of deps(graph, start)) {
      if (signal?.aborted) throw new Error('build aborted');
      const label = formatLabel(node.label);
      if (built.has(label)) continue;
      const outcome = await buildNode(project, graph, node, runner, built, signal, remote);
      built.set(label, outcome);
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

// With a `remote`, a local miss reads through exactly as build does
// (remote.md §2: otherwise `field explain` says "not cached" for a label
// `field build` would fetch) — and since the recursion asks every rule
// node beneath the one explained, explaining a song's `main` with a
// remote is what warms a fresh clone (commands/clone.ts).
export async function explain(
  project: LoadedProject,
  graph: Graph,
  node: GraphNode,
  memo: Map<string, Explanation> = new Map(),
  remote?: RemoteReads,
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
      file: node.file,
      ...(node.choice !== undefined ? { choice: node.choice } : {}),
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
    const dep = await explain(project, graph, resolveLabel(graph, depLabel), memo, remote);
    const sha256 = dep.cached !== false && dep.outputs ? dep.outputs[0]!.sha256 : '';
    if (sha256 === '') unknown = true;
    inputs.push({ label: dep.label, sha256 });
  }
  if (impl.extraInputs) {
    inputs.push(...(await impl.extraInputs(project.root, node.spec)));
  }
  const key = unknown ? undefined : actionKey(node, inputs.map((i) => i.sha256));
  let cached = key === undefined ? undefined : readAction(project, key);
  let fetched = false;
  if (cached === undefined && key !== undefined && remote !== undefined) {
    cached = await fetchAction(project, key, remote);
    fetched = cached !== undefined;
  }
  // A stem is the one spec synthesized from a track file, so it is also
  // the one whose level question has an answer (nested-tracks.md §5).
  const song = project.songs.find((s) => s.dir === node.songDir);
  // The label's package, not the spec type: a `tap:` node is planned as
  // a stem too, but the level question belongs to the track — a tap
  // travels nowhere but its cable, and answering with the sender's
  // placement path would be confidently wrong for a node whose whole
  // point is being a different signal (minjudd on #126).
  const levels =
    node.spec.type === 'stem' && song && node.label.pkg === `${node.songDir}/track`
      ? {
          track: node.label.name,
          reaches: reaches(song, node.label.name),
          cables: song.cables.filter(
            (c) => c.sender === node.label.name || c.receiver === node.label.name,
          ),
        }
      : undefined;
  const explanation: Explanation = {
    label,
    kind: 'rule',
    rule: node.spec.type,
    ruleVersion: impl.version,
    inputs,
    parameters: ruleParameters(node),
    ...(key !== undefined ? { actionKey: key } : {}),
    cached: cached !== undefined,
    ...(fetched ? { fetched: true } : {}),
    ...(cached ? { outputs: cached.outputs } : {}),
    ...(levels ? { levels } : {}),
  };
  memo.set(label, explanation);
  return explanation;
}
