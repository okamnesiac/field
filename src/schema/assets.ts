import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName } from './common.js';

// The per-scope asset ledger — songs/<song>/assets.yaml, and
// shared/assets.yaml with the identical shape (project-layout.md §1.6:
// one ledger per scope, `file:` relative to the scope root). It binds a
// readable asset name to its file and content hash. Clips and takes
// reference assets by name (readable diffs, project-core.md §6); the
// sha256 is the content identity and equals the Git LFS OID (§3.5).
export const assetSchema = z
  .strictObject({
    name: labelName,
    file: z.string().min(1), // path relative to the scope root
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
    bytes: z.number().int().min(0),
    // What the WAV header said at import (multi-rate.md decision 5) —
    // stored derived values in project-core.md §3.1's sense: recorded
    // once, verifiable against the file check already hashes. Optional
    // because ledgers predate the fields and non-WAV assets never get
    // them; the refine below is what makes "recorded together or not at
    // all" true rather than merely written down — the verification gate
    // keys on `sample_rate`, so a partial row would otherwise dodge
    // checking entirely (the voice_ref/voice_ref_sha256 precedent, one
    // file over).
    sample_rate: z.number().int().positive().optional(),
    bit_depth: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
    frames: z.number().int().min(0).optional(),
  })
  .refine(
    (asset) => {
      const present = [asset.sample_rate, asset.bit_depth, asset.channels, asset.frames].filter(
        (f) => f !== undefined,
      ).length;
      return present === 0 || present === 4;
    },
    {
      error:
        'WAV facts travel together — record sample_rate, bit_depth, channels, ' +
        'and frames, or none (multi-rate.md decision 5)',
    },
  );
export type Asset = z.infer<typeof assetSchema>;

export const assetsFileSchema = z.strictObject({
  assets: z.array(assetSchema).default([]),
});
export type AssetsFile = z.infer<typeof assetsFileSchema>;
export const assetsFileOrder: KeyOrder = {
  keys: ['assets'],
  children: {
    assets: {
      items: {
        keys: ['name', 'file', 'sha256', 'bytes', 'sample_rate', 'bit_depth', 'channels', 'frames'],
      },
    },
  },
};
