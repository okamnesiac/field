import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { beatTicks } from '../time/tempo.js';
import type { LoadedProject } from '../model/project.js';
import { musicalContext, songDirOfPkg, type MusicalContext } from './transport.js';
import type { Playable } from './play.js';

// --click: a metronome over whatever is auditioning. The click renders
// CLI-side into a temp copy of the artifact — the daemon stays
// artifacts-only (playback.md §1), and the click loops with the file.
// Each beat projects through the tempo map individually, so ramps click
// at the ramped tempo and odd meters accent their own downbeats.

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

const CLICK_SECONDS = 0.015;
const CLICK_DECAY_SECONDS = 0.004;
const CLICK_GAIN = 0.4;
const ACCENT_HZ = 1568; // G6 on the downbeat
const BEAT_HZ = 1046.5; // C6 elsewhere

export function withClick(root: string, ctx: MusicalContext, item: Playable): Playable {
  const wav = readWav(item.path);
  const frames = wav.channels[0]!.length;
  const left = Float32Array.from(wav.channels[0]!);
  const right = Float32Array.from(wav.channels[1] ?? wav.channels[0]!);
  for (const { sample, accent } of beatGrid(ctx, frames, wav.sampleRate)) {
    const hz = accent ? ACCENT_HZ : BEAT_HZ;
    const n = Math.min(Math.round(wav.sampleRate * CLICK_SECONDS), frames - sample);
    for (let i = 0; i < n; i++) {
      const blip =
        Math.sin((2 * Math.PI * hz * i) / wav.sampleRate) *
        Math.exp(-i / (wav.sampleRate * CLICK_DECAY_SECONDS)) *
        CLICK_GAIN;
      left[sample + i] = left[sample + i]! + blip;
      right[sample + i] = right[sample + i]! + blip;
    }
  }
  const dir = join(root, '.bloom', 'tmp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `click-${item.label.replace(/[^a-z0-9]+/g, '-')}.wav`);
  writeWavFloat32(path, wav.sampleRate, [left, right]);
  return { ...item, path };
}

// Every playable gets its own song's grid; a playable outside any song
// (no tempo map) is a clear error rather than a silent no-click.
export function applyClick(root: string, project: LoadedProject, items: Playable[]): Playable[] {
  return items.map((item) => {
    const ctx = musicalContext(project, songDirOfPkg(item.pkg));
    if (!ctx) throw new Error(`--click needs a song's tempo map; ${item.label} has none`);
    return withClick(root, ctx, item);
  });
}
