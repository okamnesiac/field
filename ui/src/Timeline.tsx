import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// Real imports, not type-only: the grid the drag snaps to is the song's
// own tempo arithmetic, the same functions the server projects bars
// through — a client-side copy would drift from the ruler it snaps to.
import { barTicks, MeterMap, TempoMap } from '../../src/time/tempo.js';
import type { UiSnapshot, UiTimelineLane } from '../../src/commands/ui-protocol.js';

// The song seen in time: headers on the left, lanes on one shared axis
// to the right, under a bar ruler, with a playhead.
//
// One scroll container and two sticky axes: the header column sticks
// left, the ruler row sticks top, and vertical scrolling therefore moves
// both halves by construction. No scroll-sync handler exists to drift
// out of step.
//
// A lane that places a track opens to show what is inside it — drums
// into kick, snare and hats — one level per click, as deep as the tree
// goes. Expansion is view state, held here and persisted nowhere: a
// track placed in two homes opens independently in each, and both edit
// the one file underneath, which is the same convergence argument that
// put `mute:` on the placement.
//
// The gestures, and which one owns the playhead: clicking a clip
// selects it, dragging a clip moves it in time, dragging either edge of
// a clip trims it short or lets it play longer (all three snapped to the
// beat grid and committed on release, as a `move` or a `stretch`), and
// the playhead moves only from the ruler or a double-click on a clip.
// The edges are grips rather than a hit test on the block, so the cursor
// says which gesture the hand is about to start — and they appear only
// on a block wide enough to hold them and still be draggable, since a
// clip narrower than two grips could otherwise never be moved.
//
// A single click on a lane deliberately does nothing to the transport — locating on every stray
// click made selecting a clip impossible without also moving the play
// position, which is how the first version worked and why it stopped.
//
// The view follows the playhead while it moves: once the head crosses
// the middle of the viewport the scroll position tracks it, which is
// the conveyor a DAW runs during playback. A manual scroll wins for a
// moment — the hold below — so looking at another part of the song is
// never a fight with the transport.

// The header column's width, shared by the CSS grid template and every
// piece of arithmetic that has to know where lane content begins.
const HEADER_PX = 200;

// Which edge a drag is holding. A move holds the start and carries the
// whole window; the other two change the window's length.
type Edge = 'move' | 'start' | 'end';

// The grip's width, and the unit the "is this block wide enough" test is
// written in — one number so the two cannot disagree.
const GRIP_PX = 7;

// Zoom, fixed for now: enough that a song longer than the window keeps
// scrolling as it plays, while a short one stretches to fill (below).
const PX_PER_SECOND = 100;

// Find a lane again by its tree path — the shape the walk below
// builds. The panel holds a path rather than a lane object, so each
// snapshot re-resolves it and edits always read current values.
export function laneAt(lanes: UiTimelineLane[], path: string, prefix = ''): UiTimelineLane | null {
  for (const lane of lanes) {
    const p = `${prefix}/${lane.entry}:${lane.name}`;
    if (p === path) return lane;
    if (lane.children && path.startsWith(p + '/')) {
      const hit = laneAt(lane.children, path, p);
      if (hit) return hit;
    }
  }
  return null;
}

interface Props {
  snap: UiSnapshot;
  playSample: number;
  // Selection lives in App — the inserts panel reads it too — and the
  // timeline is one of its writers.
  selected: string | null;
  onSelect: (path: string | null) => void;
  onLocate: (sample: number) => void;
  onMove: (lane: UiTimelineLane, deltaSamples: number) => void;
  // The end edge commits the window's new length, the start edge how far
  // it travelled — one measurement from the clip's own window start,
  // which is what the server's op takes (ui-edits.ts).
  onStretch: (lane: UiTimelineLane, edge: 'start' | 'end', offset: number) => void;
  controls: (lane: UiTimelineLane) => React.ReactNode;
}

export function Timeline({ snap, playSample, selected, onSelect, onLocate, onMove, onStretch, controls }: Props) {
  // Keyed by path through the tree, so the same track opens separately
  // in each home it is placed in.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // While a drag is live, the dragged clip renders with its edge moved
  // by delta — the whole block for a move, one side for a stretch. The
  // write happens once, on release.
  const [drag, setDrag] = useState<{ path: string; edge: Edge; delta: number } | null>(null);
  const grab = useRef<
    { x: number; path: string; lane: UiTimelineLane; edge: Edge; active: boolean } | null
  >(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // A manual scroll holds off the auto-follow until this timestamp, so
  // the conveyor never yanks the view back mid-gesture.
  const holdUntil = useRef(0);
  // Measured, not assumed: the lane area is whatever the window gives
  // it, and a short song stretches to exactly that.
  const [viewWidth, setViewWidth] = useState(1200);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The snap grid: the song's beat positions, through the real maps.
  // Beats rather than bars — bars are the ruler's resolution, and a
  // clip that can only land on a barline cannot make a pickup.
  const clock = snap.clock;
  const grid = useMemo(
    () =>
      clock
        ? { tempo: new TempoMap(clock.tempo, clock.sampleRate), meter: new MeterMap(clock.meter) }
        : null,
    [clock],
  );
  const snapSample = (sample: number): number => {
    if (!grid) return Math.max(0, Math.round(sample));
    const ticks = grid.tempo.samplesToTicks(Math.max(0, sample));
    let seg = 0;
    while (seg + 1 < grid.meter.events.length && grid.meter.events[seg + 1]!.at <= ticks) seg++;
    const ev = grid.meter.events[seg]!;
    const beat = barTicks(ev) / ev.numerator;
    const snapped = Math.max(0, ev.at + Math.round((ticks - ev.at) / beat) * beat);
    return Math.max(0, Math.round(grid.tempo.ticksToSamples(snapped)));
  };

  const tl = snap.timeline;
  const length = tl?.length ?? 0;
  // A song shorter than the window fills it; a longer one gets the
  // fixed zoom and scrolls. Declared before the effect below so hook
  // order never depends on the snapshot's contents.
  const pxPerSample = tl
    ? Math.max((viewWidth - HEADER_PX) / length, PX_PER_SECOND / tl.rate)
    : 0;
  const x = (sample: number) => sample * pxPerSample;
  const width = x(length);

  // Follow the playhead. playSample only moves while playing or on a
  // locate, so this is idle exactly when the transport is.
  useEffect(() => {
    const el = scroller.current;
    if (!el || performance.now() < holdUntil.current) return;
    const view = el.clientWidth - HEADER_PX;
    const head = x(playSample);
    if (head - el.scrollLeft > view * 0.5) {
      el.scrollLeft = head - view * 0.5; // the conveyor: head pinned mid-view
    } else if (head < el.scrollLeft) {
      el.scrollLeft = Math.max(0, head - view * 0.15); // jumped back: catch up
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playSample]);

  if (!tl || length <= 0) return null;

  // Locate from a horizontal position inside any lane-width element:
  // the ruler on a single click, a clip on a double.
  const locateAt = (clientX: number, laneEl: HTMLElement) => {
    const box = laneEl.getBoundingClientRect();
    const sample = Math.max(0, Math.round((clientX - box.left) / pxPerSample));
    onLocate(Math.min(sample, length));
  };

  const onGrab = (
    e: React.PointerEvent<HTMLDivElement>,
    lane: UiTimelineLane,
    path: string,
    edge: Edge,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(path);
    grab.current = { x: e.clientX, path, lane, edge, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    // A click is not yet a drag: a few pixels of hand tremor must not
    // become a file write.
    if (!g.active && Math.abs(dx) < 4) return;
    g.active = true;
    holdUntil.current = performance.now() + 1500; // the conveyor yields to the hand
    // Whichever edge the hand is holding, snapped to the grid and read
    // back as a delta from where that edge started — a move holds the
    // start and carries the whole window with it.
    const held = g.edge === 'end' ? g.lane.start + g.lane.duration : g.lane.start;
    const delta = snapSample(held + dx / pxPerSample) - held;
    // A window never closes to nothing under the hand. The drag simply
    // stops following at the last grid step that leaves a window, rather
    // than clamping to a position no snap would have produced.
    if (g.edge === 'start' && delta >= g.lane.duration) return;
    if (g.edge === 'end' && delta <= -g.lane.duration) return;
    setDrag({ path: g.path, edge: g.edge, delta });
  };
  const onDrop = () => {
    const g = grab.current;
    grab.current = null;
    if (g?.active && drag !== null && drag.delta !== 0) {
      if (g.edge === 'move') onMove(g.lane, drag.delta);
      else if (g.edge === 'end') onStretch(g.lane, 'end', g.lane.duration + drag.delta);
      else onStretch(g.lane, 'start', drag.delta);
    }
    setDrag(null);
  };
  const onDragCancel = () => {
    grab.current = null;
    setDrag(null);
  };

  // Flatten the visible tree: a child only appears when every ancestor
  // is open, so one pass over this array renders the grid in order.
  const rows: { lane: UiTimelineLane; path: string }[] = [];
  const walk = (lanes: UiTimelineLane[], prefix: string) => {
    for (const lane of lanes) {
      const path = `${prefix}/${lane.entry}:${lane.name}`;
      rows.push({ lane, path });
      if (open[path] && lane.children) walk(lane.children, path);
    }
  };
  walk(tl.lanes, '');

  return (
    <div className="tl">
      <div
        className="tl-scroll"
        ref={scroller}
        onWheel={() => {
          holdUntil.current = performance.now() + 1500;
        }}
      >
        <div className="tl-grid" style={{ width: HEADER_PX + width }}>
          <div className="tl-corner" />
          {/* One tick per bar, drawn where the server says the bar falls:
              bars are not linear in samples across a tempo ramp. */}
          <div
            className="tl-ruler"
            style={{ width }}
            onClick={(e) => locateAt(e.clientX, e.currentTarget)}
          >
            {tl.marks.map((m) => (
              <div key={m.bar} className="tl-mark" style={{ left: x(m.sample) }}>
                <span>{m.bar}</span>
              </div>
            ))}
            <div className="tl-head" style={{ left: x(playSample) }} />
          </div>

          {rows.map(({ lane, path }) => (
            <Row
              key={path}
              lane={lane}
              open={open[path] === true}
              onToggle={() => setOpen((o) => ({ ...o, [path]: !o[path] }))}
              width={width}
              x={x}
              playSample={playSample}
              selected={selected === path}
              drag={drag?.path === path ? drag : null}
              onGrab={(e, edge) => onGrab(e, lane, path, edge)}
              onDragMove={onDragMove}
              onDrop={onDrop}
              onDragCancel={onDragCancel}
              onDeselect={() => onSelect(null)}
              locateAt={locateAt}
              controls={controls}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// A lane's waveform as an SVG path, built once per envelope. Every row
// re-renders on each frame while playing, because the playhead moves,
// and rebuilding a 1,200-bucket path string per row per frame is most of
// that frame's work. The envelope array is the same object until a
// snapshot replaces it, so a WeakMap keyed on it hands back the same
// string, and React leaves the DOM attribute alone.
const wavePaths = new WeakMap<number[], string>();
function wavePath(peaks: number[]): string {
  let d = wavePaths.get(peaks);
  if (d === undefined) {
    d =
      `M0,50 ` +
      peaks.map((p, i) => `L${i},${50 - p * 46}`).join(' ') +
      peaks
        .map((_, i) => {
          const j = peaks.length - 1 - i;
          return `L${j},${50 + (peaks[j] ?? 0) * 46}`;
        })
        .join(' ') +
      ' Z';
    wavePaths.set(peaks, d);
  }
  return d;
}

function Row({
  lane, open, onToggle, width, x, playSample, selected, drag,
  onGrab, onDragMove, onDrop, onDragCancel, onDeselect, locateAt, controls,
}: {
  lane: UiTimelineLane;
  open: boolean;
  onToggle: () => void;
  width: number;
  x: (s: number) => number;
  playSample: number;
  selected: boolean;
  drag: { edge: Edge; delta: number } | null;
  onGrab: (e: React.PointerEvent<HTMLDivElement>, edge: Edge) => void;
  onDragMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDrop: () => void;
  onDragCancel: () => void;
  onDeselect: () => void;
  locateAt: (clientX: number, laneEl: HTMLElement) => void;
  controls: (lane: UiTimelineLane) => React.ReactNode;
}) {
  const peaks = lane.peaks;
  // One delta, read three ways: a move carries both edges, a start drag
  // moves the left edge and eats into the window, an end drag leaves the
  // left edge where it is and changes the length.
  const delta = drag?.delta ?? 0;
  const start = drag?.edge === 'end' ? lane.start : lane.start + delta;
  const duration =
    drag === null || drag.edge === 'move'
      ? lane.duration
      : drag.edge === 'end'
        ? lane.duration + delta
        : lane.duration - delta;
  const stretching = drag !== null && drag.edge !== 'move';
  // Two grips and room to grab the block between them: below that the
  // clip is all handle and nothing to drag, so the edges step aside.
  const grips = x(duration) >= 3 * GRIP_PX;
  return (
    <>
      <div className="tl-header" style={{ paddingLeft: 6 + lane.depth * 14 }}>
        {lane.children ? (
          <button className="twirl" onClick={onToggle} title={open ? 'collapse' : 'expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="twirl-spacer" />
        )}
        {controls(lane)}
      </div>
      {/* A click on empty lane ground only clears the selection — the
          playhead belongs to the ruler and to double-clicks. */}
      <div className="tl-lane" style={{ width }} onClick={onDeselect}>
        <div
          className={[
            'tl-block',
            lane.mute ? 'muted' : '',
            selected ? 'selected' : '',
            drag !== null ? 'dragging' : '',
            stretching ? 'stretching' : '',
            `d${Math.min(lane.depth, 3)}`,
          ].join(' ')}
          style={{ left: x(start), width: Math.max(2, x(duration)) }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => onGrab(e, 'move')}
          onPointerMove={onDragMove}
          onPointerUp={onDrop}
          onPointerCancel={onDragCancel}
          onDoubleClick={(e) => {
            const laneEl = e.currentTarget.closest('.tl-lane');
            if (laneEl instanceof HTMLElement) locateAt(e.clientX, laneEl);
          }}
        >
          {grips &&
            (['start', 'end'] as const).map((edge) => (
              <div
                key={edge}
                className={`tl-grip ${edge}`}
                title={edge === 'start' ? 'trim the front (moves what it reads)' : 'trim the end'}
                onPointerDown={(e) => onGrab(e, edge)}
                onPointerMove={onDragMove}
                onPointerUp={onDrop}
                onPointerCancel={onDragCancel}
              />
            ))}
          {peaks && (
            <svg className="tl-wave" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none">
              {/* Mirrored envelope: the shape of the render, not a claim
                  about individual samples. */}
              <path d={wavePath(peaks)} />
            </svg>
          )}
        </div>
        <div className="tl-head" style={{ left: x(playSample) }} />
      </div>
    </>
  );
}
