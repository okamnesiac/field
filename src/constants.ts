// Canonical musical time is integer ticks at fixed PPQ (project-core.md §3.1).
// bar.beat.tick is a display projection through the meter map, never stored.
export const PPQ = 960;

// One whole note in ticks; a beat at meter denominator d is WHOLE_NOTE_TICKS / d.
export const WHOLE_NOTE_TICKS = PPQ * 4;

export const PROJECT_MANIFEST = 'field.yaml';
export const DEFAULT_SAMPLE_RATE = 48000;
