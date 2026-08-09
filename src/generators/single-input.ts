import { sharedAssetName } from '../labels.js';
import { readWav, writeWavFloat32, type WavData } from '../audio/wav.js';
import type { ValidateContext } from './types.js';

// Shared plumbing for rules that transform exactly one audio input,
// named by `source:` (project-layout.md §4.3) — an asset or sound in
// the song's unified namespace, or a shared pin.

export interface SingleInputSpec {
  name: string;
  source: string;
}

export function singleInputSources(spec: SingleInputSpec): string[] {
  return [spec.source];
}

// Resolve a source ref against the song's visible names; the messages
// are shared by clips (model/project.ts) so the two sites cannot drift.
export function checkSource(ref: string, what: string, ctx: ValidateContext): void {
  const shared = sharedAssetName(ref);
  if (shared !== undefined) {
    if (!ctx.names.shared.has(shared)) {
      ctx.push(`${what} references unknown shared asset "${shared}"`);
    }
    return;
  }
  if (ctx.names.unchosen.has(ref)) {
    ctx.push(
      `${what} sources "${ref}", which has no chosen variant yet — ` +
        `field choose ${ref} first`,
    );
    return;
  }
  // A takeless recipe resolves as far as `check` is concerned: the
  // reference is to a name that exists and the project is coherent, the
  // audio is just absent. `build` and `play` are what refuse it, because
  // that is the question they ask (bloom-in-tree.md §3).
  if (
    !ctx.names.assets.has(ref) &&
    !ctx.names.sounds.has(ref) &&
    !ctx.names.chosen.has(ref) &&
    !ctx.names.ungenerated.has(ref)
  ) {
    ctx.push(`${what} references unknown source "${ref}"`);
  }
}

export function validateSingleInput(spec: SingleInputSpec, ctx: ValidateContext): void {
  checkSource(spec.source, 'source', ctx);
}

// Effects process at the file's own rate — they are rate-agnostic DSP;
// normalize is the rate converter, and stems are where the project rate
// gets enforced. Channel count passes through.
export function transformAudio(
  inputPath: string,
  outputPath: string,
  transform: (wav: WavData) => Float32Array[],
): void {
  const wav = readWav(inputPath);
  writeWavFloat32(outputPath, wav.sampleRate, transform(wav));
}
