import { useEffect, useRef, useState } from 'react';

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
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  // The gesture's own state: entry index -> value while dragging.
  const [drag, setDrag] = useState<Record<number, number>>({});

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
        setPosition(msg.status.musical);
        setError(null);
      } else if (msg.type === 'event') {
        if (msg.event.event === 'state' && msg.event.state) setState(msg.event.state);
        if (msg.event.event === 'position' && msg.musical) setPosition(msg.musical);
      } else if (msg.type === 'error') {
        setError(msg.message);
      }
    };
    socket.onclose = () => setError('server closed — restart field ui and reload');
    return () => socket.close();
  }, []);

  const send = (msg: unknown) => ws.current?.send(JSON.stringify(msg));
  const edit = (entry: number, set: Record<string, unknown>) =>
    snap && send({ type: 'edit', sha256: snap.file.sha256, entry, set });

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

  return (
    <main>
      <header>
        <span className="song">{snap.song}</span>
        <button onClick={() => send({ type: state === 'playing' ? 'pause' : 'play' })}>
          {state === 'playing' ? '⏸' : '▶'}
        </button>
        <button onClick={() => send({ type: 'stop' })}>⏹</button>
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
      <section className="lanes">
        {snap.lanes.map((lane) => {
          const gain = drag[lane.entry] ?? lane.gain_db;
          const soloedHere = snap.soloed === lane.name;
          const dimmed = snap.soloed !== null && !soloedHere;
          return (
            <div key={lane.entry} className={`lane ${lane.mute ? 'muted' : ''} ${dimmed ? 'dimmed' : ''}`}>
              <span className="name" title={lane.kind}>
                {lane.name}
              </span>
              <button
                className={`mute ${lane.mute ? 'on' : ''}`}
                title="mute (writes mute: to the placement)"
                onClick={() => edit(lane.entry, { mute: !lane.mute })}
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
                onChange={(e) => setDrag({ ...drag, [lane.entry]: Number(e.target.value) })}
                onPointerUp={() => {
                  if (drag[lane.entry] !== undefined) {
                    edit(lane.entry, { gain_db: drag[lane.entry] });
                    setDrag(({ [lane.entry]: _done, ...rest }) => rest);
                  }
                }}
              />
              <span className="db">{gain > 0 ? `+${gain}` : gain} dB</span>
              <input
                className="pan"
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={lane.pan}
                onChange={(e) => edit(lane.entry, { pan: Number(e.target.value) })}
                title="pan"
              />
              {lane.inserts.length > 0 && <span className="inserts">{lane.inserts.join(' → ')}</span>}
            </div>
          );
        })}
      </section>
      <footer>
        {snap.file.path} — files are the source of truth; edits land as YAML diffs
      </footer>
    </main>
  );
}
