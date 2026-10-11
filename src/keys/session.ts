import type { Knob } from '../schema/knobs.js';
import type { Keymap, KeymapAction } from '../schema/keymap.js';
import { controllerOf, knobList, knobValue, stepFrom, type ShownKnob } from './knobs.js';
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
  // The knobs the arrows choose and turn, `mod` first, and which is chosen.
  knobs: ShownKnob[];
  chosen = 0;
  message: string | undefined;
  // The turn key held now, if any: the one pressed last.
  private turning: { position: string; steps: number; since: number } | undefined;
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
    return [...this.releaseAll(), ...this.untoggleAll(), this.cc(this.keymap.channel, ALL_NOTES_OFF, 0)];
  }

  // A reloaded keymap applies to the next press; notes sounding finish
  // with the notes and channel they started with. Controllers toggled on
  // go back to 0, because the keymap that could toggle them off is gone.
  setKeymap(keymap: Keymap): MidiMessage[] {
    if (keymap.velocity !== this.keymap.velocity) this.velocity = keymap.velocity;
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

  // A held turn key turns again on each tick, faster the longer it is held.
  tick(now: number): MidiMessage[] {
    if (this.turning === undefined) return [];
    const held = now - this.turning.since;
    const rate = TURN_RATES.find(({ from }) => held >= from);
    return rate === undefined ? [] : this.turn(this.turning.steps * rate.steps);
  }

  ticking(): boolean {
    return this.turning !== undefined;
  }

  // A new knob list, from a knob file saved: each knob keeps the value its
  // controller has, and the choice stays on the knob of the same name.
  setKnobs(knobs: ShownKnob[]): void {
    const label = this.knobs[this.chosen]?.label;
    const same = knobs.findIndex((k) => k.label === label);
    this.knobs = knobs;
    this.chosen = same >= 0 ? same : Math.min(this.chosen, knobs.length - 1);
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

  bindsKnobs(): boolean {
    return [...this.keymap.controls.values()].some((a) => a !== 'panic' && ('knob' in a || 'turn' in a));
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
    return controlChange(channel, cc, value);
  }

  // Turns the chosen knob `steps` steps, from where its controller was
  // last sent, or from its default before that, and sends the result once.
  private turn(steps: number): MidiMessage[] {
    const { knob } = this.knobs[this.chosen]!;
    const from = this.controllers.get(knob.cc) ?? controllerOf(knob, knob.default);
    let to = from;
    for (let i = 0; i < Math.abs(steps); i++) to = stepFrom(knob, to, steps > 0 ? 1 : -1);
    return to === from ? [] : [this.cc(this.keymap.channel, knob.cc, to)];
  }

  private control(position: string, action: KeymapAction, now: number): MidiMessage[] {
    const channel = this.keymap.channel;
    if (action === 'panic') {
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
    if ('knob' in action) {
      const count = this.knobs.length;
      this.chosen = (((this.chosen + action.knob) % count) + count) % count;
      return [];
    }
    if ('turn' in action) {
      this.heldControls.set(position, { channel, action });
      this.turning = { position, steps: action.turn, since: now };
      return this.turn(action.turn);
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
