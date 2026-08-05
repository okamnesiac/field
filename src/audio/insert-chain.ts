import type { Insert } from '../schema/schemas.js';
import { autoGainDB, design, processBiquad } from './biquad.js';
import { limit } from './limiter.js';
import { reverb } from './reverb.js';

// One insert chain, three homes (effects.md §5): standalone effect
// targets, track inserts (post-clip-sum), and the mix master chain
// (post-sum, post-master-gain). Same parameters, same DSP, in series.
// Reverb returns longer arrays (its tail); eq and limit work in place.
export function applyInsertChain(
  channels: Float32Array[],
  inserts: readonly Insert[],
  sampleRate: number,
): Float32Array[] {
  let current = channels;
  for (const insert of inserts) {
    switch (insert.effect) {
      case 'eq': {
        for (const band of insert.bands) {
          const biquad = design(band, sampleRate);
          for (const channel of current) processBiquad(channel, biquad);
        }
        if (insert.normalize) {
          const gain = Math.pow(10, autoGainDB(insert.bands, sampleRate) / 20);
          for (const channel of current) {
            for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;
          }
        }
        break;
      }
      case 'limit':
        limit(current, {
          ceilingDb: insert.ceiling_db,
          lookaheadMs: insert.lookahead_ms,
          releaseMs: insert.release_ms,
          sampleRate,
        });
        break;
      case 'reverb':
        current = reverb(current, {
          mix: insert.mix,
          decaySeconds: insert.decay,
          predelayMs: insert.predelay_ms,
          damping: insert.damping,
          sampleRate,
        });
        break;
    }
  }
  return current;
}
