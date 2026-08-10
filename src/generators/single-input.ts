// Shared plumbing for rules that transform exactly one audio input,
// named by `source:` — since `sounds/` retired (nested-tracks.md §18,
// decision 12) that is the resample edge alone, whose ref is whatever
// spelling the consuming entry carried. The namespace checker and the
// float pass-through helper that lived here left with the declared
// effect sounds; effects process as inserts inside the stem chain now.

export interface SingleInputSpec {
  name: string;
  source: string;
}

export function singleInputSources(spec: SingleInputSpec): string[] {
  return [spec.source];
}
