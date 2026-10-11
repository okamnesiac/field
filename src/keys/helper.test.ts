import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeysHelper } from './helper.js';
import type { KeyboardLayout } from './position.js';

// A stand-in for `field-audiod --keys`, scripted per test: it prints the
// lines it is given, records every line it reads, and exits 0 at the end
// of its input, as the real helper does.
const STUB = `
const { appendFileSync } = require('node:fs');
const [, , log, ...lines] = process.argv;
for (const line of lines) {
  if (line.startsWith('exit:')) process.exit(Number(line.slice(5)));
  if (line.startsWith('laterexit:')) setTimeout(() => process.exit(Number(line.slice(10))), 200);
  else if (line.startsWith('later:')) setTimeout(() => console.log(line.slice(6)), 100);
  else console.log(line);
}
require('node:readline').createInterface({ input: process.stdin })
  .on('line', (l) => appendFileSync(log, l + '\\n'))
  .on('close', () => process.exit(0));
`;

let dir: string;
let stub: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-keys-helper-'));
  stub = join(dir, 'stub.cjs');
  log = join(dir, 'received.log');
  writeFileSync(stub, STUB);
  writeFileSync(log, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function command(...lines: string[]) {
  return { file: process.execPath, args: [stub, log, ...lines] };
}

const KEYBOARD = { name: 'Dvorak', keys: { KeyA: 'a', KeyS: 'o' }, dead: [] };

describe('the keys helper', () => {
  it('reports the keyboard layout before ready, sends MIDI, and ends at end of input', async () => {
    const layouts: KeyboardLayout[] = [];
    const helper = await KeysHelper.start('Field Keys', {
      command: command(JSON.stringify({ keyboard: KEYBOARD }), JSON.stringify({ ready: true, name: 'Field Keys' })),
      onKeyboard: (layout) => layouts.push(layout),
    });
    expect(layouts).toEqual([KEYBOARD]);
    helper.send([144, 60, 100]);
    helper.send([128, 60, 0]);
    expect(await helper.close()).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('{"midi":[144,60,100]}\n{"midi":[128,60,0]}\n');
  });

  it('passes on a keyboard layout that changes mid-session', async () => {
    const layouts: KeyboardLayout[] = [];
    const french = { name: 'French', keys: { KeyA: 'q' }, dead: [] };
    const helper = await KeysHelper.start('Field Keys', {
      command: command(
        JSON.stringify({ keyboard: KEYBOARD }),
        JSON.stringify({ ready: true, name: 'Field Keys' }),
        `later:${JSON.stringify({ keyboard: french })}`,
      ),
      onKeyboard: (layout) => layouts.push(layout),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(layouts).toEqual([KEYBOARD, french]);
    await helper.close();
  });

  it('rejects with the helper error when it cannot start', async () => {
    await expect(
      KeysHelper.start('Field Keys', {
        command: command(JSON.stringify({ error: 'cannot create a virtual MIDI source named Field Keys on this system' }), 'exit:1'),
      }),
    ).rejects.toThrow('cannot create a virtual MIDI source named Field Keys on this system');
  });

  it('rejects with the exit code when the helper dies silently', async () => {
    await expect(KeysHelper.start('Field Keys', { command: command('exit:3') })).rejects.toThrow(/exited with code 3/);
  });

  it('reports a helper that exits on its own after it was ready, with its error', async () => {
    const reasons: string[] = [];
    const helper = await KeysHelper.start('Field Keys', {
      command: command(
        JSON.stringify({ ready: true, name: 'Field Keys' }),
        `later:${JSON.stringify({ error: 'the MIDI server went away' })}`,
        'laterexit:1',
      ),
      onExit: (reason) => reasons.push(reason),
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(reasons).toEqual(['the MIDI server went away']);
    helper.send([144, 60, 100]);
  });

  it('does not report its own close as an exit', async () => {
    const reasons: string[] = [];
    const helper = await KeysHelper.start('Field Keys', {
      command: command(JSON.stringify({ ready: true, name: 'Field Keys' })),
      onExit: (reason) => reasons.push(reason),
    });
    expect(await helper.close()).toBe(0);
    expect(reasons).toEqual([]);
  });
});
