import type { Knob } from '../schema/knobs.js';
import type { Keymap, KeymapAction } from '../schema/keymap.js';
import { CC_MAX, controllerOf, knobList, knobValue, nearestController, stepFrom, type ShownKnob } from './knobs.js';
import { noteName, signed } from './print.js';
import { MOD_ALT, MOD_CTRL, MOD_HYPER, MOD_META, MOD_SUPER, type KeyEventType } from './terminal.js';

export type MidiMessage = number[];

// A key pressed with any of these held does nothing. Shift plays as
// without it, and the lock bits, which the protocol sets on every key
// while a lock is on, change nothing (keyboard-instrument.md §2.4).
const BLOCKING_MODS = MOD_ALT | MOD_CTRL | MOD_SUPER | MOD_HYPER | MOD_META;

const BEND_CENTER = 8192;
const BEND_MAX = 16383;
const MOD_WHEEL = 1;
const ALL_NOTES_OFF = 123;

// How often a held turn key turns, and how many steps a tick it turns
// after it has been held for at least `from` milliseconds
// (instrument-knobs.md §2.6): about 2.3 seconds from one end of a range
// to the other.
export const TICK_MS = 40;
const TURN_RATES = [
  { from: 1500, steps: 4 },
  { from: 1000, steps: 2 },
  { from: 300, steps: 1 },
];

function noteOn(channel: number, note: number, velocity: number): MidiMessage {
  return [0x90 | (channel - 1), note, velocity];
}

function noteOff(channel: number, note: number): MidiMessage {
  return [0x80 | (channel - 1), note, 0];
}

function controlChange(channel: number, cc: number, value: number): MidiMessage {
  return [0xb0 | (channel - 1), cc, value];
}

function pitchBend(channel: number, value: number): MidiMessage {
  return [0xe0 | (channel - 1), value & 0x7f, value >> 7];
}

export function bendValue(x: number): number {
  return Math.min(BEND_MAX, Math.max(0, Math.round(BEND_CENTER + x * BEND_CENTER)));
}

// The note state behind `field keys`. Two keys can hold the same note,
// through a shared chord note or a transpose, so the session counts the
// keys holding each note: the first press sends the note-on and the last
// release the note-off, so every note-on gets exactly one note-off
// (keyboard-instrument.md §2.1). A release ends the notes its own press
// started, on the channel they started on, whatever has changed since.
export class KeysSession {
  keymap: Keymap;
  transpose = 0;
  velocity: number;
  // The pitch bend, from -1 to 1, as this session last sent it, for the
  // status line; the receiver starts it at rest.
  bend = 0;
  // Each controller this session has sent, by number, with the last value
  // sent: what the knobs and the status line show.
  readonly controllers = new Map<number, number>();
  // The same by channel, in the order the values were last sent, which is
  // what a take starts from (instrument-knobs.md §2.8).
  private readonly sent = new Map<number, { channel: number; cc: number; value: number }>();
  // The knobs the arrows choose and turn, `mod` first, and which is chosen.
  knobs: ShownKnob[];
  chosen = 0;
  message: string | undefined;
  // The value being typed for the chosen knob, while an entry is open
  // (instrument-knobs.md §2.7).
  entry: { text: string } | undefined;
  // The turn key held now, if any: the one pressed last.
  private turning: { position: string; steps: number; since: number } | undefined;
  // Each controller gliding to a typed value: one glide per controller,
  // moving `perMs` controller values a millisecond from `from` at `since`.
  private readonly glides = new Map<number, { channel: number; from: number; to: number; since: number; perMs: number }>();
  private readonly held = new Map<string, { channel: number; notes: number[] }>();
  private readonly holders = new Map<number, number>();
  private readonly heldControls = new Map<string, { channel: number; action: KeymapAction }>();
  private readonly toggledOn = new Map<string, { channel: number; cc: number }>();

  constructor(keymap: Keymap, knobs: ShownKnob[] = knobList([])) {
    this.keymap = keymap;
    this.velocity = keymap.velocity;
    this.knobs = knobs;
  }

  // The modulation wheel (CC 1), from 0 to 127; the receiver starts it at 0.
  get mod(): number {
    return this.controllers.get(MOD_WHEEL) ?? 0;
  }

  // `now` is in milliseconds, on the clock `tick` is given.
  handleKey(position: string, type: KeyEventType, mods: number, now = performance.now()): MidiMessage[] {
    if (type === 'repeat') return [];
    return type === 'press' ? this.press(position, mods, now) : this.release(position);
  }

  press(position: string, mods = 0, now = performance.now()): MidiMessage[] {
    if ((mods & BLOCKING_MODS) !== 0) return [];
    if (this.held.has(position) || this.heldControls.has(position)) return [];
    this.message = undefined;
    if (position === 'Enter') return this.complete(now);
    if (position === 'Backspace') {
      if (this.entry !== undefined) this.entry.text = this.entry.text.slice(0, -1);
      if (this.entry?.text === '') this.entry = undefined;
      return [];
    }
    if (position === 'Escape') {
      if (this.entry !== undefined) this.entry = undefined;
      else this.message = 'Ctrl-C quits';
      return [];
    }
    // The decimal point is Period's only while an entry is open; otherwise
    // the key does what the keymap binds there.
    if (position === 'Period' && this.entry !== undefined) {
      this.type('.');
      return [];
    }
    const action = this.keymap.controls.get(position);
    if (action !== undefined) return this.control(position, action, now);
    const offsets = this.keymap.notes.get(position);
    if (offsets === undefined) return [];

    const channel = this.keymap.channel;
    const notes = [...new Set(offsets.map((o) => this.keymap.base + this.transpose + o))];
    this.held.set(position, { channel, notes });
    const messages: MidiMessage[] = [];
    for (const note of notes) {
      const key = channel * 128 + note;
      const count = this.holders.get(key) ?? 0;
      this.holders.set(key, count + 1);
      if (count === 0) messages.push(noteOn(channel, note, this.velocity));
    }
    return messages;
  }

  release(position: string): MidiMessage[] {
    const control = this.heldControls.get(position);
    if (control !== undefined) {
      this.heldControls.delete(position);
      const { action, channel } = control;
      if (action !== 'panic' && 'turn' in action) {
        if (this.turning?.position === position) this.turning = undefined;
        return [];
      }
      if (action !== 'panic' && 'bend' in action) {
        this.bend = 0;
        return [pitchBend(channel, BEND_CENTER)];
      }
      if (action !== 'panic' && 'cc' in action) return [this.cc(channel, action.cc, 0)];
      return [];
    }
    const held = this.held.get(position);
    if (held === undefined) return [];
    this.held.delete(position);
    const messages: MidiMessage[] = [];
    for (const note of held.notes) {
      const key = held.channel * 128 + note;
      const count = this.holders.get(key) ?? 0;
      if (count <= 1) {
        this.holders.delete(key);
        messages.push(noteOff(held.channel, note));
      } else {
        this.holders.set(key, count - 1);
      }
    }
    return messages;
  }

  // Focus-out: a terminal that has lost focus never reports the release.
  releaseAll(): MidiMessage[] {
    return [...this.held.keys(), ...this.heldControls.keys()].flatMap((position) => this.release(position));
  }

  quit(): MidiMessage[] {
    this.glides.clear();
    return [...this.releaseAll(), ...this.untoggleAll(), this.cc(this.keymap.channel, ALL_NOTES_OFF, 0)];
  }

  // A reloaded keymap applies to the next press; notes sounding finish
  // with the notes and channel they started with. Controllers toggled on
  // go back to 0, because the keymap that could toggle them off is gone.
  setKeymap(keymap: Keymap): MidiMessage[] {
    if (keymap.velocity !== this.keymap.velocity) this.velocity = keymap.velocity;
    this.entry = undefined;
    this.glides.clear();
    this.keymap = keymap;
    if (!this.transposeFits(this.transpose)) {
      this.transpose = 0;
      this.message = 'transpose reset to 0 for the reloaded keymap';
    }
    return this.untoggleAll();
  }

  // A toggled sustain left on would hold the receiver's notes after
  // `field keys` has gone.
  private untoggleAll(): MidiMessage[] {
    const messages = [...this.toggledOn.values()].map(({ channel, cc }) => this.cc(channel, cc, 0));
    this.toggledOn.clear();
    return messages;
  }

  // A held turn key turns again on each tick, faster the longer it is
  // held, and each glide moves on: one control change per controller a
  // tick at most.
  tick(now: number): MidiMessage[] {
    const messages: MidiMessage[] = [];
    if (this.turning !== undefined) {
      const held = now - this.turning.since;
      const rate = TURN_RATES.find(({ from }) => held >= from);
      if (rate !== undefined) messages.push(...this.turn(this.turning.steps * rate.steps));
    }
    for (const [cc, glide] of this.glides) {
      const distance = Math.abs(glide.to - glide.from);
      const moved = Math.min(distance, Math.floor((now - glide.since) * glide.perMs));
      const at = glide.from + Math.sign(glide.to - glide.from) * moved;
      if (at === glide.to) this.glides.delete(cc);
      if (at !== this.controllers.get(cc)) messages.push(this.cc(glide.channel, cc, at));
    }
    return messages;
  }

  ticking(): boolean {
    return this.turning !== undefined || this.glides.size > 0;
  }

  // A new knob list, from a knob file saved: each knob keeps the value its
  // controller has, and the choice stays on the knob of the same name.
  setKnobs(knobs: ShownKnob[]): void {
    const label = this.knobs[this.chosen]?.label;
    const same = knobs.findIndex((k) => k.label === label);
    this.knobs = knobs;
    this.chosen = same >= 0 ? same : Math.min(this.chosen, knobs.length - 1);
    // An entry for a knob that is gone closes without completing.
    if (same < 0) this.entry = undefined;
  }

  // A knob's value: what its controller was last sent as, or its default.
  knobValue(knob: Knob): number {
    const cc = this.controllers.get(knob.cc);
    return cc === undefined ? knob.default : knobValue(knob, cc);
  }

  // The bends the keymap can send, whether it can move the modulation
  // wheel, and whether it binds the knobs, so the status line and the knob
  // line show a value only where the keymap can change it.
  bends(): number[] {
    return [...this.keymap.controls.values()].flatMap((a) => (a !== 'panic' && 'bend' in a ? [a.bend] : []));
  }

  setsMod(): boolean {
    return [...this.keymap.controls.values()].some((a) => a !== 'panic' && 'cc' in a && a.cc === MOD_WHEEL);
  }

  // Every controller from 0 to 119 this session has sent on each channel,
  // with its last value, the least recently sent first. 120 to 127 are
  // channel mode messages, which act once and leave no value behind.
  sentControllers(): { channel: number; cc: number; value: number }[] {
    return [...this.sent.values()].filter(({ cc }) => cc < 120);
  }

  bindsKnobs(): boolean {
    return [...this.keymap.controls.values()].some((a) => a !== 'panic' && ('knob' in a || 'turn' in a || 'type' in a));
  }

  heldPositions(): ReadonlySet<string> {
    return new Set(this.held.keys());
  }

  soundingNotes(): string[] {
    return [...this.holders.keys()].sort((a, b) => a - b).map((key) => noteName(key % 128));
  }

  private transposeFits(transpose: number): boolean {
    for (const offsets of this.keymap.notes.values()) {
      for (const o of offsets) {
        const note = this.keymap.base + transpose + o;
        if (note < 0 || note > 127) return false;
      }
    }
    return true;
  }

  private cc(channel: number, cc: number, value: number): MidiMessage {
    this.controllers.set(cc, value);
    const key = channel * 128 + cc;
    this.sent.delete(key);
    this.sent.set(key, { channel, cc, value });
    return controlChange(channel, cc, value);
  }

  // Where a knob's controller is: where it was last sent, or before that,
  // its default's controller value.
  private controllerAt(knob: Knob): number {
    return this.controllers.get(knob.cc) ?? controllerOf(knob, knob.default);
  }

  // Turns the chosen knob `steps` steps and sends the result once. A turn
  // stops the knob's glide where it is.
  private turn(steps: number): MidiMessage[] {
    const { knob } = this.knobs[this.chosen]!;
    this.glides.delete(knob.cc);
    const from = this.controllerAt(knob);
    let to = from;
    for (let i = 0; i < Math.abs(steps); i++) to = stepFrom(knob, to, steps > 0 ? 1 : -1);
    return to === from ? [] : [this.cc(this.keymap.channel, knob.cc, to)];
  }

  // Types one character of the chosen knob's value, opening an entry for
  // it: digits, one decimal point, and a minus sign only first. A
  // character that breaks that does nothing, and a decimal point cannot
  // open an entry.
  private type(character: string): void {
    if (this.entry === undefined) {
      if (character === '.') return;
      this.entry = { text: '' };
    }
    const { text } = this.entry;
    if ((character === '-' && text !== '') || (character === '.' && text.includes('.'))) return;
    this.entry.text = text + character;
  }

  // Completes the entry: the knob glides to the controller value nearest
  // the typed number, at the keymap's speed, or with `glide: 0` goes there
  // at once. An entry with no digit completes nothing.
  private complete(now: number): MidiMessage[] {
    const entry = this.entry;
    this.entry = undefined;
    if (entry === undefined || !/\d/.test(entry.text)) return [];
    const { knob } = this.knobs[this.chosen]!;
    const channel = this.keymap.channel;
    const from = this.controllerAt(knob);
    const to = nearestController(knob, Number(entry.text));
    this.glides.delete(knob.cc);
    if (this.keymap.glide === 0 || to === from) return [this.cc(channel, knob.cc, to)];
    this.glides.set(knob.cc, { channel, from, to, since: now, perMs: CC_MAX / (this.keymap.glide * 1000) });
    return [];
  }

  private control(position: string, action: KeymapAction, now: number): MidiMessage[] {
    const channel = this.keymap.channel;
    if (action === 'panic') {
      this.glides.clear();
      return [...this.releaseAll(), ...this.untoggleAll(), this.cc(channel, ALL_NOTES_OFF, 0)];
    }
    if ('transpose' in action) {
      const next = this.transpose + action.transpose;
      if (this.transposeFits(next)) this.transpose = next;
      else this.message = `transpose ${signed(next)} would move a note outside MIDI's range`;
      return [];
    }
    if ('velocity' in action) {
      this.velocity = Math.min(127, Math.max(1, this.velocity + action.velocity));
      return [];
    }
    if ('bend' in action) {
      this.heldControls.set(position, { channel, action });
      this.bend = action.bend;
      return [pitchBend(channel, bendValue(action.bend))];
    }
    if ('type' in action) {
      this.type(String(action.type));
      return [];
    }
    // A knob action completes an open entry first, as moving off a cell
    // completes it in a spreadsheet.
    if ('knob' in action) {
      const completed = this.complete(now);
      const count = this.knobs.length;
      this.chosen = (((this.chosen + action.knob) % count) + count) % count;
      return completed;
    }
    if ('turn' in action) {
      const completed = this.complete(now);
      this.heldControls.set(position, { channel, action });
      this.turning = { position, steps: action.turn, since: now };
      return [...completed, ...this.turn(action.turn)];
    }
    if (action.mode === 'hold') {
      this.heldControls.set(position, { channel, action });
      return [this.cc(channel, action.cc, action.value)];
    }
    if (action.mode === 'toggle') {
      const on = this.toggledOn.get(position);
      if (on !== undefined) {
        this.toggledOn.delete(position);
        return [this.cc(on.channel, on.cc, 0)];
      }
      this.toggledOn.set(position, { channel, cc: action.cc });
      return [this.cc(channel, action.cc, action.value)];
    }
    return [this.cc(channel, action.cc, action.value)];
  }
}
