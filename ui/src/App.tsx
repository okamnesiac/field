import { useEffect, useRef, useState } from 'react';
// The engine's own tempo arithmetic, imported rather than reimplemented:
// pure functions over the event arrays the snapshot carries, so the
// view's bars and the CLI's cannot disagree.
import { MeterMap, TempoMap } from '../../src/time/tempo.js';
import { laneAt, Timeline } from './Timeline.js';
import { Inserts } from './Inserts.js';

// The first face (ui.md): transport and flat lanes over the files. The
// view renders server truth; local state exists only inside a gesture —
// a fader follows the pointer and the file write lands on release, after
// which the snapshot the server pushes is what the control believes.

// The wire shapes come from the server rather than being restated
// here. This file's own copy said `devices: string[]` where the daemon
// sends `{name, default}` objects, and rendering an object as a child
// blanked the whole window — a mistake no compiler could see, because
// two independent declarations cannot disagree with each other. Type-only,
// so none of the server's code is bundled: the import erases at build.
import type { UiSnapshot, UiDown } from '../../src/commands/ui-protocol.js';

type Snapshot = UiSnapshot;
type Down = UiDown;

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [state, setState] = useState('stopped');
  const [position, setPosition] = useState('');
  const [playSample, setPlaySample] = useState(0);
  // The playhead the view runs itself: the last sample the daemon
  // reported and when it arrived. Between reports the position is that
  // sample plus however long ago it landed — which is what makes the
  // readout move at frame rate instead of four times a second.
  const anchor = useRef<{ sample: number; at: number } | null>(null);
  // Bumped whenever the anchor moves, so a stopped playhead redraws once
  // without a frame loop running behind it.
  const [anchorMoves, setAnchorMoves] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  // The gesture's own state: entry index -> value while dragging.
  // A fader's value while it moves, keyed by the placement it writes:
  // the owner file and the entry's index in it. An index alone repeats
  // across files, so a child row could pick up another file's value.
  const [drag, setDrag] = useState<Record<string, number>>({});
  // The selected clip, by tree path. The timeline writes it; the
  // inserts panel reads the lane it names. A path rather than a lane
  // object, so every snapshot re-resolves to current values.
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    // The shell passes the token on the URL exactly as the printed link
    // does, so both entry points authenticate the same way.
    const token = new URLSearchParams(location.search).get('t') ?? '';
    if (!token) {
      setError('no session token in the URL — open the link field ui printed, or relaunch it');
      return;
    }
    const socket = new WebSocket(`ws://${location.host}/ws?t=${token}`);
    ws.current = socket;
    socket.onerror = () =>
      setError(`could not reach the field ui server at ${location.host} — is it still running?`);
    socket.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as Down;
      if (msg.type === 'snapshot') {
        setSnap(msg);
        setState(msg.status.state);
        anchor.current = { sample: msg.status.sample, at: performance.now() };
        setAnchorMoves((n) => n + 1);
        setPosition(msg.status.musical);
        setError(null);
      } else if (msg.type === 'event') {
        if (msg.event.event === 'state' && msg.event.state) setState(msg.event.state);
        // Resync the anchor rather than printing the string: the
        // daemon's sample is truth, and the frame loop below spells it.
        if (msg.event.event === 'position' && typeof msg.event.sample === 'number') {
          anchor.current = { sample: msg.event.sample, at: performance.now() };
          setAnchorMoves((n) => n + 1);
          // The server spells each position for a song with no tempo
          // map; with one, the frame loop below overwrites this.
          if (msg.musical !== undefined) setPosition(msg.musical);
        }
      } else if (msg.type === 'error') {
        setError(msg.message);
      }
    };
    socket.onclose = () => setError('server closed — restart field ui and reload');
    return () => socket.close();
  }, []);


  // Runs the playhead at the display's rate off the anchor while the
  // transport plays, and not at all otherwise: a paused transport has a
  // fixed position, and a rAF loop spinning behind a still clock is the
  // kind of idle cost a machine with a hundred things open should not
  // pay. While stopped, each anchor move draws one frame. A song with no
  // tempo map still moves its playhead, at the session's rate, and its
  // readout is the server's spelling of each position event.
  const clock = snap?.clock;
  const rate = clock?.sampleRate ?? snap?.timeline?.rate;
  useEffect(() => {
    if (rate === undefined) return;
    const tempo = clock ? new TempoMap(clock.tempo, clock.sampleRate) : undefined;
    const meter = clock ? new MeterMap(clock.meter) : undefined;
    let frame = 0;
    const tick = () => {
      const a = anchor.current;
      if (a) {
        const elapsed = state === 'playing' ? (performance.now() - a.at) / 1000 : 0;
        const sample = a.sample + elapsed * rate;
        if (tempo !== undefined && meter !== undefined) {
          const seconds = sample / rate;
          const mins = Math.floor(seconds / 60);
          const secs = (seconds - mins * 60).toFixed(1).padStart(4, '0');
          setPosition(`${meter.format(Math.round(tempo.samplesToTicks(sample)))} (${mins}:${secs})`);
        }
        setPlaySample(sample);
      }
      if (state === 'playing') frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [clock, rate, state, anchorMoves]);

  const send = (msg: unknown) => ws.current?.send(JSON.stringify(msg));

  // The selected lane, resolved fresh from the snapshot; and whether
  // the playhead is strictly inside its window, which is what a split
  // needs — a cut at either edge would leave a zero-length half.
  const selLane = selected && snap?.timeline ? laneAt(snap.timeline.lanes, selected) : null;
  const canSplit =
    selLane !== null &&
    playSample > selLane.start &&
    playSample < selLane.start + selLane.duration;
  const split = () => {
    if (!canSplit || selLane === null) return;
    send({
      type: 'split',
      file: selLane.file,
      sha256: selLane.sha256,
      entry: selLane.entry,
      offset: Math.round(playSample - selLane.start),
    });
  };
  // The keyboard reaches split through a ref so the keydown listener —
  // bound once per transport state — always sees the current playhead.
  const splitRef = useRef(split);
  splitRef.current = split;

  // Space is the transport, as in every DAW, unless focus is somewhere
  // that types: a text field, or the device picker, which opens on it.
  // Everywhere else, a focused button included, space plays or pauses
  // and the browser's own default — pressing the focused button, or
  // scrolling — is cancelled on both key events, since a button presses
  // on key-up. Otherwise space after "+ reverb" would add a second one.
  const typesHere = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    if (target.tagName !== 'INPUT') return false;
    const type = (target as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(type);
  };
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typesHere(e.target)) e.preventDefault();
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        splitRef.current();
        return;
      }
      if (e.code !== 'Space' || typesHere(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      send({ type: state === 'playing' ? 'pause' : 'play' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  // An edit addresses the file its placement lives in: main.yaml for a
  // top-level lane, the placing track's own file for a child row.
  const edit = (lane: { file: string; sha256: string; entry: number }, set: Record<string, unknown>) =>
    send({ type: 'edit', file: lane.file, sha256: lane.sha256, entry: lane.entry, set });

  // Never a bare blank: before the first snapshot the page says what it
  // is waiting for, and any connection failure replaces that with the
  // reason rather than leaving the wait looking like a hung window.
  if (!snap) {
    return (
      <main className="empty">
        <h1>field</h1>
        {error ? <div className="error">{error}</div> : <p>connecting to the session…</p>}
      </main>
    );
  }


  // One lane's controls, for either a top-level lane or a child row —
  // the timeline places them in its header column.
  const laneControls = (lane: import('../../src/commands/ui-protocol.js').UiTimelineLane) => {
    const key = `${lane.file}#${lane.entry}`;
    const gain = drag[key] ?? lane.gain_db;
    // One write when the gesture ends, by pointer or by arrow keys.
    const release = () => {
      if (drag[key] !== undefined) {
        edit(lane, { gain_db: drag[key] });
        setDrag(({ [key]: _done, ...rest }) => rest);
      }
    };
    const soloedHere = snap.soloed === lane.name;
    const dimmed = snap.soloed !== null && !soloedHere;
    // Two rows, not one: the name above, the controls below. One row
    // was wider than the header column, and the fader spilled over the
    // waveform beside it.
    return (
      <div className={`lane ${lane.mute ? 'muted' : ''} ${dimmed ? 'dimmed' : ''}`}>
        <span className="name" title={lane.file}>{lane.name}</span>
        <div className="lane-ctl">
          <button
            className={`mute ${lane.mute ? 'on' : ''}`}
            title="mute (writes mute: on this placement)"
            onClick={() => edit(lane, { mute: !lane.mute })}
          >
            M
          </button>
          {lane.canSolo && (
            <button
              className={`solo ${soloedHere ? 'on' : ''}`}
              title="solo (session-only: an alternate feed, nothing written)"
              onClick={() => send({ type: 'solo', track: soloedHere ? null : lane.name })}
            >
              S
            </button>
          )}
          <input
            className="gain"
            type="range"
            min={-60}
            max={12}
            step={0.5}
            value={gain}
            onChange={(e) => setDrag({ ...drag, [key]: Number(e.target.value) })}
            onPointerUp={release}
            onKeyUp={release}
          />
          <span className="db">{gain > 0 ? `+${gain}` : gain}</span>
          </div>
      </div>
    );
  };

  return (
    <main>
      <header>
        <span className="song">{snap.song}</span>
        <button onClick={() => send({ type: state === 'playing' ? 'pause' : 'play' })}>
          {state === 'playing' ? '⏸' : '▶'}
        </button>
        <button onClick={() => send({ type: 'stop' })}>⏹</button>
        <button
          onClick={split}
          disabled={!canSplit}
          title="split the selected clip at the playhead (Ctrl+E)"
        >
          ✂
        </button>
        <span className={`state ${state}`}>{state}</span>
        <span className="position">{position}</span>
        <select
          value={snap.status.device?.name ?? snap.devices.devices.find((d) => d.default)?.name ?? ''}
          onChange={(e) => send({ type: 'device', name: e.target.value })}
          title={snap.devices.null_output ? 'null output: no device is being driven' : 'output device'}
        >
          {snap.devices.devices.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
              {d.default ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </header>
      {error && (
        // Dismissible, and never in the way: an error here is a report
        // about one failed operation, not a state the whole window has
        // to sit in — the controls behind it still work.
        <div className="error">
          <span>{error}</span>
          <button className="dismiss" onClick={() => setError(null)} title="dismiss">
            ×
          </button>
        </div>
      )}
      {/* The timeline lays the lane controls out as its header column, so
          a lane's fader sits on the lane's own row. */}
      <Timeline
        snap={snap}
        playSample={playSample}
        selected={selected}
        onSelect={setSelected}
        onLocate={(sample) => {
          // Optimistic: the click already says where, so the playhead
          // moves now and the daemon's next report corrects it. Waiting
          // for the round trip is what makes a transport feel dead.
          setPlaySample(sample);
          anchor.current = { sample, at: performance.now() };
          send({ type: 'locate', sample });
        }}
        onMove={(lane, delta) =>
          send({ type: 'move', file: lane.file, sha256: lane.sha256, entry: lane.entry, delta })
        }
        onStretch={(lane, edge, offset) =>
          send({
            type: 'stretch',
            file: lane.file,
            sha256: lane.sha256,
            entry: lane.entry,
            edge,
            offset,
          })
        }
        controls={laneControls}
      />
      {selLane && selLane.trackFile !== null ? (
        <Inserts
          lane={selLane}
          sampleRate={snap.clock?.sampleRate ?? snap.timeline?.rate ?? 48000}
          send={send}
        />
      ) : null}
      <footer>
        {snap.file.path} — files are the source of truth; edits land as YAML diffs
      </footer>
    </main>
  );
}
