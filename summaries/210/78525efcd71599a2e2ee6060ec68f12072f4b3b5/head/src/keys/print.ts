import { NAMED_ROWS, type Keymap, type KeymapAction } from '../schema/keymap.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Scientific pitch notation, where MIDI note 60 is C4.
export function noteName(note: number): string {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

const CELL = 6;

function isBound(keymap: Keymap, position: string): boolean {
  return keymap.notes.has(position) || keymap.controls.has(position);
}

// Each row's keys and how far it sits to the right of the number row, in
// characters, so the diagram keeps a keyboard's stagger. The ISO key left
// of KeyZ is drawn only when bound, because most keyboards here lack it.
function diagramRows(keymap: Keymap): { indent: number; positions: readonly string[] }[] {
  return [
    { indent: 0, positions: ['Backquote', ...NAMED_ROWS.number] },
    { indent: 3, positions: ['Tab', ...NAMED_ROWS.top, 'Backslash'] },
    { indent: 10, positions: NAMED_ROWS.home },
    isBound(keymap, 'IntlBackslash')
      ? { indent: 7, positions: ['IntlBackslash', ...NAMED_ROWS.bottom] }
      : { indent: 13, positions: NAMED_ROWS.bottom },
  ];
}

const EXTRA_POSITIONS: { position: string; label: string }[] = [
  { position: 'Space', label: 'Space' },
  { position: 'ArrowLeft', label: '←' },
  { position: 'ArrowRight', label: '→' },
  { position: 'ArrowUp', label: '↑' },
  { position: 'ArrowDown', label: '↓' },
];

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function actionTag(action: KeymapAction): string {
  if (action === 'panic') return '!!';
  if ('transpose' in action) return `T${signed(action.transpose)}`;
  if ('velocity' in action) return `V${signed(action.velocity)}`;
  if ('bend' in action) return `B${signed(action.bend)}`;
  if ('knob' in action) return `K${signed(action.knob)}`;
  if ('turn' in action) return `R${signed(action.turn)}`;
  if ('type' in action) return String(action.type);
  return `cc${action.cc}`;
}

export function describeAction(action: KeymapAction): string {
  if (action === 'panic') return 'panic: release every note and send All Notes Off';
  if ('transpose' in action) return `transpose ${signed(action.transpose)}`;
  if ('velocity' in action) return `velocity ${signed(action.velocity)}`;
  if ('bend' in action) return `pitch bend ${signed(action.bend)} while held`;
  if ('knob' in action) return `choose the knob ${Math.abs(action.knob)} to the ${action.knob > 0 ? 'right' : 'left'}`;
  if ('turn' in action) {
    const steps = Math.abs(action.turn);
    return `turn the chosen knob ${steps} step${steps === 1 ? '' : 's'} ${action.turn > 0 ? 'up' : 'down'}, faster while held`;
  }
  if ('type' in action) return `type ${action.type} into the chosen knob's value`;
  const how = { set: '', hold: ' while held', toggle: ', toggled' }[action.mode];
  return `cc ${action.cc} = ${action.value}${how}`;
}

function cellLabel(keymap: Keymap, position: string): string {
  const action = keymap.controls.get(position);
  if (action !== undefined) return actionTag(action);
  const offsets = keymap.notes.get(position);
  if (offsets === undefined) return '·';
  const root = noteName(keymap.base + offsets[0]!);
  return offsets.length > 1 ? `${root}+` : root;
}

export function printKeymap(keymap: Keymap): string {
  const lines: string[] = [];
  lines.push(keymap.description !== undefined ? `${keymap.name}: ${keymap.description}` : keymap.name);
  lines.push('');

  for (const { indent, positions } of diagramRows(keymap)) {
    lines.push((' '.repeat(indent) + positions.map((p) => cellLabel(keymap, p).padEnd(CELL)).join('')).trimEnd());
  }

  const extras = EXTRA_POSITIONS.filter(({ position }) => isBound(keymap, position));
  if (extras.length > 0) {
    lines.push('');
    lines.push(extras.map(({ position, label }) => `${label} ${cellLabel(keymap, position)}`).join('   '));
  }

  const chords = [...keymap.notes].filter(([, offsets]) => offsets.length > 1);
  if (keymap.controls.size > 0 || chords.length > 0) {
    lines.push('');
    const width = Math.max(...[...keymap.controls.keys(), ...chords.map(([p]) => p)].map((p) => p.length));
    for (const [position, offsets] of chords) {
      lines.push(`${position.padEnd(width)}  chord ${offsets.map((o) => noteName(keymap.base + o)).join(' ')}`);
    }
    for (const [position, action] of keymap.controls) {
      lines.push(`${position.padEnd(width)}  ${describeAction(action)}`);
    }
  }

  lines.push('');
  lines.push(`Notes are in scientific pitch notation: MIDI note 60 is C4. Channel ${keymap.channel}, velocity ${keymap.velocity}.`);
  return lines.join('\n') + '\n';
}
