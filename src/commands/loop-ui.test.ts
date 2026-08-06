import { describe, expect, it } from 'vitest';
import { LoopDisplay } from './loop-ui.js';

// The display is a pure function of its calls over an injected write, so
// these assert the exact byte stream — ANSI included. \x1b[2K clears the
// line being repainted; \x1b[1A steps up to rewrite the header when the
// swap closes a block.

const A = 'a1b2c3d4e5f6'.padEnd(64, '0');
const B = 'f6e5d4c3b2a1'.padEnd(64, '0');

function harness() {
  const out: string[] = [];
  const d = new LoopDisplay((chunk) => out.push(chunk));
  return { d, text: () => out.join('') };
}

describe('LoopDisplay', () => {
  it('renders the block: header, positions, pending, swap closes history', () => {
    const { d, text } = harness();
    d.start('//songs/creek/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.position('1.2', 240);
    d.queue(B, '/out/main.wav'); // reload accepted: the position line carries it
    d.position('1.3', 480);
    d.position('1.1', 0); // the wrap: successor's beat, held until confirmed
    d.swapped('/out/main.wav');
    d.position('1.2', 240);
    d.end();
    expect(text()).toBe(
      'playing //songs/creek/mix:main@a1b2c3d4e5f6 → (Volt 476)\n' +
        '\r\x1b[2K  [1] 1.1' +
        '\r\x1b[2K  [1] 1.2' +
        '\r\x1b[2K  [1] 1.2     (new version f6e5d4c3b2a1)' +
        '\r\x1b[2K  [1] 1.3     (new version f6e5d4c3b2a1)' +
        // the held 1.1 renders nothing until the swap confirms; then the
        // old block closes at its final position, without the notice
        '\r\x1b[1A\x1b[2Kplayed //songs/creek/mix:main@a1b2c3d4e5f6\n' +
        '\x1b[2K  [1] 1.3\n' +
        'playing //songs/creek/mix:main@f6e5d4c3b2a1 → (Volt 476)\n' +
        '\r\x1b[2K  [1] 1.1' +
        '\r\x1b[2K  [1] 1.2' +
        '\n',
    );
  });

  it('counts passes from the second wrap on', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('12.4', 9000);
    d.position('1.1', 0); // plain wrap, nothing queued
    d.position('1.1', 0); // dedupe upstream normally prevents this; harmless
    d.position('12.4', 9000);
    d.position('1.1', 0);
    expect(text()).toContain('\r\x1b[2K  [2] 1.1');
    expect(text()).toContain('\r\x1b[2K  [3] 1.1');
  });

  it('a said line buries the header: the swap opens a fresh block instead of rewriting history', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    d.say('check: songs/x/tracks/keys.yaml: something');
    d.position('1.2', 240);
    d.position('1.1', 0);
    d.swapped('/out/main.wav');
    expect(text()).not.toContain('\x1b[1A'); // never steps onto the said line
    expect(text()).toContain('\nplayed //songs/x/mix:main@a1b2c3d4e5f6\n');
    expect(text()).toContain('playing //songs/x/mix:main@f6e5d4c3b2a1 → (Volt 476)\n');
  });

  it('a device move repeats the header; the pass carries straight on', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, ' (MacBook Pro Speakers)');
    d.position('12.4', 9000);
    d.position('1.1', 0); // real wrap → pass 2
    d.position('3.3', 2500);
    d.deviceMoved('Volt 476');
    d.position('5.3', 4600);
    expect(text()).toContain('playing //songs/x/mix:main@a1b2c3d4e5f6 → (MacBook Pro Speakers)\n');
    expect(text()).toContain('\nplaying //songs/x/mix:main@a1b2c3d4e5f6 → (Volt 476)\n');
    expect(text()).not.toContain('output moved'); // uniform lines instead
    expect(text().endsWith('\r\x1b[2K  [2] 5.3')).toBe(true); // same iteration
  });

  it('resample-ratio jitter is not a wrap', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('5.3', 4600);
    d.position('5.2', 4400); // a device switch stepping back, not a return to the top
    expect(text()).not.toContain('[2]');
  });

  it("a swap that isn't ours opens the block hashless (#36 review P3)", () => {
    const { d, text } = harness();
    d.start('//songs/x/sounds:gen1', A, '');
    d.position('12.4', 9000);
    d.queue(B, '/out/gen1/1.wav');
    // Another shell's reload won latest-wins: the daemon names a path we
    // never sent. Claiming our hash would be internally consistent and
    // entirely wrong about what is playing.
    d.position('1.1', 0);
    d.swapped('/audio/gen1/2.wav');
    expect(text()).toContain('played //songs/x/sounds:gen1@a1b2c3d4e5f6\n');
    expect(text()).toContain('playing //songs/x/sounds:gen1\n'); // no @hash claimed
    expect(text()).not.toContain('playing //songs/x/sounds:gen1@f6e5d4c3b2a1');
  });

  it('dequeue takes the notice back down', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    d.dequeue();
    expect(text().endsWith('\r\x1b[2K  [1] 1.1')).toBe(true); // repainted clean
  });

  it('held positions flush as a plain pass boundary when no confirmation comes', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('12.4', 9000);
    d.queue(B, '/out/main.wav');
    d.position('1.1', 0);
    d.position('1.2', 240);
    d.position('1.3', 480); // third held beat: give up waiting, it was a plain wrap
    expect(text()).toContain('  [2] 1.1');
    expect(text()).toContain('  [2] 1.3     (new version f6e5d4c3b2a1)'); // still queued
  });
});
