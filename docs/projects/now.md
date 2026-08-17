# Now

In flight. One line each: name the work and link its plan if it has one, and
write the plan in [all](all/) as soon as the line wants a second sentence.
Delete the line when the work is genuinely over. Committed but not started
lives in [next](next.md); uncommitted ideas in [later](later.md). See
[README](README.md) for how these lists work.

- [`field insert add`](all/add-insert.md) — writes a pinned insert
  with an interactive chooser and order placement; stays until real
  sessions have added inserts with it, and until chunk 3's `field
  open` picks up the editor handoff the command currently prints.

- [Windows portability](all/windows-portability.md) — chunk 1 landed:
  the checkout is byte-defined (`* text=auto eol=lf`) so content hashes
  stop depending on git config; next the MSVC build of the daemon, which
  brings the whole offline render path, then the named-pipe transport
  that brings `field play`.

- [Plugin hosting](all/plugin-hosting.md) — chunks 1 and 2 shipped:
  AU and VST3 render offline and run live as inserts (`field check`
  pins a bare `plugin:` name, state blobs resolve by hash, dirty
  hosted chains evaluate in the engine and freeze behind the play,
  the master chain hosts in the callback), with editor write-back
  and realtime-bounce still to come.

- [Cross-rate live wiring](all/cross-rate-live.md) — shipped whole: a
  foreign-rate dirty track evaluates live with the edge converting
  (byte-identical to the offline render, proven), a device that
  cannot switch gets converted delivery, and all three rate refusals
  are gone; stays until a session has actually played through a live
  cross-rate edge in anger, per multi-rate's precedent.

- [Realtime](all/realtime.md) — the graph runs live, and all four
  chunks shipped: the streaming DSP library, the live graph
  (byte-identical to the offline render, proven per session), edits
  landing mid-play, and the freeze — `field play <song>` *is* live
  evaluation now, clean subgraphs arrive as cached stems, dirty ones
  rebuild behind the play under watch, and the `--live` flag is gone.
  Stays until live-default playback has soaked on real sessions; the
  recorded follow-ups (streaming rings before large sessions,
  cross-rate wiring) are where an edit would land.

- [Reverbs](all/reverbs.md) — shipped whole (a Dattorro `plate`, an FDN
  `hall` with per-band decay, and the old `reverb` kept deliberately as
  the live comparison); stays until the creek listening pass has flipped
  `space` between the three rooms and picked the example's room.

- [Nested tracks](all/nested-tracks.md) — a track can contain tracks, so
  structure, local time and the mixer are one primitive; every chunk has
  shipped, sends last (§19): cables validate and render offline, and
  creek's shared reverb is fed from two depths. Stays until sessions
  have worked the folded format and wired a cable or two in anger — the
  entry list, gen nodes, takes machinery and now sends are where every
  edit lands.
- [Multi-rate](all/multi-rate.md) — all three steps shipped (#107, #108,
  #112); stays until a session has actually played through an edge
  conversion, per the neighbours' precedent — every action key moved, the
  plan version bumped, and conversions now appear at edges nobody typed.
- [Voice generation](all/voice-generation.md) — committed vocals from
  text; creek sings, and it stays here until more songs have used it.
- [Watch mode](all/watch.md) — both chunks shipped (#34, #35); stays
  here while §5's status-visibility question is open, per the line
  below's precedent.
- [Project core](all/project-core.md) — all three chunks shipped (#4–#6);
  stays here until real use (bloom, new phases) stops surfacing
  surprises.
