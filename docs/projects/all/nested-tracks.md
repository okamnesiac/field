# Plan: Nested tracks — one primitive for structure, time and mix

**Status:** Designed, not started (2026-08-08). Written from a design
conversation; no code exists. Sequenced deliberately **before** the
real-time engine ([audio-engine.md](../../audio-engine.md)), because it
changes the model the engine renders — doing it afterwards means
changing the schema *and* the engine.

**Goal:** a track can contain tracks. That one change collapses four
nouns into one, gives every container its own timeline, makes the mix
graph the containment graph, and lets a definition be placed in more
than one place. Today every track spans the whole song, Logic-style; the
point of this is that it no longer has to.

## 1 Decisions (DECIDED, 2026-08-08)

1. **Everything is a track.** A track holds clips, holds other tracks, or
   both. It has inserts, a fader, and a pan. The song is the root track.
   A mix is a track whose children are tracks; a bus is a track with no
   clips that receives sends; a "pattern" is a track placed more than
   once. None of those are types — they are tracks, distinguished only by
   what they contain.

   *Rejected: separate `pattern`/`section`/`group`/`bus` kinds.* Four
   nouns for one object, and each one imports a wrong assumption —
   `pattern` implies MIDI and repetition, `group` implies mix-only,
   `section` implies arrangement-only, `bus` implies no content.
   *Rejected: `track` plus `pattern` as two nouns*, which was the first
   proposal in the conversation that produced this plan and lost to the
   observation that with nesting there is no longer any difference
   between a track and a mix.

2. **Role lives in the name, not the type.** A track called `main-mix` is
   a main mix because it is called that. `drum-bus`, `verse`,
   `lead-vocal`. This is [project-core.md](project-core.md) §3.3's ID
   rule already: humans name it, the natural slug is the ID. Nothing in
   the schema knows which role a track plays, and nothing stops a new
   role being invented without a schema change.

3. **Placement is a property of the reference, not of the track.** A
   track's inputs are its children, each carried by a reference that
   holds a time:

   ```yaml
   inputs:
     - track: verse
       at: [5]
     - track: verse
       at: [13]
   ```

   One definition, two placements, one channel, summed. *Rejected: the
   time living on the track itself* (`verse` knowing it plays at bars 5
   and 13). Simpler to read — "where does this play" is a field rather
   than a query — but it forces a track to have exactly one parent, since
   its times would be relative to that parent's origin. That takes away
   sharing a figure between `verse` and `chorus`, which is most of the
   reason to nest at all.

4. **Containment is routing.** A track sums its children; the tree *is*
   the bus graph. There is no separate routing assignment to maintain and
   no second graph to visualise. *Rejected: a flat mixer with routing
   assignments*, which is two structures describing one thing. *Rejected:
   Maschine-style fixed groups* — the rigidity there (fixed group count,
   content cannot live outside one) is what makes a vocal unable to span
   sections, which is the problem this design starts from.

5. **Time composes down the tree.** A track may carry its own tempo and
   meter map; a child's local time maps into its parent's at the
   reference's `at`. Song time is the composition of the maps from the
   root down. **This subsumes the loops-with-their-own-timeline deferral**
   in [project-core.md](project-core.md) §3.1 — a polymetric loop is a
   track with a local meter, not a separate feature, and the note there
   that "nothing in the tick scheme precludes a loop carrying a local
   timeline mapped at its instantiation point" is exactly this.

6. **A track is an origin, not a window.** Content positioned at local
   tick *T* for duration *D* sounds from `origin + T` to `origin + T + D`.
   Nothing is clipped at a container boundary, so a vocal that runs past
   the end of a section needs no special handling — and a phrase that
   should span the song is simply a track at a level where it does.

   *Rejected: declared overhang* (`overhang_before`/`overhang_after` on a
   container). It is a number that can silently disagree with the
   content: lengthen the vocal, forget the overhang, and the tail
   truncates with no error. The same argument that makes `bar.beat.tick`
   a display projection rather than stored (§3.1). *Rejected:
   boundary truncation*, which would add a second place audio gets cut
   beside the clip window (§3.2) — two places to check when something is
   short.

   Negative local positions are allowed, and are how a pickup works: an
   anacrusis belongs to the chorus that follows it, not to the tail of
   the verse before it.

7. **Sends: any target that is not a descendant, with cycle detection.**
   A send carries a level and joins the target's inputs. Containment
   edges make a tree; sends make it a DAG.

   Sending to a descendant is always a cycle — the descendant's output
   already flows up into the sender — so it is not a separate rule, just
   the locally decidable case, and deserves its own message ("a send
   cannot reach into itself") rather than a generic cycle report.

   *Rejected: ancestors only.* Forbids the canonical case, since a plate
   at the song level is a *sibling* of the verse, not an ancestor of the
   snare inside it. *Rejected: uncles and aunts only* — attractive
   because it makes acyclicity free by a depth argument (every edge, both
   containment and send, strictly decreases depth, and nothing that
   always decreases can loop), but it forbids sends between siblings,
   which is a top-level vocal to a top-level plate: the most common send
   there is. *Rejected: declaration order* (send only to a later
   sibling), which makes file order semantically load-bearing and would
   let reordering a file silently rewire a mix. *Rejected: terminal
   buses* (a send target may not itself send), which restores free
   acyclicity but reintroduces a type distinction decision 1 removes.

   Detection is cheap and precedented: sound sources already make cycles
   declarable and `field check` already names them
   ([effects.md](effects.md) §3).

8. **Children and sends are both inputs; they differ in what the edge
   carries.** A child arrives with an **offset**; a send arrives with a
   **level**. Neither carries the other's.

   A containment offset shifts *content*, which has a known future — it
   is a file or a recipe that renders to one — so reading earlier from it
   is trivial and negative offsets are fine. A send routes *signal*,
   computed as it goes, so a negative send delay asks for samples that do
   not exist yet. Offline a mix render could fake it, and that is the
   trap: a project would render one way and play another. And for the
   case the engine primarily exists to serve — a human playing an
   instrument through live monitoring — the signal has no future even
   offline, so the feature is not merely unplayable but incoherent.

   Positive delay belongs to the effect, not the send: creek's vocal
   already carries `predelay_ms: 40` on its reverb. One place to look.

9. **The mix graph is static; only the view is dynamic.** Every track's
   channel exists for the whole song. A UI may hide channels whose track
   is not sounding where the playhead is — that is presentation.
   *Rejected: activating and deactivating channels with the arrangement.*
   It cuts reverb tails at the boundary, reintroducing the artifact
   decision 6 removes, and it requires instantiating and freeing plugin
   instances as the playhead crosses a boundary, which is the one thing
   the audio thread cannot do.

## 2 What this is, in one paragraph

A track has inputs, inserts, a fader and a pan. Its inputs are other
tracks — each reference carrying a time — and sends. It may hold clips
directly. It may carry its own tempo and meter. The song is the root
track. Everything else in this plan follows from those five sentences.

## 3 Field today is already this, at depth one

Every existing project is a valid instance of the new model with one
level of nesting and every `at` at zero: a song contains its tracks all
starting together, and clips carry absolute song positions. That is the
Logic model, and it is what field has now.

So the migration is mechanical rather than interpretive:
`mixes/main.yaml` becomes the root track, each existing track becomes a
child at zero, and clips keep their positions untouched. The churn is in
labels — `//songs/creek/mix:main` becomes `//songs/creek/track:main` —
and in `mixes/` retiring as a directory.

## 4 Why this earns its keep beyond structure

- **The build graph gets smaller.** Field renders through a
  content-hashed action cache. A track placed three times is *one render
  placed three times*, where today three near-identical sets of clips
  render independently. Nesting is a caching win, not only an
  organisational one — a property a DAW without a build graph cannot
  have.
- **One graph instead of two.** Containment answers "where does this
  signal go", so there is no routing view to consult and no assignment to
  keep in step with the arrangement.
- **Render order falls out.** Depth-first, children before parents; the
  DAG is topologically ordered, which is the same shape of problem the
  build graph already solves.

## 5 Open questions

- **`arrangement.yaml`'s `sections`.** They are markers today (a name and
  a position, owning no content). Once structure is expressed by nested
  tracks, do they retire, or stay as a display-only ruler? Two things
  that both look like song structure is the risk.
- **Stems.** Is a stem still a concept, or just "any track's render"? The
  latter is tempting and would remove another noun.
- **Effective gain.** Nested faders multiply. `-6 dB` on a parent and
  `-6 dB` on a child is `-12 dB`, which is correct and invisible.
  Something — `field check`, metering, `explain` — should be able to
  report a track's effective gain without walking the tree by hand.
- **Local tempo maps and re-placement.** If a track carries its own tempo
  map and is placed twice, both placements share it. Is there a case for
  a placement overriding the map, and does that break "one definition"?
- **Depth in practice.** Unbounded nesting is often simpler to implement
  than exactly-two. Worth confirming nothing in the model assumes a
  bound.

## 6 Chunks

1. **Schema and check.** Tracks contain tracks; references carry `at`;
   `mixes/` retires. No rendering change — prove the model expresses
   creek exactly as it is today, at depth one, with `field check` green.
2. **Placement and local time.** A child at a non-zero `at`; a track
   placed twice; local tempo and meter maps composing into song time.
3. **Nested mix.** Faders, pans and inserts at every level; effective
   gain surfaced.
4. **Sends.** The DAG, cycle detection, the reach-into-itself message.
5. **bloom.** Express creek with a `verse` placed twice and a vocal at
   the root, and see whether the structure reads better than the flat
   version. This is the chunk that decides whether the idea was right.

## 7 Definition of done

creek is expressed with nested tracks: at least one definition placed in
more than one position, at least one track spanning the song above the
sections, a shared reverb fed by sends from two different depths, and a
mix that renders to the same audio as the flat version did — or better,
with a written reason for any difference. `field check` catches a send
that reaches into itself and names it.
