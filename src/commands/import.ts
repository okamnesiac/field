import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseDocument, Document, isSeq } from 'yaml';
import { hasWavSignature, readWavHeader, type WavHeader } from '../audio/wav.js';
import { PROJECT_MANIFEST, DEFAULT_SAMPLE_RATE } from '../constants.js';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { RESERVED_LABEL_NAME } from '../labels.js';
import { assetsFileOrder, assetsFileSchema, projectSchema } from '../schema/index.js';
import { takenSongNames } from '../model/namespace.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

export interface ImportOptions {
  // A rate that differs from the project's is a conversion cost, not an
  // error (multi-rate.md decision 5) — but it must be acknowledged:
  // `--allow-mismatch` in scripts, or an interactive yes through
  // `confirmMismatch`. With neither, a mismatch refuses.
  allowMismatch?: boolean | undefined;
  confirmMismatch?: ((message: string) => Promise<boolean>) | undefined;
}

export interface ImportResult {
  name: string;
  file: string; // song-relative path of the copied asset
  sha256: string;
  bytes: number;
  header?: WavHeader | undefined; // recorded facts, when the source is a readable WAV
  headerProblem?: string | undefined; // a .wav whose header would not parse
}

function defaultName(file: string): string {
  return basename(file, extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Copy a file into the song's audio/ directory and record it in
// assets.yaml: name → file + sha256 (= Git LFS OID) + size. The assets file
// is edited as a document so existing comments survive.
export async function importAsset(
  root: string,
  song: string,
  sourcePath: string,
  name?: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const songDir = join(root, 'songs', song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${song}" does not exist`);
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`no such file: ${sourcePath}`);
  }

  // The first content validation import has ever had (multi-rate.md
  // decision 5): read the WAV header before any write, record the facts,
  // and make a rate mismatch acknowledged rather than fatal — it fires
  // at the moment the mistake is cheap to fix, not at first build. A
  // .wav whose header will not parse records nothing; the problem is
  // reported for the caller to surface, because import has always been
  // willing to carry bytes it does not understand.
  let header: WavHeader | undefined;
  let headerProblem: string | undefined;
  // Content decides, not the filename: a WAV named .wave (or nothing)
  // must not bypass the acknowledgement by spelling alone, so the
  // signature is probed wherever the extension does not already claim it.
  if (extname(sourcePath).toLowerCase() === '.wav' || hasWavSignature(sourcePath)) {
    try {
      header = readWavHeader(sourcePath);
    } catch (err) {
      headerProblem = (err as Error).message;
    }
    // A structurally parseable header can still declare the impossible —
    // readWavHeader trusts fmt's sample rate, and 0 would sail through
    // the mismatch prompt into a ledger row the schema refuses. Facts
    // that cannot be true are a header problem, recorded as nothing.
    if (header !== undefined && header.sampleRate <= 0) {
      headerProblem = `header declares a sample rate of ${header.sampleRate} — nothing recorded`;
      header = undefined;
    }
    if (header !== undefined) {
      const manifest = projectSchema.safeParse(
        parseDocument(readFileSync(join(root, PROJECT_MANIFEST), 'utf8')).toJS(),
      );
      const projectRate = manifest.success ? manifest.data.sample_rate : DEFAULT_SAMPLE_RATE;
      if (header.sampleRate !== projectRate && options.allowMismatch !== true) {
        const message =
          `${basename(sourcePath)} is ${header.sampleRate} Hz against the project's ` +
          `${projectRate} — placements will pay a conversion (multi-rate.md §2.4)`;
        const acknowledged =
          options.confirmMismatch !== undefined && (await options.confirmMismatch(message));
        if (!acknowledged) {
          throw new Error(`${message}; import it anyway with --allow-mismatch`);
        }
      }
    }
  }

  const assetName = name ?? defaultName(sourcePath);
  if (!isSlug(assetName)) {
    throw new Error(`asset name "${assetName}" must be a lowercase-slug (use --name)`);
  }
  if (assetName === RESERVED_LABEL_NAME) {
    throw new Error(`"${RESERVED_LABEL_NAME}" is reserved by the label grammar (use --name)`);
  }

  const ext = extname(sourcePath).toLowerCase();
  // Forward slashes always: the manifest format is platform-neutral.
  //
  // Every audio item is a directory (project-layout.md §4.11): the
  // original goes in as audio/<name>/<name>.<ext>, one shape for both
  // halves of audio/ — generative items have lived this way since the
  // takes moved in beside their WAVs. Consumers resolve through the
  // manifest's `file`, so a ledger written before this rule keeps
  // working as declared.
  const file = `audio/${assetName}/${assetName}${ext}`;
  const destPath = join(songDir, 'audio', assetName, `${assetName}${ext}`);

  const assetsPath = join(songDir, 'assets.yaml');
  let doc: Document;
  if (existsSync(assetsPath)) {
    const parsed = parseDocument(readFileSync(assetsPath, 'utf8'));
    if (parsed.errors.length > 0) {
      throw new Error(`invalid YAML in assets.yaml: ${parsed.errors[0]!.message}`);
    }
    doc = parsed;
  } else {
    doc = new Document({ assets: [] });
  }
  const existing = assetsFileSchema.safeParse(doc.toJS());
  if (!existing.success) {
    throw new Error(`assets.yaml is invalid; fix it before importing (field check)`);
  }
  // The declaration in assets.yaml is the existence marker, and it is
  // written last. A file is an orphan of a failed import only if no
  // declared entry references it — then re-running overwrites it rather
  // than wedging. Both the name and the destination file must be free:
  // a declared entry may reference the same file under a different name.
  if (existing.data.assets.some((a) => a.name === assetName)) {
    throw new Error(`asset "${assetName}" already declared in "${song}"`);
  }
  // One namespace per song (project-layout.md §4.3): an imported asset
  // may not shadow a generator's node name — its takes claim the same
  // audio/<name>/ directory the import would land in, and the collision
  // would only surface as a check-red project after the copy.
  if (takenSongNames(songDir).has(assetName)) {
    throw new Error(
      `"${assetName}" is already a generator's name in ` +
        `"${song}" — a song's names are one namespace (use --name)`,
    );
  }
  // Compare by resolved path, not string equality: check accepts any
  // relative spelling that resolves inside the project ("./audio/x.wav"),
  // so the guard must match by the same rules.
  if (existing.data.assets.some((a) => resolve(songDir, a.file) === destPath)) {
    throw new Error(`${file} already belongs to a declared asset in "${song}"`);
  }

  mkdirSync(join(songDir, 'audio', assetName), { recursive: true });
  copyFileSync(sourcePath, destPath);
  const sha256 = await sha256File(destPath);
  const bytes = statSync(destPath).size;

  if (!isSeq(doc.getIn(['assets']))) {
    // `{}` or `assets:` (null) parse fine but have no sequence for addIn
    // to extend; without this it would set a bare map and corrupt the file.
    doc.setIn(['assets'], doc.createNode([]));
  }
  doc.addIn(
    ['assets'],
    doc.createNode({
      name: assetName,
      file,
      sha256,
      bytes,
      ...(header !== undefined
        ? {
            sample_rate: header.sampleRate,
            bit_depth: header.bitsPerSample,
            channels: header.channels,
            frames: header.frames,
          }
        : {}),
    }),
  );
  canonicalizeDocument(doc, assetsFileOrder);
  writeFileSync(assetsPath, stringifyDocument(doc));

  return { name: assetName, file, sha256, bytes, header, headerProblem };
}
