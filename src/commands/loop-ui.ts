// The watch-loop display (watch.md §2): two live lines on a tty —
//
//   playing //songs/creek/mix:main┬45a7b1c2d853 → (Volt 476)
//     [10] 8.4                    └fa105f281f9b
//
// The header carries what the daemon is looping; the position line
// carries the loop iteration and where in the pass it is. While a
// takeover is pending the separator becomes a tee, and the successor's
// hash hangs └ beneath the one it will replace. When the swap sounds
// at the wrap, the old block closes as history — `played …─old` with
// its final position — and a fresh block opens for the successor:
//
//   played //songs/creek/mix:main─45a7b1c2d853
//     [10] 12.4
//   playing //songs/creek/mix:main─fa105f281f9b → (Volt 476)
//     [1] 1.1
//
// Two invisibilities are deliberate: a pending hash equal to the
// playing one (the edit was changed back) renders as nothing pending —
// ─ separator, no └ — and the byte-identical swap that follows keeps
// the block open; audibly it is just another pass, so it counts as one.
//
// Rendering is a pure function of the calls below over an injected
// write, so the exact byte stream (ANSI included) is unit-testable.
// Non-tty sessions never construct one of these — the CLI prints plain
// sequential lines instead.

const short = (sha256: string): string => sha256.slice(0, 12);

// Positions arriving after a wrap while a takeover is pending belong to
// the successor; they are held until the daemon's `reloaded` confirms
// (normally the same heartbeat batch). If confirmation never comes —
// the reload raced a teardown, say — a few held beats flush as a plain
// pass boundary rather than freezing the display.
const MAX_HELD_POSITIONS = 3;

export interface LoopDisplayOptions {
  // Gates the [N] iteration prefix: only a looping session has
  // iterations to count. Watch implies --loop today, so the CLI always
  // passes true; the flag keeps the renderer honest for any future
  // non-loop use.
  looping?: boolean;
  // The --from region loop: passes come from pass() (the CLI reloads
  // each one), never from position regression — a region's positions
  // restart at the region start, not zero, so the wrap heuristic does
  // not apply. Swaps land at pass boundaries, so there is no daemon
  // `reloaded` to hold positions for either.
  requeue?: boolean;
  // Live terminal width. Cursor-up repaints assume the header occupies
  // exactly one screen row; a header wider than the terminal wraps onto
  // several, so repaints fall back to fresh lines (#37 review P3), and
  // the position line is truncated rather than allowed to wrap.
  columns?: () => number;
}

export class LoopDisplay {
  private label = '';
  private note = ''; // ' (Volt 476)' — the daemon-status suffix from onItem
  private hash = '';
  // The reload we sent: hash for the display, path for correlating the
  // daemon's answer — the takeover that sounds may not be ours (#36
  // review: a reload from another shell wins latest-wins, and stamping
  // the new block with our hash would be confidently wrong about what
  // is playing).
  private pending: { sha256: string; path: string } | undefined;
  private iteration = 1;
  private lastAt: number | undefined;
  private posText = ''; // last bar.beat text, without pass/pending suffixes
  private onPositionLine = false;
  private buried = false; // a said() line sits between header and position
  private headerRewritable = false; // header fits one screen row
  private held: { line: string; at: number }[] = [];
  private readonly looping: boolean;
  private readonly requeue: boolean;
  private readonly columns: () => number;

  constructor(
    private readonly write: (chunk: string) => void,
    options: LoopDisplayOptions = {},
  ) {
    this.looping = options.looping ?? true;
    this.requeue = options.requeue ?? false;
    this.columns = options.columns ?? (() => 200);
  }

  // The getter is not trusted: a pty with no window size reports
  // isTTY=true and columns=0 (the expect-harness family), and 0 would
  // make slice(0, -1) eat the last character of every row — an
  // 11-character hash matches nothing you could grep for (#37 review).
  private width(): number {
    const cols = this.columns();
    return Number.isFinite(cols) && cols > 0 ? cols : 200;
  }

  start(label: string, sha256: string, note: string): void {
    this.label = label;
    this.note = note;
    this.hash = sha256;
    if (this.onPositionLine) {
      this.write('\n');
      this.onPositionLine = false;
    }
    this.openBlock();
  }

  // The label─hash separator is state: ┬ while a different version hangs
  // pending beneath it (the position line's └ connects to it), ─ when
  // what you hear is the only version there is. The arrow reads "routed
  // to" and only appears with a device to point at — null-output
  // sessions have none. `played` history never shows ┬.
  private headerLine(verb: 'playing' | 'played', hash: string): string {
    const tee =
      verb === 'playing' && this.pending !== undefined && this.pending.sha256 !== this.hash;
    const sep = tee ? '┬' : '─';
    const route = verb === 'playing' && this.note ? ` →${this.note}` : '';
    return `${verb} ${this.label}${hash ? `${sep}${short(hash)}` : ''}${route}`;
  }

  private writeHeader(): void {
    const line = this.headerLine('playing', this.hash);
    this.headerRewritable = line.length < this.width();
    this.write(`${line}\n`);
    this.buried = false;
    this.onPositionLine = false;
  }

  // \x1b[1A moves one screen row, which reaches the header only when it
  // occupies one — never when it wrapped, and never through said lines.
  private canRewriteHeader(): boolean {
    return !this.buried && this.headerRewritable;
  }

  // Pending state changed: the header's separator and the position
  // line's └ must move together. With the header out of reach, the └
  // line alone tells the story.
  private repaintBlock(): void {
    if (!this.canRewriteHeader()) {
      if (this.onPositionLine) this.render();
      return;
    }
    const line = this.headerLine('playing', this.hash);
    this.headerRewritable = line.length < this.width();
    this.write(`\r\x1b[1A\x1b[2K${line}\n`);
    if (this.onPositionLine || this.posText !== '') this.render();
  }

  private openBlock(): void {
    this.writeHeader();
    this.iteration = 1;
    this.lastAt = undefined;
    this.posText = '';
  }

  // The output moved (default-follow, a vanished device): repeat the
  // header with the new route so every line reads alike. Same block —
  // the loop didn't restart, so the pass counter and position axis
  // carry straight on.
  deviceMoved(name: string): void {
    this.note = ` (${name})`;
    if (this.onPositionLine) this.write('\n');
    this.writeHeader();
  }

  // A plain line (diagnostics, an error): closes the position line and
  // buries the header — the next swap opens a fresh block instead of
  // rewriting history it can no longer reach.
  say(line: string): void {
    if (this.onPositionLine) {
      this.write('\n');
      this.onPositionLine = false;
    }
    this.write(`${line}\n`);
    this.buried = true;
  }

  position(line: string, at?: number): void {
    // A wrap is a return to the top, not any backwards motion: switching
    // output devices recomputes the transport's resample ratio and can
    // step the reported position slightly back, which must not count a
    // phantom pass. Half the last position is comfortably below any
    // ratio jitter and comfortably above a real wrap's landing point.
    // Requeue sessions count passes from pass(), never from here.
    // [N] is approximate below ~2 heartbeats by construction (#37 review
    // footnote): positions sample every 250 ms, so wraps landing between
    // samples are invisible — a 0.2 s loop wraps ~35 times in 7 s and
    // shows a handful. Not a counting bug; there is nothing to count from.
    if (!this.requeue && at !== undefined && this.lastAt !== undefined && at < this.lastAt / 2) {
      if (this.pending !== undefined) {
        this.held.push({ line, at });
        // No confirmation after a few beats: it was the plain wrap it
        // looked like.
        if (this.held.length >= MAX_HELD_POSITIONS) this.flushHeldAsPassBoundary();
        return;
      }
      this.iteration++;
    }
    if (at !== undefined) this.lastAt = at;
    this.posText = line;
    this.render();
  }

  private passPrefix(): string {
    return this.looping ? `[${this.iteration}] ` : '';
  }

  private render(): void {
    const base = `  ${this.passPrefix()}${this.posText}`;
    let pending = '';
    if (this.pending !== undefined && this.pending.sha256 !== this.hash) {
      // └<hash> hangs directly under the header's ┬<hash> — right where
      // the successor will land. A pending hash equal to the playing one
      // is an edit changed back: nothing new is coming, show nothing.
      // Alignment yields before information does: when the aligned column
      // would push the hash past the row, the marker packs down to a
      // single space instead — the compact form fits long after the
      // pretty one doesn't (#37 review).
      const column = 'playing '.length + this.label.length;
      const marker = `└${short(this.pending.sha256)}`;
      const aligned = Math.max(1, column - base.length);
      const pad = base.length + aligned + marker.length < this.width() ? aligned : 1;
      pending = `${' '.repeat(pad)}${marker}`;
    }
    // Truncated to one screen row: the \r rewrite only reaches the row
    // the cursor is on.
    this.write(`\r\x1b[2K${`${base}${pending}`.slice(0, this.width() - 1)}`);
    this.onPositionLine = true;
  }

  // A reload was accepted: the block carries it until the wrap — ┬ on
  // the header, └<hash> beneath. Latest wins, like the daemon's own
  // queue; a pending hash equal to the playing one (the edit was changed
  // back) renders as nothing pending at all.
  queue(sha256: string, path: string): void {
    this.pending = { sha256, path };
    this.repaintBlock();
  }

  // Held wrap positions were a plain pass boundary after all: count the
  // pass and replay them.
  private flushHeldAsPassBoundary(): void {
    const flush = this.held;
    this.held = [];
    if (flush.length === 0) return;
    this.iteration++;
    this.lastAt = undefined;
    for (const p of flush) this.position(p.line, p.at);
  }

  // The queued reload failed after all — take the notice back down.
  dequeue(): void {
    this.pending = undefined;
    if (this.held.length > 0) this.flushHeldAsPassBoundary();
    else this.repaintBlock();
  }

  // Close the current block as `played` history and open the successor's.
  private transition(newHash: string): void {
    const old = this.hash;
    this.hash = newHash;
    if (this.onPositionLine && this.canRewriteHeader()) {
      // Rewrite the header one line up to `played`, freeze the position
      // line at the pass's final beat, and fall through to a new block.
      this.write(`\r\x1b[1A\x1b[2K${this.headerLine('played', old)}\n`);
      this.write(`\x1b[2K  ${this.passPrefix()}${this.posText}\n`);
    } else {
      if (this.onPositionLine) this.write('\n');
      this.write(`${this.headerLine('played', old)}\n`);
    }
    this.onPositionLine = false;
    this.openBlock();
  }

  // A requeue pass boundary (--from): the CLI reloads every pass, so the
  // pass IS the swap moment. The pass that loads what we queued opens
  // the successor's block; any other pass just counts (#37 review P2:
  // the display must never restart the block with a stale hash).
  pass(loadedPath: string): void {
    if (this.pending !== undefined && this.pending.path === loadedPath) {
      const ours = this.pending.sha256;
      this.pending = undefined;
      if (ours !== this.hash) {
        this.transition(ours);
        return;
      }
      // changed back: fall through — audibly just another pass
    }
    this.iteration++;
    this.lastAt = undefined;
  }

  // The takeover sounded (native loop): close the old block as history,
  // open the new. The daemon says which path took over; our queued hash
  // is claimed only when it matches — otherwise someone else's reload
  // won, and the header opens hashless rather than confidently wrong.
  swapped(path: string): void {
    const ours = this.pending?.path === path ? this.pending.sha256 : undefined;
    this.pending = undefined;
    if (ours !== undefined && ours === this.hash) {
      // The edit was changed back before the wrap: the daemon swapped to
      // byte-identical content. Audibly just another pass — the block
      // stays open and the wrap counts as one.
      this.flushHeldAsPassBoundary();
      return;
    }
    this.transition(ours ?? '');
    const flush = this.held;
    this.held = [];
    for (const p of flush) this.position(p.line, p.at);
  }

  // Session over: leave the cursor on a fresh line.
  end(): void {
    if (this.onPositionLine) {
      this.write('\n');
      this.onPositionLine = false;
    }
  }
}
