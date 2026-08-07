import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { beatScheduler } from './play.js';

// The readout is scheduled ahead of the audio: heartbeat positions are
// anchors, and each beat's print fires on a timer at the moment that beat
// sounds. So the question these tests ask is what the scheduler declines
// to schedule — invisible to a daemon-driven test, which can only wait
// and hope, and the reason a phantom beat was filed as a flake before it
// was understood (#37 review).

const SR = 48000;
// 120 bpm, 4/4: one beat is 0.5 s — 24000 samples.
const ctx = () => ({
  tempo: new TempoMap([{ at: 0, bpm: 120 }], SR),
  meter: new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]),
});

describe('beatScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never announces a beat the file does not reach', () => {
    const lines: string[] = [];
    // A 0.2 s file: beat 2 lands at 0.5 s, well past the end.
    const readout = beatScheduler(SR, ctx(), (line) => lines.push(line), 9600);

    readout.onSample(0);
    vi.advanceTimersByTime(5000); // ten times the beat interval

    expect(lines).toEqual(['1.1']);
    readout.cancel();
  });

  it('without a bound, that beat is exactly what fires', () => {
    // The behaviour before the bound, kept as the contrast: the print for
    // beat 2 is scheduled and, once no fresh anchor clears its timer,
    // announces a beat that never sounded.
    const lines: string[] = [];
    const readout = beatScheduler(SR, ctx(), (line) => lines.push(line));

    readout.onSample(0);
    vi.advanceTimersByTime(5000);

    expect(lines).toContain('1.2');
    readout.cancel();
  });

  it('still announces beats inside the file', () => {
    const lines: string[] = [];
    const readout = beatScheduler(SR, ctx(), (line) => lines.push(line), SR * 2); // 2 s

    readout.onSample(0);
    vi.advanceTimersByTime(1600); // past beats 2, 3 and 4 (0.5, 1.0, 1.5 s)

    expect(lines).toEqual(['1.1', '1.2', '1.3', '1.4']);
    readout.cancel();
  });

  it('bounds by the file, not by the bar: a beat exactly at the end does not sound', () => {
    const lines: string[] = [];
    // Exactly one beat long: the file ends as beat 2 would begin, and a
    // sample at the end is the first sample of the next pass, not this one.
    const readout = beatScheduler(SR, ctx(), (line) => lines.push(line), 24000);

    readout.onSample(0);
    vi.advanceTimersByTime(2000);

    expect(lines).toEqual(['1.1']);
    readout.cancel();
  });

  it('a wrap re-anchors and the next pass announces its own first beat', () => {
    const lines: string[] = [];
    const readout = beatScheduler(SR, ctx(), (line) => lines.push(line), 9600);

    // Heartbeats arrive every 250 ms and never land twice on the same
    // sample, so a wrap shows up as a position moving *backwards* — which
    // is what distinguishes a new pass from the same beat re-announced
    // (#37: dedupe on movement, not text).
    readout.onSample(0); // pass 1 begins
    vi.advanceTimersByTime(100);
    readout.onSample(4800); // still inside beat 1, later in the pass
    vi.advanceTimersByTime(100);
    readout.onSample(1200); // wrapped: pass 2, back near the top

    // Two passes, two announcements — the bound stops phantom beats, not
    // the readout itself (#37: a sub-beat loop must keep printing).
    expect(lines).toEqual(['1.1', '1.1']);
    readout.cancel();
  });

  it('targets without a tempo map fall back to seconds, unbounded', () => {
    const lines: string[] = [];
    const readout = beatScheduler(SR, undefined, (line) => lines.push(line), 9600);

    readout.onSample(0);
    readout.onSample(SR); // 1 s in — past the bound, and still reported
    expect(lines).toEqual(['0:00', '0:01']);
    readout.cancel();
  });
});
