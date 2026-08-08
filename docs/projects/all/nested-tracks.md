# Plan: Nested tracks — one primitive for structure, time and mix

**Status:** In progress (2026-08-08). Nesting renders — a track can
contain a track, `check` gates it, and the stem places the child's render
at the placement's offset. The chunk order changed on the way in; §9
records what and why. Sequenced deliberately **before** the
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

6. **A container never truncates; a placement may.** Content positioned
   at local tick *T* for duration *D* sounds from `origin + T` to
   `origin + T + D`. Nothing is clipped because a parent's extent ran
   out, so a vocal that runs past the end of a section needs no special
   handling, and a phrase that should span the song is simply a track at
   a level where it does.

   That is a rejection of *implicit* truncation, not of windows. A
   placement declares its own window — `duration`, fades, `slip` — which
   is exactly what a clip is today (project-core.md §3.2) and stays.
   The distinction is who decides: the placement, explicitly, and never
   the container it happens to sit in.

   *Rejected: declared overhang* (`overhang_before`/`overhang_after` on a
   container). It is a number that can silently disagree with the
   content: lengthen the vocal, forget the overhang, and the tail
   truncates with no error. The same argument that makes `bar.beat.tick`
   a display projection rather than stored ([project-core.md](project-core.md)
   §3.1). *Rejected: boundary truncation*, which would add a second place
   audio gets cut beside the clip window (project-core.md §3.2) — two
   places to check when something is short.

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

   *Rejected: no sends at all — place the track in both parents instead*
   (2026-08-08). Attractive because it deletes a decision and a chunk, and
   exactly right for siblings: a placement carries a level, the graph is
   already a DAG, and the cycle detection is already written. It fails the
   moment the source is nested or repeated. `snare` inside `verse`, with
   `verse` placed at bars 5 and 13, has no single `at` a plate could place
   it at — there are two, both hand-computed from where `verse` sits, and
   moving `verse` leaves the plate reverberating at the old spot with no
   error. That is the second structure to maintain that decision 4 exists
   to eliminate. The escape — putting the plate *inside* `verse` so it
   moves with its parent — works and costs the sharing: a plate per
   placement, unfeedable from `chorus`, when a shared reverb fed from two
   depths is §8's definition of done. What the level-only edge buys, and a
   placement cannot, is inheriting the target's time mapping instead of
   declaring its own — a placement's whole nature is that it declares a
   time.

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

10. **A track's render is its stem, and it is pre-fader.** Inserts are
    inside the cached render; gain and pan are outside it, applied by the
    parent as it sums. This is today's property generalised rather than a
    new one — `stem.ts` renders pre-fader precisely so that "mixing
    decisions never invalidate rendered stems"
    ([project-model.md](../../project-model.md)) — and nesting keeps it:
    nudging a fader six levels down never re-renders the content below it.

    That promise was first written as "re-sums and re-renders nothing",
    which is too strong (2026-08-08). A parent's stem *is* its sum plus
    its own inserts, so a gain change re-runs the insert chain of every
    ancestor above it — those chains are non-linear and sit downstream of
    the gain. Nothing below re-renders, which is the expensive half and
    the half worth promising. This is not a cost of decision 13; it is
    true of any model once a parent has both inserts and children, and the
    original promise only held because the mix was the sole consumer and
    had no chain ahead of its faders.

    "Stem" survives as the word for a track's render. Which stems get
    sent for mastering is a choice at export time, not a kind of object.

11. **A clip is a placement, and a placement is a stem at a time.** A
    track's inputs are placements of tracks; consuming a track means
    consuming its stem. A clip is the case where the placed track is
    already rendered — an asset, or a recipe that renders to one. One
    list, one rule, no separate `clips:` and `inputs:`.

12. **Sounds are simple tracks.** An `eq` sound is a track with one input
    and one insert; `supercollider` is a leaf with a program; a
    `generative` sound is a leaf with committed variants and a `chosen`
    one. The effect *contracts* are untouched — parameter semantics,
    schemas and rendered artifacts all survive, which is
    [effects.md](effects.md) §1's own argument that the executor is the
    replaceable part and the contract the durable one. What changes is
    where they attach: to tracks, rather than to a separate kind.

    Deliberately **not** chunk 1. Nesting can land while `sounds/` still
    exists, and folding them in is a layout change
    ([project-layout.md](project-layout.md)) that deserves its own step
    and its own chance to be wrong.

13. **One gain, and it lives on the edge (2026-08-08).** A placement
    carries a level; nothing else does. What a console calls a channel's
    *fader* and what it calls a bus's *input trim* are one gain stage seen
    from two directions — the fader sets how much of a track reaches its
    parent, which is precisely the parent's level for that input. So there
    is one field, `inputs[].gain_db`, and it already sits at the right
    point in the path: a child's stem arrives fully rendered through its
    own inserts, and the gain is applied while the parent sums.

    A console says the same thing by omission: trim lives on a *mic*
    input, where the incoming level is unknown and has to be staged before
    anything downstream can be set. A line input fed from another channel
    has no trim, because the sending channel's fader already is one. Every
    edge in this graph is a line input.

    Another gain stage means another level, not another field. Driving a
    limiter harder without disturbing the balance of the three things
    feeding it is a sub-track holding the three, placed at its own gain.
    Master volume is the same move: a `master` track whose single input is
    the mix, placed at `gain_db`, with the master chain as its inserts.

    Today's mix rule already *is* this, which is the strongest evidence it
    is right. `renderMix` does `sumStems(faders)` → `mix.gain_db` → master
    chain; a track render does `sumClips(gains)` → inserts. `mix.gain_db`
    already sits where a placement gain sits, driving into the chain the
    way [effects.md](effects.md) §5 says it should. So the migration is a
    simplification rather than a re-encoding, and `track.gain_db`/`pan`
    retire into the root track's placements — bit-identically, because the
    stage does not move.

    *Rejected: a separate track-level trim* before the inserts. Real as a
    stage, redundant as a field, since a level expresses it.

    Consequence for chunk 3: `pan` is the same stage as gain, so it moves
    to the edge too — and the daemon's stem op sums clips with a gain and
    **no pan**. Per-clip pan in `sumClips` is the prerequisite, and the
    reason `check` refuses a placed track whose pan is set.

14. **Tracks, not channels (2026-08-08).** *Rejected: renaming everything
    to `channel`*, which was seriously considered and lost on two counts.

    `channel` is already taken: it means L/R throughout the audio layer —
    37 sites in TypeScript and 105 in the daemon (`wav.channels[0]`,
    "mono or stereo only"). The layers barely meet, so this is a cost
    rather than a blocker, but it is a cost paid in exactly the place
    error messages are read.

    The argument *for* it was that `track` means something specific to
    producers, so "everything is a track" asks them to unlearn. That holds
    against Logic and Pro Tools and not against Ableton, which already
    says what decision 1 says: Return Tracks are buses, Group Tracks
    contain other tracks and nest inside each other, and the root is the
    Master Track. Bitwig likewise. The stretching `track` needed is
    therefore already done by the DAWs closest to this design, and the two
    sentences that matter most read better under it — "a track placed at
    bar 5", `//songs/creek/track:drums`.

    `pattern` strains under both nouns equally and so decides nothing.

    **`channel` survives as the mixer view's word.** One object; when you
    are looking at the mixer you call it a channel, which is where "a bus
    is a channel" and "master channel" come from without a rename. That is
    decision 9's split — static graph, dynamic view — applied to
    vocabulary.

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

## 5 Settled since drafting (2026-08-08)

- **`arrangement.yaml` goes away entirely.** Its schema is only
  `{sections: [{name, at}]}`, so removing sections removes the file. The
  arrangement becomes *derived*: a command walks the root track's
  placements and prints the structure, which cannot drift from reality
  because it is not stored. Same argument as decision 6's.
- **Effective gain lives in `explain`.** It already answers "why is this
  what it is", and it is where someone goes when a number surprises them.
  Not a `check` warning: multiplied faders are surprising, not wrong, and
  warnings about non-errors get tuned out.
- **No placement-level tempo override, for now.** A slower reprise is a
  real want, and allowing it is coherent — the cache key would include
  the effective tempo, so two placements at two tempos are two renders.
  But that quietly makes "one definition, one render, placed N times"
  conditional, and it can be added later without breaking anything where
  it cannot be removed once projects rely on it. The same asymmetry that
  decided sends.
- **Depth is unbounded**, and neither the schema nor `check` may assume a
  bound.

## 6 Open questions

- **Placement identity.** Clips carry IDs (`chorus-vox-x7f3q`,
  project-core.md §3.3) so automation can attach to them. Placements need
  the same, which is additive — but a track placed twice now has two
  placement IDs and one track name, and it is worth deciding which
  automation binds to.
- **Where sounds live once they are tracks.** `sounds/` and `tracks/` are
  separate directories today. Decision 12 folds the kinds together but
  not the layout; that is a project-layout.md question and should be
  answered there rather than assumed here.
- **What a leaf actually holds.** An asset reference, a recipe, and a
  committed-variant set are three different leaf contents. Whether that
  is one shape with a discriminant or three is the first schema question
  chunk 1 hits.

## 7 Chunks

1. **Schema and check.** Tracks contain tracks; references carry `at`;
   `clips:` and `inputs:` become one list of placements; `mixes/` and
   `arrangement.yaml` retire. No rendering change — prove the model
   expresses creek exactly as it is today, at depth one, with `field
   check` green. Deliberately the cheapest falsifiable step: if the model
   cannot say what field already says, it is wrong here rather than after
   the mixer nests.
2. **Placement and local time.** A child at a non-zero `at`; a track
   placed twice; local tempo and meter maps composing into song time.
3. **Nested mix.** Faders, pans and inserts at every level; effective
   gain surfaced.
4. **Sends.** The DAG, cycle detection, the reach-into-itself message.
5. **bloom.** Express creek with a `verse` placed twice and a vocal at
   the root, and see whether the structure reads better than the flat
   version. This is the chunk that decides whether the idea was right.
6. **Sounds fold in** (decision 12). `sounds/` retires; an `eq` sound
   becomes a track with one insert. Last on purpose — the contracts are
   untouched, so this is a layout and namespace change rather than a
   behavioural one, and it should not be able to break nesting on its way
   in.

## 8 Definition of done

creek is expressed with nested tracks: at least one definition placed in
more than one position, at least one track spanning the song above the
sections, a shared reverb fed by sends from two different depths, and a
mix that renders to the same audio as the flat version did — or better,
with a written reason for any difference. `field check` catches a send
that reaches into itself and names it.

## 9 Sequencing, revised (2026-08-08)

§7's chunk 1 is the migration — express creek as it is today, at depth
one — and its argument is that it is the cheapest falsifiable step. It is
certainly the cheapest. It is not the falsifiable one: renaming
`mixes/main.yaml` to a root track and giving every child `at: 0` is a
rename plus a level, and nothing about it can teach us whether the design
holds. The question that can fail is whether a track containing a track
*renders* — right offsets, right length, the pre-fader boundary intact.

So nesting landed first, additively: `inputs:` alongside `clips:`, every
existing track parsing unchanged, creek untouched and every one of its
action keys still hitting the cache. The migration follows as its own
step, against a renderer that already does the thing it will depend on.
The chunk numbers in §7 stay as written — they are cited — and this is
the order they run in:

1. **Nesting renders** (§7 chunk 1's schema and check, plus the render).
   A child track is a placed source in its parent's stem.
2. **§7 chunk 1's migration.** `mixes/` and `arrangement.yaml` retire;
   creek's tracks become children of a root track at `at: 0`.
3. §7 chunks 2–6 unchanged.

Three things are deferred out of step 1 rather than dropped, each because
half of it would be worse than none:

- **A child's own `gain_db`/`pan`.** `check` refuses a placed track with
  either set, and names §7 chunk 3. Decision 13 has since sharpened what
  that refusal is waiting for: the fields are not becoming supported on a
  placed track, they are **retiring**, with the level moving onto the
  placement where it can differ per parent. So the refusal is a migration
  stance rather than a missing feature, and the thing chunk 3 must
  actually build is per-clip pan in the daemon's `sumClips` — the one
  piece that is not moving fields around.
- **Negative `at`.** §1.6 allows it for pickups; `timePosition` is
  non-negative today, for clips as much as for placements, so allowing it
  is a change to the time primitive rather than to nesting.
- **Placement identity.** §6's open question. Placements are named by
  position in diagnostics until it is answered.
