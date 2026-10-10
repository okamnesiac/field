import type { ClickSchedule } from '../audiod/protocol.js';
import { beatTicks } from '../time/tempo.js';
import type { MusicalContext } from './transport.js';

// --click, and the count-in (recording.md §7): the metronome is a
// *schedule* — sample positions with accent flags on the bed's timeline —
// that the CLI projects from the tempo map and hands over the socket. The
// daemon synthesizes the ticks in its callback against the same clock the
// capture uses, and still never learns what a bar is (playback.md §3.6).
// This replaced a CLI-side DSP that baked ticks into a temp copy of the
// artifact, which is why --click used to refuse --watch and live songs:
// there was a file to swap out from under it. Each beat projects through
// the tempo map individually, so ramps click at the ramped tempo and odd
// meters accent their own downbeats.

export function beatGrid(
  ctx: MusicalContext,
  frames: number,
  sampleRate: number,
): { sample: number; accent: boolean }[] {
  const out: { sample: number; accent: boolean }[] = [];
  for (let i = 0; i < ctx.meter.events.length; i++) {
    const ev = ctx.meter.events[i]!;
    const end = ctx.meter.events[i + 1]?.at ?? Infinity;
    const step = beatTicks(ev.denominator);
    let beatInBar = 0;
    for (let t = ev.at; t < end; t += step) {
      const sample = Math.round((ctx.tempo.ticksToSamples(t) / ctx.tempo.sampleRate) * sampleRate);
      if (sample >= frames) return out;
      out.push({ sample, accent: beatInBar === 0 });
      beatInBar = (beatInBar + 1) % ev.numerator;
    }
  }
  return out;
}

// The schedule for a bed: every beat from the top to `frames`, at the
// rate the bed's positions count in. A bed with no known extent gets ten
// minutes of ticks; the transport stops where the content does, and a
// tick past that is one nobody hears.
export const CLICK_FALLBACK_SECONDS = 600;

export function clickSchedule(ctx: MusicalContext, frames: number, sampleRate: number): ClickSchedule {
  const extent = frames > 0 ? frames : CLICK_FALLBACK_SECONDS * sampleRate;
  return { rate: sampleRate, ticks: beatGrid(ctx, extent, sampleRate) };
}

// The count-in's schedule: the beats from `from` up to but not including
// `to` (samples on the bed's timeline). A performer counting in hears the
// bars before the take and nothing after it.
export function countInSchedule(
  ctx: MusicalContext,
  from: number,
  to: number,
  sampleRate: number,
): ClickSchedule {
  return {
    rate: sampleRate,
    ticks: beatGrid(ctx, to, sampleRate).filter((tick) => tick.sample >= from),
  };
}

// Where a count-in of `bars` bars before the position at `ticks` begins,
// in ticks: the same beat and tick, `bars` bars earlier, clamped to the
// first bar. Whole bars, because that is what a musician counts.
export function countInStart(ctx: MusicalContext, ticks: number, bars: number): number {
  const [bar, beat, tick] = ctx.meter.format(ticks).split('.').map(Number) as [number, number, number];
  return ctx.meter.positionTicks(Math.max(1, bar - bars), beat, tick);
}
