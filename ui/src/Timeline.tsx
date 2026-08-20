import { useState } from 'react';
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
// Geometry is read, never dragged. The only gesture is clicking the
// axis to locate; dragging clips is deliberately out of scope.

interface Props {
  snap: UiSnapshot;
  playSample: number;
  onLocate: (sample: number) => void;
  controls: (lane: UiTimelineLane) => React.ReactNode;
}

export function Timeline({ snap, playSample, onLocate, controls }: Props) {
  // Keyed by path through the tree, so the same track opens separately
  // in each home it is placed in.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const tl = snap.timeline;
  if (!tl || tl.length <= 0) return null;

  const pxPerSample = 900 / tl.length; // fit the song; wheel zoom is a follow-on
  const x = (sample: number) => sample * pxPerSample;
  const width = Math.max(320, x(tl.length));

  const locateFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sample = Math.max(0, Math.round((e.clientX - box.left) / pxPerSample));
    onLocate(Math.min(sample, tl.length));
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
      <div className="tl-scroll">
        <div className="tl-grid" style={{ width: 180 + width }}>
          <div className="tl-corner" />
          {/* One tick per bar, drawn where the server says the bar falls:
              bars are not linear in samples across a tempo ramp. */}
          <div className="tl-ruler" style={{ width }} onClick={locateFromEvent}>
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
              onLocate={locateFromEvent}
              controls={controls}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  lane, open, onToggle, width, x, playSample, onLocate, controls,
}: {
  lane: UiTimelineLane;
  open: boolean;
  onToggle: () => void;
  width: number;
  x: (s: number) => number;
  playSample: number;
  onLocate: (e: React.MouseEvent<HTMLDivElement>) => void;
  controls: (lane: UiTimelineLane) => React.ReactNode;
}) {
  const peaks = lane.peaks;
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
      <div className="tl-lane" style={{ width }} onClick={onLocate}>
        <div
          className={`tl-block ${lane.mute ? 'muted' : ''} d${Math.min(lane.depth, 3)}`}
          style={{ left: x(lane.start), width: Math.max(2, x(lane.duration)) }}
        >
          {peaks && (
            <svg className="tl-wave" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none">
              {/* Mirrored envelope: the shape of the render, not a claim
                  about individual samples. */}
              <path
                d={
                  `M0,50 ` +
                  peaks.map((p, i) => `L${i},${50 - p * 46}`).join(' ') +
                  peaks.map((_, i) => {
                    const j = peaks.length - 1 - i;
                    return `L${j},${50 + (peaks[j] ?? 0) * 46}`;
                  }).join(' ') +
                  ' Z'
                }
              />
            </svg>
          )}
        </div>
        <div className="tl-head" style={{ left: x(playSample) }} />
      </div>
    </>
  );
}
