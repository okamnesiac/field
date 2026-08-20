import type { UiSnapshot } from '../../src/commands/ui-protocol.js';

// The song seen in time (ui-timeline.md §2): headers on the left,
// lanes on one shared axis to the right, under a bar ruler, with a
// playhead.
//
// One scroll container and two sticky axes, per the plan: the header
// column sticks left, the ruler row sticks top, and vertical scrolling
// therefore moves both halves by construction. No scroll-sync handler
// exists to drift out of step.
//
// Geometry is read, never dragged. The only gesture is clicking the
// axis to locate — dragging clips is a different class of interaction
// and an explicit non-goal (§9).

interface Props {
  snap: UiSnapshot;
  playSample: number;
  onLocate: (sample: number) => void;
  children: (entry: number) => React.ReactNode; // the header row's controls
}

const LANE_H = 56;

export function Timeline({ snap, playSample, onLocate, children }: Props) {
  const tl = snap.timeline;
  if (!tl || tl.length <= 0) return null;
  const pxPerSample = 900 / tl.length; // fit the song; wheel zoom is §8's
  const x = (sample: number) => sample * pxPerSample;
  const width = Math.max(320, x(tl.length));

  const locateFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sample = Math.max(0, Math.round((e.clientX - box.left) / pxPerSample));
    onLocate(Math.min(sample, tl.length));
  };

  return (
    <div className="tl">
      <div className="tl-scroll">
        <div className="tl-grid" style={{ width: 180 + width }}>
          {/* Ruler: one tick per bar, drawn where the server says the bar
              falls — bars are not linear in samples across a ramp. */}
          <div className="tl-corner" />
          <div className="tl-ruler" style={{ width }} onClick={locateFromEvent}>
            {tl.marks.map((m) => (
              <div key={m.bar} className="tl-mark" style={{ left: x(m.sample) }}>
                <span>{m.bar}</span>
              </div>
            ))}
            <div className="tl-head" style={{ left: x(playSample) }} />
          </div>

          {tl.lanes.map((lane) => {
            const laneLeft = x(lane.start);
            const laneWidth = Math.max(2, x(lane.duration));
            return [
              <div className="tl-header" key={`h${lane.entry}`}>
                {children(lane.entry)}
              </div>,
              <div
                className="tl-lane"
                key={`l${lane.entry}`}
                style={{ width, height: LANE_H }}
                onClick={locateFromEvent}
              >
                <div className="tl-block" style={{ left: laneLeft, width: laneWidth }}>
                  {lane.peaks && (
                    <svg
                      className="tl-wave"
                      viewBox={`0 0 ${lane.peaks.length} 100`}
                      preserveAspectRatio="none"
                    >
                      {/* Mirrored envelope: the shape of the render, not a
                          claim about individual samples. */}
                      <path
                        d={
                          `M0,50 ` +
                          lane.peaks.map((p, i) => `L${i},${50 - p * 48}`).join(' ') +
                          ` L${lane.peaks.length - 1},50 ` +
                          lane.peaks.map((p, i) => `L${lane.peaks!.length - 1 - i},${50 + (lane.peaks![lane.peaks!.length - 1 - i] ?? 0) * 48}`).join(' ') +
                          ' Z'
                        }
                      />
                    </svg>
                  )}
                </div>
                {/* Placement boundaries inside the lane, so a track that
                    places several things shows where they seam. */}
                {lane.clips.map((c, i) => (
                  <div
                    key={i}
                    className={`tl-clip ${c.exact ? '' : 'inexact'}`}
                    style={{ left: x(c.start), width: Math.max(2, x(c.duration)) }}
                    title={`${c.name}${c.exact ? '' : ' — length resolved at render'}`}
                  />
                ))}
                <div className="tl-head" style={{ left: x(playSample) }} />
              </div>,
            ];
          })}
        </div>
      </div>
    </div>
  );
}
