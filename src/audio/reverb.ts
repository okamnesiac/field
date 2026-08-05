// Freeverb (Schroeder–Moorer) — the canonical "basic reverb"
// (effects.md §2): eight parallel feedback combs with damping in the
// loop, four series allpasses, the right channel's delays spread by a
// fixed offset for width. Deterministic, no randomness anywhere. Comb
// feedback derives from the requested decay (T60) per comb length, so
// `decay` means seconds-to-−60 dB rather than an abstract room knob.

export interface ReverbSettings {
  mix: number; // 0 dry … 1 wet
  decaySeconds: number; // T60
  predelayMs: number;
  damping: number; // 0 bright … 1 dark
  sampleRate: number;
}

// Freeverb's tunings are samples at 44.1 kHz; scale to the actual rate.
const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNINGS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const REFERENCE_RATE = 44100;

function scaled(tuning: number, sampleRate: number, spread: number): number {
  return Math.max(1, Math.round(((tuning + spread) * sampleRate) / REFERENCE_RATE));
}

// Output is input length + predelay + tail (to −60 dB, i.e. the T60).
export function reverb(channels: Float32Array[], settings: ReverbSettings): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const predelay = Math.round((settings.predelayMs / 1000) * settings.sampleRate);
  const tail = Math.round(settings.decaySeconds * settings.sampleRate);
  const total = frames + predelay + tail;

  return channels.map((dry, channelIndex) => {
    const spread = channelIndex === 0 ? 0 : STEREO_SPREAD;

    const combs = COMB_TUNINGS.map((tuning) => {
      const length = scaled(tuning, settings.sampleRate, spread);
      return {
        buffer: new Float64Array(length),
        at: 0,
        // T60: feedback^(T60·rate/length) = 10^(−3) → per-pass feedback.
        feedback: Math.pow(10, (-3 * length) / (settings.decaySeconds * settings.sampleRate)),
        filtered: 0, // one-pole damping state inside the loop
      };
    });
    const allpasses = ALLPASS_TUNINGS.map((tuning) => ({
      buffer: new Float64Array(scaled(tuning, settings.sampleRate, spread)),
      at: 0,
    }));

    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const input = i >= predelay && i - predelay < frames ? dry[i - predelay]! : 0;

      let wet = 0;
      for (const comb of combs) {
        const read = comb.buffer[comb.at]!;
        wet += read;
        comb.filtered = read * (1 - settings.damping) + comb.filtered * settings.damping;
        comb.buffer[comb.at] = input + comb.filtered * comb.feedback;
        comb.at = (comb.at + 1) % comb.buffer.length;
      }
      wet /= combs.length;

      for (const allpass of allpasses) {
        const read = allpass.buffer[allpass.at]!;
        const fed = wet + read * 0.5;
        allpass.buffer[allpass.at] = fed;
        wet = read - fed * 0.5;
        allpass.at = (allpass.at + 1) % allpass.buffer.length;
      }

      const dryHere = i < frames ? dry[i]! : 0;
      out[i] = dryHere * (1 - settings.mix) + wet * settings.mix;
    }
    return out;
  });
}
