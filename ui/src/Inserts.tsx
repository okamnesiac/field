import { useMemo, useRef, useState } from 'react';
import type { UiInsert, UiTimelineLane } from '../../src/commands/ui-protocol.js';
import { autoGainDb, responseDb, type EqBandLike } from './eq-math.js';

// The plugins panel: the selected lane's insert chain, at the bottom of
// the window. Selection already exists for moving clips; this gives it
// a second meaning — the chain shown is the selected track's — so the
// panel needs no chooser of its own.
//
// Edits follow the fader's contract: local state exists only inside a
// gesture, the file write lands on release, and the snapshot the server
// pushes is what the controls believe afterwards. Every op speaks to
// the track file under its own hash (lane.trackFile / trackSha256).
//
// The EQ editor draws its curve and its compensation readout from
// eq-math.ts, the engine's own arithmetic ported line-for-line — the
// picture is the render's numbers, not a lookalike. Handles drag in
// gain and frequency; bandwidth and type sit in the band strip below,
// because two axes is what a drag has.

const EFFECTS = ['eq', 'limit', 'reverb', 'plate', 'hall'] as const;

// Knob ranges, mirrored from schema/effects.ts. The schema stays the
// authority — the server revalidates every write against it — these
// only shape the sliders.
const KNOBS: Record<string, { key: string; min: number; max: number; step: number }[]> = {
  limit: [
    { key: 'ceiling_db', min: -24, max: 0, step: 0.1 },
    { key: 'lookahead_ms', min: 0.1, max: 50, step: 0.1 },
    { key: 'release_ms', min: 1, max: 2000, step: 1 },
  ],
  reverb: [
    { key: 'mix', min: 0, max: 1, step: 0.01 },
    { key: 'decay', min: 0.05, max: 30, step: 0.05 },
    { key: 'predelay_ms', min: 0, max: 500, step: 1 },
    { key: 'damping', min: 0, max: 1, step: 0.01 },
  ],
  plate: [
    { key: 'mix', min: 0, max: 1, step: 0.01 },
    { key: 'decay', min: 1, max: 30, step: 0.05 },
    { key: 'predelay_ms', min: 0, max: 500, step: 1 },
    { key: 'damping', min: 0, max: 1, step: 0.01 },
    { key: 'diffusion', min: 0, max: 0.93, step: 0.01 },
    { key: 'modulation', min: 0, max: 1, step: 0.01 },
  ],
  hall: [
    { key: 'mix', min: 0, max: 1, step: 0.01 },
    { key: 'decay', min: 1, max: 30, step: 0.05 },
    { key: 'decay_low', min: 0.1, max: 4, step: 0.05 },
    { key: 'decay_high', min: 0.1, max: 4, step: 0.05 },
    { key: 'size', min: 0.1, max: 1, step: 0.01 },
    { key: 'predelay_ms', min: 0, max: 500, step: 1 },
    { key: 'diffusion', min: 0, max: 0.93, step: 0.01 },
    { key: 'modulation', min: 0, max: 1, step: 0.01 },
    { key: 'width', min: 0, max: 1, step: 0.01 },
  ],
};

interface Props {
  lane: UiTimelineLane;
  sampleRate: number;
  send: (msg: unknown) => void;
}

export function Inserts({ lane, sampleRate, send }: Props) {
  const file = lane.trackFile;
  const sha = lane.trackSha256;
  if (file === null || sha === null || lane.inserts === null) return null;
  const op = (msg: Record<string, unknown>) => send({ ...msg, file, sha256: sha });
  return (
    <div className="ins">
      <div className="ins-head">
        <span className="ins-track">{lane.name}</span>
        <span className="ins-path">{file}</span>
        <span className="ins-add">
          {EFFECTS.map((e) => (
            <button key={e} onClick={() => op({ type: 'insert-add', effect: e })}>
              + {e}
            </button>
          ))}
        </span>
      </div>
      {lane.inserts.length === 0 && <div className="ins-none">no inserts — add one above</div>}
      {lane.inserts.map((ins) => (
        <Insert key={ins.entry} ins={ins} sampleRate={sampleRate} op={op} />
      ))}
    </div>
  );
}

function Insert({
  ins,
  sampleRate,
  op,
}: {
  ins: UiInsert;
  sampleRate: number;
  op: (msg: Record<string, unknown>) => void;
}) {
  return (
    <div className="ins-row">
      <div className="ins-title">
        <span className="ins-name">{ins.effect}</span>
        <button
          className="ins-remove"
          title="remove this insert"
          onClick={() => op({ type: 'insert-remove', entry: ins.entry })}
        >
          ×
        </button>
      </div>
      {ins.effect === 'eq' ? (
        <EqEditor ins={ins} sampleRate={sampleRate} op={op} />
      ) : ins.effect === 'plugin' ? (
        <div className="ins-none">a hosted plugin — its own editor owns these knobs</div>
      ) : (
        <Knobs ins={ins} op={op} />
      )}
    </div>
  );
}

// Generic parameter strip: one slider per knob, committed on release.
function Knobs({ ins, op }: { ins: UiInsert; op: (msg: Record<string, unknown>) => void }) {
  const [drag, setDrag] = useState<Record<string, number>>({});
  const knobs = KNOBS[ins.effect] ?? [];
  return (
    <div className="ins-knobs">
      {knobs.map(({ key, min, max, step }) => {
        const value = drag[key] ?? Number(ins.params[key] ?? 0);
        return (
          <label key={key} className="knob">
            <span className="knob-name">{key.replace(/_/g, ' ')}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(e) => setDrag({ ...drag, [key]: Number(e.target.value) })}
              onPointerUp={() => {
                if (drag[key] !== undefined) {
                  op({ type: 'insert-edit', entry: ins.entry, set: { [key]: drag[key] } });
                  setDrag(({ [key]: _done, ...rest }) => rest);
                }
              }}
            />
            <span className="knob-value">{value}</span>
          </label>
        );
      })}
    </div>
  );
}

// The EQ editor. The curve area is gain (±24 dB) against log frequency
// (20 Hz–20 kHz); each band is a handle dragged in both. The strip
// below the curve carries what the drag cannot: type, bandwidth, and
// removal, for the band last touched.
const FMIN = 20;
const FMAX = 20000;
const DBMAX = 24;
const W = 560;
const H = 150;

function EqEditor({
  ins,
  sampleRate,
  op,
}: {
  ins: UiInsert;
  sampleRate: number;
  op: (msg: Record<string, unknown>) => void;
}) {
  const saved = ins.params['bands'] as EqBandLike[];
  // The gesture's own bands: null when idle, the whole array while a
  // handle drags — one write on release, like the fader.
  const [draft, setDraft] = useState<EqBandLike[] | null>(null);
  const [picked, setPicked] = useState(0);
  const grab = useRef<{ index: number } | null>(null);
  const bands = draft ?? saved;
  const normalize = ins.params['normalize'] !== false;

  const fx = (f: number) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
  const xf = (x: number) => FMIN * Math.pow(FMAX / FMIN, Math.min(1, Math.max(0, x / W)));
  const gy = (db: number) => H / 2 - (db / DBMAX) * (H / 2);
  const yg = (y: number) => ((H / 2 - y) / (H / 2)) * DBMAX;

  const curve = useMemo(() => {
    const pts = responseDb(bands, sampleRate, 160);
    return pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p.frequency).toFixed(1)},${gy(p.db).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bands, sampleRate]);
  const compensation = useMemo(
    () => (normalize ? autoGainDb(bands, sampleRate) : 0),
    [bands, normalize, sampleRate],
  );

  const commit = (next: EqBandLike[]) => {
    op({ type: 'insert-edit', entry: ins.entry, set: { bands: next } });
    setDraft(null);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = grab.current;
    if (!g) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const y = ((e.clientY - box.top) / box.height) * H;
    setDraft((d) => {
      const base = d ?? saved;
      return base.map((b, i) =>
        i === g.index
          ? {
              ...b,
              frequency: Math.round(xf(x)),
              // Pass filters have no gain to drag; frequency is theirs.
              ...(b.type === 'highpass' || b.type === 'lowpass'
                ? {}
                : { gain_db: Math.round(Math.max(-DBMAX, Math.min(DBMAX, yg(y))) * 2) / 2 }),
            }
          : b,
      );
    });
  };

  const band = bands[Math.min(picked, bands.length - 1)]!;
  const setBand = (patch: Partial<EqBandLike>) => {
    const next = bands.map((b, i) => (i === picked ? { ...b, ...patch } : b));
    commit(next);
  };

  return (
    <div className="eq">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="eq-view"
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          if (grab.current !== null && draft !== null) commit(draft);
          grab.current = null;
        }}
        onPointerLeave={() => {
          if (grab.current !== null && draft !== null) commit(draft);
          grab.current = null;
        }}
      >
        {/* Grid: octaves and 6 dB lines, quiet. */}
        {[100, 1000, 10000].map((f) => (
          <line key={f} x1={fx(f)} y1={0} x2={fx(f)} y2={H} className="eq-grid" />
        ))}
        {[-12, 0, 12].map((db) => (
          <line key={db} x1={0} y1={gy(db)} x2={W} y2={gy(db)} className={db === 0 ? 'eq-zero' : 'eq-grid'} />
        ))}
        <path d={curve} className="eq-curve" />
        {bands.map((b, i) => (
          <circle
            key={i}
            cx={fx(b.frequency)}
            cy={gy(b.type === 'highpass' || b.type === 'lowpass' ? 0 : (b.gain_db ?? 0))}
            r={7}
            className={`eq-handle ${i === picked ? 'picked' : ''}`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              grab.current = { index: i };
              setPicked(i);
            }}
          />
        ))}
      </svg>
      <div className="eq-strip">
        <select value={band.type} onChange={(e) => setBand({ type: e.target.value })}>
          {['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <span className="knob-name">{Math.round(band.frequency)} Hz</span>
        <label className="knob">
          <span className="knob-name">width</span>
          <input
            type="range"
            min={0.1}
            max={8}
            step={0.1}
            value={band.bandwidth ?? 2}
            onChange={(e) => setBand({ bandwidth: Number(e.target.value) })}
          />
          <span className="knob-value">{(band.bandwidth ?? 2).toFixed(1)} oct</span>
        </label>
        <button
          onClick={() => commit(bands.filter((_, i) => i !== picked))}
          disabled={bands.length <= 1}
          title="remove this band"
        >
          − band
        </button>
        <button
          onClick={() => commit([...bands, { type: 'bell', frequency: Math.round(band.frequency * 1.5) }])}
          disabled={bands.length >= 8}
          title="add a bell after the picked band"
        >
          + band
        </button>
        <label className="eq-norm" title="Fyra's auto-gain: EQ moves change tone, not level">
          <input
            type="checkbox"
            checked={normalize}
            onChange={(e) => op({ type: 'insert-edit', entry: ins.entry, set: { normalize: e.target.checked } })}
          />
          normalize
        </label>
        {/* No invisible gain, ever: the compensation is always shown. */}
        <span className="eq-comp">
          {normalize ? `${compensation >= 0 ? '+' : ''}${compensation.toFixed(1)} dB comp` : 'no comp'}
        </span>
      </div>
    </div>
  );
}
