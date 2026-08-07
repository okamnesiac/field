import { describe, expect, it } from 'vitest';
import { LoopDisplay, openingHash } from './loop-ui.js';

// The display is a pure function of its calls over an injected write, so
// these assert the exact byte stream — ANSI included. \x1b[2K clears the
// line being repainted; \x1b[1A steps up to rewrite the header, both for
// the ┬/─ separator flip and for closing a block as `played` history.

const A = 'a1b2c3d4e5f6'.padEnd(64, '0');
const B = 'f6e5d4c3b2a1'.padEnd(64, '0');

function harness(options: ConstructorParameters<typeof LoopDisplay>[1] = {}) {
  const out: string[] = [];
  const d = new LoopDisplay((chunk) => out.push(chunk), options);
  return { d, out, text: () => out.join('') };
}

describe('LoopDisplay', () => {
  it('renders the block: tee while pending, └ under the hash, swap closes history', () => {
    const { d, text } = harness();
    d.start('//songs/creek/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.position('1.2', 240);
    d.queue(B, '/out/main.wav'); // reload accepted: ┬ on the header, └ beneath
    d.position('1.3', 480);
    d.position('1.1', 0); // the wrap: successor's beat, held until confirmed
    d.swapped('/out/main.wav');
    d.position('1.2', 240);
    d.end();
    // 'playing //songs/creek/mix:main' is 30 columns, so └ pads to 30
    // from the 9-column position text: 21 spaces.
    const pad = ' '.repeat(21);
    expect(text()).toBe(
      'playing //songs/creek/mix:main─a1b2c3d4e5f6 → (Volt 476)\n' +
        '\r\x1b[2K  [1] 1.1' +
        '\r\x1b[2K  [1] 1.2' +
        '\r\x1b[1A\x1b[2Kplaying //songs/creek/mix:main┬a1b2c3d4e5f6 → (Volt 476)\n' +
        `\r\x1b[2K  [1] 1.2${pad}└f6e5d4c3b2a1` +
        `\r\x1b[2K  [1] 1.3${pad}└f6e5d4c3b2a1` +
        // the held 1.1 renders nothing until the swap confirms; then the
        // old block closes at its final beat, ─ and └-free
        '\r\x1b[1A\x1b[2Kplayed  //songs/creek/mix:main─a1b2c3d4e5f6\n' +
        '\x1b[2K  [1] 1.3\n' +
        'playing //songs/creek/mix:main─f6e5d4c3b2a1 → (Volt 476)\n' +
        '\r\x1b[2K  [1] 1.1' +
        '\r\x1b[2K  [1] 1.2' +
        '\n',
    );
  });

  it('an edit changed back renders as nothing pending, and its swap keeps the block open', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('12.4', 9000);
    d.queue(B, '/out/main.wav'); // real change: ┬ and └ appear
    d.queue(A, '/out/main.wav'); // changed back: same sha as playing — both vanish
    d.position('1.1', 0); // wrap: held while a takeover is pending
    d.swapped('/out/main.wav'); // byte-identical: no new block, just a pass
    d.position('1.2', 240);
    d.end();
    const t = text();
    expect(t).toContain('┬a1b2c3d4e5f6'); // the real pending showed
    expect(t).toContain('└f6e5d4c3b2a1');
    // the changed-back repaint took both down again
    expect(t).toContain(
      '\r\x1b[1A\x1b[2Kplaying //songs/x/mix:main─a1b2c3d4e5f6\n\r\x1b[2K  [1] 12.4',
    );
    expect(t).not.toContain('played'); // the block never closed
    expect(t).toContain('\r\x1b[2K  [2] 1.1'); // the wrap still counted
  });

  it('counts passes from the second wrap on', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('12.4', 9000);
    d.position('1.1', 0); // plain wrap, nothing queued
    d.position('12.4', 9000);
    d.position('1.1', 0);
    expect(text()).toContain('\r\x1b[2K  [2] 1.1');
    expect(text()).toContain('\r\x1b[2K  [3] 1.1');
  });

  it('a device move repeats the header; the pass carries straight on', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, ' (MacBook Pro Speakers)');
    d.position('12.4', 9000);
    d.position('1.1', 0); // real wrap → pass 2
    d.position('3.3', 2500);
    d.deviceMoved('Volt 476');
    d.position('5.3', 4600);
    expect(text()).toContain('playing //songs/x/mix:main─a1b2c3d4e5f6 → (MacBook Pro Speakers)\n');
    expect(text()).toContain('\nplaying //songs/x/mix:main─a1b2c3d4e5f6 → (Volt 476)\n');
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
    d.start('//songs/x/sound:gen1', A, '');
    d.position('12.4', 9000);
    d.queue(B, '/out/gen1/1.wav');
    // Another shell's reload won latest-wins: the daemon names a path we
    // never sent. Claiming our hash would be internally consistent and
    // entirely wrong about what is playing.
    d.position('1.1', 0);
    d.swapped('/audio/gen1/2.wav');
    expect(text()).toContain('played  //songs/x/sound:gen1─a1b2c3d4e5f6\n');
    expect(text()).toContain('playing //songs/x/sound:gen1\n'); // no hash claimed
    expect(text()).not.toContain('playing //songs/x/sound:gen1─f6e5d4c3b2a1');
  });

  it('a said line buries the header: no cursor-up onto history it cannot reach', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.say('check: songs/x/tracks/keys.yaml: something');
    d.queue(B, '/out/main.wav'); // header is buried: the └ line alone tells the story
    d.position('1.2', 240);
    d.position('1.1', 0);
    d.swapped('/out/main.wav');
    expect(text()).not.toContain('\x1b[1A'); // never steps onto the said line
    expect(text()).toContain('└f6e5d4c3b2a1'); // pending still visible below
    expect(text()).toContain('\nplayed  //songs/x/mix:main─a1b2c3d4e5f6\n');
    expect(text()).toContain('playing //songs/x/mix:main─f6e5d4c3b2a1 → (Volt 476)\n');
  });

  it('dequeue takes the tee and the notice back down', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    d.dequeue();
    expect(
      text().endsWith(
        '\r\x1b[1A\x1b[2Kplaying //songs/x/mix:main─a1b2c3d4e5f6\n\r\x1b[2K  [1] 1.1',
      ),
    ).toBe(true);
  });

  it('requeue: passes count from pass(), and the queued pass transitions with its own hash (#37 P2)', () => {
    const { d, text } = harness({ requeue: true });
    d.start('//songs/x/sound:long', A, '');
    d.position('11.1', 8000);
    d.pass('/audio/long/orig.wav'); // plain requeue pass: same block, next iteration
    d.position('11.1', 8000); // region restart — must NOT count as a wrap on top
    d.pass('/audio/long/orig.wav');
    d.queue(B, '/out/long.wav');
    d.pass('/out/long.wav'); // this pass loads what we queued: the swap moment
    d.position('11.1', 8000);
    d.end();
    const t = text();
    expect(t).toContain('\r\x1b[2K  [2] 11.1'); // pass() counted it
    expect(t).toContain('\r\x1b[2K  [3] 11.1'); // and only pass() — no double count
    expect(t).toContain('played  //songs/x/sound:long─a1b2c3d4e5f6\n');
    expect(t).toContain('playing //songs/x/sound:long─f6e5d4c3b2a1\n'); // correlated, not stale
    // exactly two playing headers ever: the start and the transition
    expect(t.split('playing ').length).toBe(3 + 1); // +1: the ┬ repaint from queue()
  });

  it('requeue: a pass that is not the queued one keeps the pending notice up', () => {
    const { d, text } = harness({ requeue: true });
    d.start('//songs/x/sound:long', A, '');
    d.position('11.1', 8000);
    d.queue(B, '/out/long.wav');
    d.pass('/audio/long/orig.wav'); // built after this pass loaded: not ours yet
    d.position('11.1', 8000);
    expect(text()).toContain('└f6e5d4c3b2a1'); // still pending
    expect(text()).not.toContain('played'); // no transition yet
  });

  it('a header too wide for the terminal is never rewritten in place (#37 P3)', () => {
    const { d, text } = harness({ columns: () => 40 }); // header is ~57 chars
    d.start('//songs/creek/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    d.position('1.1', 0);
    d.swapped('/out/main.wav');
    expect(text()).not.toContain('\x1b[1A'); // one cursor-up would land mid-header
    expect(text()).toContain('played  //songs/creek/mix:main─a1b2c3d4e5f6\n'); // fresh lines instead
  });

  it('the position line truncates to the terminal instead of wrapping', () => {
    const { d, out } = harness({ columns: () => 20 });
    d.start('//songs/creek/mix:main', A, '');
    d.queue(B, '/out/main.wav');
    d.position('1.1', 0);
    const positionChunks = out.filter((c) => c.startsWith('\r\x1b[2K'));
    for (const c of positionChunks) {
      expect(c.length - '\r\x1b[2K'.length).toBeLessThan(20);
    }
  });

  it('a sizeless pty (columns=0) never truncates — an 11-char hash greps as nothing (#37 P3)', () => {
    const { d, text } = harness({ columns: () => 0 });
    d.start('//songs/creek/mix:main', A, ' (Volt 476)');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    d.position('1.1', 0);
    d.swapped('/out/main.wav');
    const t = text();
    expect(t).toContain('└f6e5d4c3b2a1'); // full 12 characters
    expect(t).toContain('played  //songs/creek/mix:main─a1b2c3d4e5f6\n');
    expect(t).toContain('\x1b[1A'); // width unknown is not width zero: rewrites stay on
  });

  it('alignment yields before information: a narrow row packs └ to one space (#37 P3)', () => {
    const { d, text } = harness({ columns: () => 40 }); // ┬ column is 30; 30+13 > 39
    d.start('//songs/creek/mix:main', A, '');
    d.position('1.1', 0);
    d.queue(B, '/out/main.wav');
    expect(text()).toContain('  [1] 1.1 └f6e5d4c3b2a1'); // compact, hash whole
  });

  it('quitting with a takeover pending says the edit built but never sounded', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('4.1', 3000);
    d.queue(B, '/out/main.wav');
    d.end();
    // Otherwise the frozen └ reads as "about to happen" when ctrl-c means
    // it never will (#34 review footnote).
    expect(text()).toContain('\n  f6e5d4c3b2a1 built, never sounded (stopped before the wrap)\n');
  });

  it('quitting with nothing pending ends silently', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('4.1', 3000);
    d.end();
    expect(text()).not.toContain('never sounded');
    expect(text().endsWith('\n')).toBe(true);
  });

  it('quitting after a changed-back edit stays silent: nothing new was coming', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('4.1', 3000);
    d.queue(A, '/out/main.wav'); // same hash: the edit was reverted
    d.end();
    expect(text()).not.toContain('never sounded');
  });

  it('held positions flush as a plain pass boundary when no confirmation comes', () => {
    const { d, text } = harness();
    d.start('//songs/x/mix:main', A, '');
    d.position('12.4', 9000);
    d.queue(B, '/out/main.wav');
    d.position('1.1', 0);
    d.position('1.2', 240);
    d.position('1.3', 480); // third held beat: give up waiting, it was a plain wrap
    // '  [2] 1.3' is 9 columns; the tee column for this label is 26.
    const pad = ' '.repeat(17);
    expect(text()).toContain('  [2] 1.1');
    expect(text()).toContain(`  [2] 1.3${pad}└f6e5d4c3b2a1`); // still queued
  });
});

// A rebuild can finish before the session's own first load — the seeded
// baseline exists to report exactly that. What opens then is whatever the
// path holds, which is why the answer is a path comparison and not the
// snapshot the play's build took (#38 review P2).
describe('openingHash', () => {
  const held = { outputPath: '/out/mix/main.wav', sha256: B };

  it('takes the held hash when the rebuild landed at the path being loaded', () => {
    expect(openingHash('/out/mix/main.wav', A, held)).toBe(B);
  });

  it('keeps the snapshot when the path moved: a repoint left the old file loaded', () => {
    // field choose repoints a generation label at a different committed
    // file, so the load really did open the previous variant.
    expect(openingHash('/songs/creek/audio/gen1/1.wav', A, {
      outputPath: '/songs/creek/audio/gen1/2.wav',
      sha256: B,
    })).toBe(A);
  });

  it('keeps the snapshot when nothing was held', () => {
    expect(openingHash('/out/mix/main.wav', A, undefined)).toBe(A);
  });
});

describe('a rebuild that beats the first load', () => {
  it('opens on the successor, shows nothing pending, and never claims it went unheard', () => {
    // The reviewer's session: the rebuild landed at the stable output
    // path before the daemon opened it, so B is what sounds from beat
    // one. The block must open on B — then the reload we still send is
    // byte-identical to what plays, which renders as nothing pending,
    // keeps the block open, and leaves no `never sounded` claim about
    // the version that was audible the whole time (#38 review P2).
    const { d, text } = harness();
    d.start('//songs/creek/sound:long-96k', openingHash('/out/long-96k.wav', A, {
      outputPath: '/out/long-96k.wav',
      sha256: B,
    }), ' (Volt 476)');
    d.position('1.1', 0);
    d.queue(B, '/out/long-96k.wav');
    d.swapped('/out/long-96k.wav');
    d.position('1.2', 240);
    d.end();

    const t = text();
    expect(t).toContain('playing //songs/creek/sound:long-96k─f6e5d4c3b2a1 → (Volt 476)');
    expect(t).not.toContain('a1b2c3d4e5f6'); // the stale snapshot never appears
    expect(t).not.toContain('┬'); // nothing is pending: it is already playing
    expect(t).not.toContain('played'); // no phantom block for a zero-sample pass
    expect(t).not.toContain('never sounded');
  });
});
