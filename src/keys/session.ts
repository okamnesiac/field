import type { Keymap, KeymapAction } from '../schema/keymap.js';
import { noteName } from './print.js';
import { MOD_ALT, MOD_CTRL, MOD_HYPER, MOD_META, MOD_SUPER, type KeyEventType } from './terminal.js';

export type MidiMessage = number[];

// A key pressed with any of these held does nothing. Shift plays as
// without it, and the lock bits, which the protocol sets on every key
// while a lock is on, change nothing (keyboard-instrument.md §2.4).
const BLOCKING_MODS = MOD_ALT | MOD_CTRL | MOD_SUPER | MOD_HYPER | MOD_META;

const BEND_CENTER = 8192;
const BEND_MAX = 16383;
const ALL_NOTES_OFF = 123;

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

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
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
  message: string | undefined;
  private readonly held = new Map<string, { channel: number; notes: number[] }>();
  private readonly holders = new Map<number, number>();
  private readonly heldControls = new Map<string, { channel: number; action: KeymapAction }>();
  private readonly toggledOn = new Set<string>();

  constructor(keymap: Keymap) {
    this.keymap = keymap;
    this.velocity = keymap.velocity;
  }

  handleKey(position: string, type: KeyEventType, mods: number): MidiMessage[] {
    if (type === 'repeat') return [];
    return type === 'press' ? this.press(position, mods) : this.release(position);
  }

  press(position: string, mods = 0): MidiMessage[] {
    if ((mods & BLOCKING_MODS) !== 0) return [];
    if (this.held.has(position) || this.heldControls.has(position)) return [];
    this.message = undefined;
    const action = this.keymap.controls.get(position);
    if (action !== undefined) return this.control(position, action);
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
      if (action !== 'panic' && 'bend' in action) return [pitchBend(channel, BEND_CENTER)];
      if (action !== 'panic' && 'cc' in action) return [controlChange(channel, action.cc, 0)];
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
    return [...this.releaseAll(), controlChange(this.keymap.channel, ALL_NOTES_OFF, 0)];
  }

  // A reloaded keymap applies to the next press; notes sounding finish
  // with the notes and channel they started with.
  setKeymap(keymap: Keymap): void {
    if (keymap.velocity !== this.keymap.velocity) this.velocity = keymap.velocity;
    this.keymap = keymap;
    this.toggledOn.clear();
    if (!this.transposeFits(this.transpose)) {
      this.transpose = 0;
      this.message = 'transpose reset to 0 for the reloaded keymap';
    }
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

  private control(position: string, action: KeymapAction): MidiMessage[] {
    const channel = this.keymap.channel;
    if (action === 'panic') {
      return [...this.releaseAll(), controlChange(channel, ALL_NOTES_OFF, 0)];
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
      return [pitchBend(channel, bendValue(action.bend))];
    }
    if (action.mode === 'hold') {
      this.heldControls.set(position, { channel, action });
      return [controlChange(channel, action.cc, action.value)];
    }
    if (action.mode === 'toggle') {
      const on = this.toggledOn.has(position);
      if (on) this.toggledOn.delete(position);
      else this.toggledOn.add(position);
      return [controlChange(channel, action.cc, on ? 0 : action.value)];
    }
    return [controlChange(channel, action.cc, action.value)];
  }
}
