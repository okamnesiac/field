import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseDocument, Document } from 'yaml';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { assetsFileOrder, assetsFileSchema } from '../schema/schemas.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

export interface ImportResult {
  name: string;
  file: string; // song-relative path of the copied asset
  sha256: string;
  bytes: number;
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
): Promise<ImportResult> {
  const songDir = join(root, 'songs', song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${song}" does not exist`);
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`no such file: ${sourcePath}`);
  }

  const assetName = name ?? defaultName(sourcePath);
  if (!isSlug(assetName)) {
    throw new Error(`asset name "${assetName}" must be a lowercase-slug (use --name)`);
  }

  const ext = extname(sourcePath).toLowerCase();
  const file = join('audio', `${assetName}${ext}`);
  const destPath = join(songDir, file);
  if (existsSync(destPath)) {
    throw new Error(`${file} already exists in "${song}"`);
  }

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
    throw new Error(`assets.yaml is invalid; fix it before importing (bloom check)`);
  }
  if (existing.data.assets.some((a) => a.name === assetName)) {
    throw new Error(`asset "${assetName}" already declared in "${song}"`);
  }

  mkdirSync(join(songDir, 'audio'), { recursive: true });
  copyFileSync(sourcePath, destPath);
  const sha256 = await sha256File(destPath);
  const bytes = statSync(destPath).size;

  doc.addIn(['assets'], doc.createNode({ name: assetName, file, sha256, bytes }));
  canonicalizeDocument(doc, assetsFileOrder);
  writeFileSync(assetsPath, stringifyDocument(doc));

  return { name: assetName, file, sha256, bytes };
}
