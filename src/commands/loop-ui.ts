// The watch-loop display (watch.md §2): two live lines on a tty —
//
//   playing //songs/creek/mix:main@45a7b1c2d853 → (Volt 476)
//     [10] 8.4     (new version fa105f281f9b)
//
// The header carries what the daemon is looping; the position line
// carries the loop iteration, where in the pass it is, and the queued
// takeover while one is pending. When the swap lands at the wrap, the
// old block closes as history — `played …@old` with its final
// position — and a fresh block opens for the successor:
//
//   played //songs/creek/mix:main@45a7b1c2d853
//     [10] 12.4
//   playing //songs/creek/mix:main@fa105f281f9b → (Volt 476)
//     [1] 1.1
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
  private pass = 1;
  private lastAt: number | undefined;
  private posText = ''; // last bar.beat text, without pass/pending suffixes
  private onPositionLine = false;
  private buried = false; // a said() line sits between header and position
  private held: { line: string; at: number }[] = [];

  // `looping` gates the [N] iteration prefix: only a looping session has
  // iterations to count. Watch implies --loop today, so the CLI always
  // passes true; the flag keeps the renderer honest for any future
  // non-loop use.
  constructor(
    private readonly write: (chunk: string) => void,
    private readonly looping: boolean = true,
  ) {}

  start(label: string, sha256: string, note: string): void {
    this.label = label;
    this.note = note;
    this.hash = sha256;
    this.openBlock();
  }

  private writeHeader(): void {
    // The arrow reads "routed to" and only appears with a device to point
    // at — null-output sessions have none.
    this.write(
      `playing ${this.label}${this.hash ? `@${short(this.hash)}` : ''}${this.note ? ` →${this.note}` : ''}\n`,
    );
    this.buried = false;
    this.onPositionLine = false;
  }

  private openBlock(): void {
    this.writeHeader();
    this.pass = 1;
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

  // A plain line (diagnostics, a device move): closes the position line
  // and buries the header — the next swap opens a fresh block instead of
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
    if (at !== undefined && this.lastAt !== undefined && at < this.lastAt / 2) {
      if (this.pending !== undefined) {
        this.held.push({ line, at });
        if (this.held.length < MAX_HELD_POSITIONS) return;
        // No confirmation came: treat it as the plain wrap it was.
        const flush = this.held;
        this.held = [];
        this.pass++;
        this.lastAt = undefined;
        for (const p of flush) this.position(p.line, p.at);
        return;
      }
      this.pass++;
    }
    if (at !== undefined) this.lastAt = at;
    this.posText = line;
    this.render();
  }

  private passPrefix(): string {
    return this.looping ? `[${this.pass}] ` : '';
  }

  private render(): void {
    const pending =
      this.pending !== undefined ? `     (new version ${short(this.pending.sha256)})` : '';
    this.write(`\r\x1b[2K  ${this.passPrefix()}${this.posText}${pending}`);
    this.onPositionLine = true;
  }

  // A reload was accepted: the position line carries it until the wrap.
  // Latest wins, like the daemon's own queue.
  queue(sha256: string, path: string): void {
    this.pending = { sha256, path };
    if (this.onPositionLine) this.render();
  }

  // The queued reload failed after all — take the notice back down.
  dequeue(): void {
    this.pending = undefined;
    const flush = this.held;
    this.held = [];
    if (flush.length > 0) {
      this.pass++;
      this.lastAt = undefined;
      for (const p of flush) this.position(p.line, p.at);
    } else if (this.onPositionLine) {
      this.render();
    }
  }

  // The takeover sounded: close the old block as history, open the new.
  // The daemon says which path took over; our queued hash is claimed
  // only when it matches — otherwise someone else's reload won, and the
  // header opens hashless rather than confidently wrong.
  swapped(path: string): void {
    const old = this.hash;
    this.hash = this.pending?.path === path ? this.pending.sha256 : '';
    this.pending = undefined;
    if (this.onPositionLine && !this.buried) {
      // Rewrite the header one line up to `played`, freeze the position
      // line at the pass's final beat, and fall through to a new block.
      this.write(`\r\x1b[1A\x1b[2Kplayed ${this.label}${old ? `@${short(old)}` : ''}\n`);
      this.write(`\x1b[2K  ${this.passPrefix()}${this.posText}\n`);
    } else {
      if (this.onPositionLine) this.write('\n');
      this.write(`played ${this.label}${old ? `@${short(old)}` : ''}\n`);
    }
    this.onPositionLine = false;
    this.openBlock();
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
