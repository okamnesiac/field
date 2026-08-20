import { useEffect, useRef, useState } from 'react';

// The first face (ui.md): transport and flat lanes over the files. The
// view renders server truth; local state exists only inside a gesture —
// a fader follows the pointer and the file write lands on release, after
// which the snapshot the server pushes is what the control believes.

interface Lane {
  entry: number;
  kind: 'track' | 'audio' | 'other';
  name: string;
  gain_db: number;
  pan: number;
  mute: boolean;
  canSolo: boolean;
  inserts: string[];
}

interface Snapshot {
  type: 'snapshot';
  song: string;
  lanes: Lane[];
  file: { path: string; sha256: string };
  soloed: string | null;
  // Mirrors devicesResponseSchema: a device is {name, default}, not a
  // bare string. Getting this wrong rendered an object as a React child
  // and blanked the whole window.
  devices: { devices: { name: string; default: boolean }[]; null_output: boolean };
  status: {
    state: string;
    sample: number;
    samples: number;
    musical: string;
    device?: { name: string; sample_rate: number };
  };
}

type Down =
  | Snapshot
  | { type: 'event'; event: { event: string; state?: string; sample?: number; name?: string }; musical?: string }
  | { type: 'error'; message: string };

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
      {error && <div className="error">{error}</div>}
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
