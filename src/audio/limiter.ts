// Offline lookahead peak limiter (effects.md §2). Offline affords the
// artifact-free construction real-time limiters approximate: compute the
// per-sample gain that would pin every peak to the ceiling, then slew it
// dB-linearly — a backward pass so gain is already down when a peak
// arrives (the "lookahead" is the attack ramp length), and a forward pass
// so recovery follows the release time. Slewing only ever lowers gain
// below the naive curve, so the ceiling is a hard guarantee, and dB-linear
// ramps are click-free by construction.

export interface LimiterSettings {
  ceilingDb: number;
  lookaheadMs: number; // attack ramp length
  releaseMs: number;
  sampleRate: number;
}

// Shared gain curve across channels (stereo-linked: limiting must not
// wander the image), applied in place.
export function limit(channels: Float32Array[], settings: LimiterSettings): void {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return;
  const ceiling = Math.pow(10, settings.ceilingDb / 20);

  const gainDb = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let peak = 0;
    for (const channel of channels) {
      const v = Math.abs(channel[i]!);
      if (v > peak) peak = v;
    }
    gainDb[i] = peak > ceiling ? 20 * Math.log10(ceiling / peak) : 0;
  }

  // dB per sample the envelope may rise while approaching a reduction
  // (attack, backward) or while recovering from one (release, forward).
  // The scale (full-scale-to-floor over the window) makes the deepest
  // plausible reduction span exactly the configured time.
  const attackSlope = 60 / Math.max(1, (settings.lookaheadMs / 1000) * settings.sampleRate);
  const releaseSlope = 60 / Math.max(1, (settings.releaseMs / 1000) * settings.sampleRate);
  // The constraint is "gain may not rise faster than the slope": each
  // sample is capped at its neighbor-toward-the-reduction plus the slope,
  // which leaves untouched audio at exactly 0 dB.
  for (let i = frames - 2; i >= 0; i--) {
    const ramp = gainDb[i + 1]! + attackSlope;
    if (ramp < gainDb[i]!) gainDb[i] = ramp;
  }
  for (let i = 1; i < frames; i++) {
    const ramp = gainDb[i - 1]! + releaseSlope;
    if (ramp < gainDb[i]!) gainDb[i] = ramp;
  }

  for (const channel of channels) {
    for (let i = 0; i < frames; i++) {
      channel[i] = channel[i]! * Math.pow(10, gainDb[i]! / 20);
    }
  }
}
