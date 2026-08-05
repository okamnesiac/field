import { readWav, writeWavFloat32, type WavData } from '../audio/wav.js';
import type { ValidateContext } from './types.js';

// Shared plumbing for rules that transform exactly one audio input,
// sourced as one of `asset:` or `target:` (effects.md §3) — the clip
// pattern, enforced here because discriminated-union members cannot carry
// schema refines.

export interface SingleInputSpec {
  name: string;
  asset?: string | undefined;
  target?: string | undefined;
}

export function singleInputAssetDeps(spec: SingleInputSpec): string[] {
  return spec.asset !== undefined ? [spec.asset] : [];
}

export function singleInputTargetDeps(spec: SingleInputSpec): string[] {
  return spec.target !== undefined ? [spec.target] : [];
}

export function validateSingleInput(spec: SingleInputSpec, ctx: ValidateContext): void {
  if ((spec.asset === undefined) === (spec.target === undefined)) {
    ctx.push('sources exactly one of asset or target');
    return;
  }
  if (spec.asset !== undefined && !ctx.assetNames.has(spec.asset)) {
    ctx.push(`references unknown asset "${spec.asset}"`);
  }
  if (spec.target !== undefined && !ctx.targetNames.has(spec.target)) {
    ctx.push(`references unknown target "${spec.target}"`);
  }
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
