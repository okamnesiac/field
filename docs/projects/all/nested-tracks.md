---
status: Shipped
---

# Plan: Nested tracks — one primitive for structure, time and mix

**Status:** Complete except deferred sends (2026-08-09) — every chunk
has either shipped or moved: chunk 4 (sends) waits for the real-time
engine by §14's argument, and everything else is live, chunk 6's finale
last. Nesting renders, `mixes/` has
retired into the output track (#81), and creek is now expressed as three
placements of a phrase — §7 chunk 5, whose verdict is §10.
`arrangement.yaml` has retired into `field arrangement` (§11), which
finishes chunk 1. Chunk 3 is done: per-clip pan landed in the daemon
(#76) and `field explain` now answers the level question (§12). Chunk 2
is done too — a track carries its own tempo and meter (§13). Sends
(chunk 4) are deferred to the real-time engine, which is where an edge
that carries no offset stops needing offsets invented for it (§14). What
is left here is folding `sounds/` in (chunk 6), which opened with the
clip-duration prerequisite (§15, #97) and the eq fold (§17, #100), and
then settled the shape it was heading toward: one `inputs:` list whose
entries place tracks, committed audio, or inline generators (§18) —
which answers §6's leaf-content question, retires `clips:` and `type:`,
and supersedes §17's spelling. The format has landed — one `inputs:`
list with `track:`/`audio:`/`sound:` entries, every action key intact —
and so have `supercollider:` entries: `kit-sc` and `pad-sc` are leaf
tracks whose renders are `gen:` nodes cached under their old sound keys.
`generative:` entries have landed too (§18 step 3, decision 3 as
amended): `still-water-keys` is a leaf track, its takes keyed by gen
node name so the audio directory never moved, and `generate`/`choose`
resolve gen node names. `seven-eight-loop`'s wait ended the way §16 planned: `loop-cd` retired
into `field export --rate 44100 --bit-depth 16`
([multi-rate.md](multi-rate.md) step 2) and the loop is a leaf track —
`drums` re-rendered byte-identically and `main` never re-keyed. No
sound remains: `vocal-48k` retired with multi-rate step 3 (a track
carries its own rate, the edge converts), and `lead-take` has folded as
a generative leaf placed twice by `lead-vocal` — byte-identically, its
takes directory unmoved. And the machinery has followed the last use
out: the `sound:` entry field, the sound schema union, the `sounds/`
loader, the sound-side generate/choose paths and the effect generators
are gone, each behind a migration diagnostic — the `sounds/` directory
itself gets the fold instructions, a `sound:` entry is forwarded to the
track its target became, the `sound:` label forwards to `track:`
(decision 5), and a pre-fold takes file is told the `gen:` rename.
bloom's graph came through untouched: `field build //songs/...` after
the retirement is entirely cache hits.
The chunk order changed on the way in; §9
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

   Amended 2026-08-08: "time mapping" here means the **timeline the signal
   is read under** — a track's tempo and meter maps, which §13 made a
   precise thing — and not the **offset origin**, where the audio lands.
   The two are one phrase apart in the sentence above, and only the first
   is inherited. Taking it as the second is the reading §14 rules out:
   measuring a send's arrival from the target's origin would slide a
   reverb off the sound it is reverberating whenever the bus moved. The
   distinction did not exist when this was written, because a track had no
   timeline of its own to inherit.

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

    Landed 2026-08-08: `track.gain_db`/`pan` are gone from the schema, not
    merely unused. They survived one commit past the mix rule that read
    them, during which a `-24` on a track file passed `check` and changed
    nothing. Turning the *song* down is this decision's own move applied to
    the root — another gain stage is another level, so `main` places a
    `body` track and carries the level on that placement, measured at
    exactly -12.0 dB for `gain_db: -12`.

    Consequence for chunk 3: `pan` is the same stage as gain, so it moves
    to the edge too — and the daemon's stem op sums clips with a gain and
    **no pan**. Per-clip pan in `sumClips` is the prerequisite, and the
    reason `check` refuses a placed track whose pan is set.

14. **Tracks, not channels (2026-08-08).** *Rejected: renaming everything
    to `channel`*, which was seriously considered and lost on two counts.

    `channel` is already taken: it means L/R throughout the audio layer
    (`wav.channels[0]`, "mono or stereo only"). Re-derive the scale rather
    than trusting a figure written down once — each of these prints its
    own number, 141 and 104 when this was written:

    ```
    git grep -w -e channel -e channels -- src | wc -l
    git grep -w -e channel -e channels -- native/audiod/src | wc -l
    ```

    The layers barely meet, so this is a cost rather than a blocker, but it
    is a cost paid in exactly the place error messages are read.

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

Amended 2026-08-08: the two sends clauses — the shared reverb and the
reach-into-itself message — move to the real-time engine with §7 chunk 4,
for the reason in §14. Everything else here is met: creek is three
placements of one `phrase` (§10), the pad and the lead vocal span above
them, and the restructure was measured against the flat version at
−144 dBFS with the two seams accounted for.

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
  piece that is not moving fields around. Landed 2026-08-08 (#76), reusing
  the `balanceGains` the faders already used rather than writing a second
  copy of the law. What remained of chunk 3 after it was only surfacing
  the effective level, which is §12.
- **Negative `at`.** §1.6 allows it for pickups; `timePosition` is
  non-negative today, for clips as much as for placements, so allowing it
  is a change to the time primitive rather than to nesting.
- **Placement identity.** §6's open question. Placements are named by
  position in diagnostics until it is answered.

## 10 What chunk 5 decided (2026-08-08)

§7 chunk 5 exists to answer one question — does the structure read better
than the flat version — and it can only be answered by writing it. creek
is now three placements of a four-bar `phrase` in `examples/bloom`.

**The answer is yes, and the reason is what moved out of prose.** Before,
`song.yaml` said "twelve bars: three passes of the keys phrase" in a
comment, and the three passes existed as `loop: every: [4]` inside one
clip on one track. Nothing structural said creek repeats. Now `main`
lists the phrase three times, at bars 1, 5 and 9, and the two things that
are *not* the repeating unit stay at the root and say so: the pad crosses
a phrase boundary (its second clip enters a beat before bar 5) and the
vocal skips the first pass entirely.

`bed` is the sharper evidence. It was a hand-copy of main's instrument
list minus the vocal, carrying duplicated `gain_db` and `pan` that had to
be kept in step by hand. It is now the same three placements minus the
one that carries the voice. Decision 6 argued that a subset should be a
track rather than a mode; this is that argument paying out on the only
subset the project actually has.

**One gap, which is the real finding.** A loop owns its seam treatment and
a placement does not. `loop.fade` defaults to 480 samples precisely
because "the naive loop must not click", and expressing the same
repetition as three placements drops it silently — nothing warns, and
`check` is happy. creek survives because its phrase render begins and
ends at 0.0008 (−62 dBFS, effectively silence), so butt-joining introduces
no discontinuity: measured, the worst adjacent-sample step at bars 5 and 9
is identical before and after. Material whose phrase does not
self-terminate would click, and the fix available to clips — two
overlapping faded clips, which is how the pad crossfades — is not
available to placements, because placements of one track at two times
cannot overlap without the parent's timeline saying so.

That is not a blocker for creek and it is a real edge for chunk 3 or
chunk 4 to settle: either placements grow a seam treatment, or the
guidance is that a clip that loops stays a looping clip and nesting is
for structure that repeats *containers* rather than samples.

**Cost, measured against the pre-restructure render:** −144 dBFS
everywhere, which is float reassociation from one more summation level
and is inaudible; −62 dBFS in the two one-second windows at bars 5 and 9,
which is the absent crossfade. Both `track:main` and `track:bed` are still
exactly 30.000 s.

*Not done here:* `arrangement.yaml` still exists. It can retire now for
the first time — §5 says the arrangement becomes derived by walking the
root's placements, and only after this restructure do those placements
*be* the arrangement. Before it, the root listed instruments and the file
listed sections, and no walk could have produced one from the other.

## 11 arrangement.yaml retires (2026-08-08)

§5 decided this and chunk 5 unblocked it. The file was
`{sections: [{name, at}]}` — loaded, schema-checked for duplicate names
and ordering, and then read by nothing. A stored copy of the structure
that nothing consumes is a copy that drifts, and creek's had: it named a
`chorus` at bar 13 of a twelve-bar song, and no command could notice
because no command looked.

It could not retire before chunk 5. The replacement is `field arrangement
<song>`, which walks the output track's placements — and until creek was
expressed as three passes of a phrase, those placements were a list of
instruments while the file was a list of sections. No walk could have
produced one from the other. Afterwards they are the same list, so the
derived form is not an approximation of the stored one; it is the thing
the stored one was describing.

```
creek (12 bars)
  1.1.1 0:00.0  lead-vocal  (+3 dB, pan 0.2)
  1.1.1 0:00.0  pad  (-6 dB, pan -0.2)
  1.1.1 0:00.0  phrase
  5.1.1 0:10.0  phrase
  9.1.1 0:20.0  phrase
```

Two details the implementation forced, both of which are the old file's
own bug seen from the other side:

- **A length is a span, not a position.** Printing creek's `length: [12]`
  through the meter map gives `13.1.1`, the downbeat *after* the song.
  That is exactly what `chorus at [13]` was, and it is why the header
  reads `12 bars`.
- **Time order, not file order.** The file's order is authoring order.
  A reader asking what happens when wants the timeline, so placements
  sort by position.

**What is lost: section names.** `intro`, `verse`, `build` are gone —
placements name the track they place, so creek reads as three passes of
`phrase`. That is more honest about creek, whose three passes *are* the
same phrase, and it is a real loss for a song whose sections differ. The
place it comes back is §6's open question, placement identity: a
placement that can be named is a section, and then the derived arrangement
prints the name. Retiring the file first is deliberate — a stored name
that drifts is worse than no name, and the open question is now the only
thing standing between here and named structure.

A leftover `arrangement.yaml` is diagnosed rather than ignored, the
`mixes/` precedent: the file would otherwise sit on disk describing a
structure nothing reads, which is the state that produced `chorus` at
bar 13.

## 12 Effective level, and what would not compose (2026-08-08)

§5 said effective gain lives in `explain`, and §1.13 is why it has to
live somewhere: one gain, on the edge, means a track's own file carries
no level at all. Reading `keys.yaml` tells you nothing about how loud
`keys` is. The answer is spread across every placement above it, in files
`keys` does not know exist.

creek supplies the motivating case without anyone having to invent one.
`keys` sits at −4 dB inside `phrase`, annotated `scratch level while
auditioning variants` — a note written two levels below the output, in a
file nobody opens while listening to the mix:

```
$ field generate //songs/creek/gen:still-water-keys --seed 1   # takes are gitignored
$ field explain //songs/creek/track:keys
reaches: track:bed -4.0 dB, pan 0.2 (via track:phrase, 3 placements)
reaches: track:main -4.0 dB, pan 0.2 (via track:phrase, 3 placements)
```

The `generate` line is not decoration: creek's takes never leave the
machine that made them (bloom-in-tree.md §2.4), so `keys` has no chosen
variant in a fresh clone and `explain` refuses it by name. `pad` and
`drums` need none — between them they show the same four fields, a level
and a pan to two roots and a route with a count.

Three things the implementation forced.

- **Gain composes; pan is listed.** Levels are dB and add, so the sum is
  arithmetic. Pan does not reduce the same way: the daemon applies it as
  a balance that attenuates one side and never boosts, so two pans
  compose per channel rather than into a third pan — hard left then hard
  right is silence, not centre. Collapsing them here would mean a second
  copy of `balanceGains` in TypeScript, drifting against the one the
  audio actually goes through, which is exactly what #76 avoided by
  reusing it for placements and faders alike. So a path reports the pans
  it passes, in order, and says that they do not add up. The composition
  *is* expressible — factor the common attenuation out of the per-channel
  product and what remains is a single pan — but it is not expressible
  without owning the law, and the level question does not need it.
- **Every root, not just the song's output.** `bed` is creek's second
  render target: nothing places it, and `field build creek/track:bed`
  renders it. A walk that stopped at `main` would report that `keys`
  reaches one place when it reaches two, and would have been invisible in
  testing — creek's only two-hop path is `-4 + 0`, where summing and
  taking the nearest gain agree. Both gaps survived the first round of
  tests and were caught by mutating the code rather than by reading it.
- **A track nothing places says so, and which kind it is.** "This is the
  song's output" and "nothing consumes this" are the same graph fact and
  very different news — the second is also what a typo in an `inputs:`
  entry leaves behind.

*Not done here:* sounds and clips. A clip carries `gain_db` and no `pan`
(pan went to the edge with §1.13), so extending the walk down to
`//songs/creek/sound:still-water-keys` is one more hop of the same
addition. It waits for §1.11, where clips and placements become one list:
doing it now would encode the two-list shape in a third place a week
before it goes away.

Deliberately still not a `check` warning, per §5. Nothing here is an
error — a −4 dB scratch level is a decision somebody made, and the
command that surfaces it is the one you run when a number surprises you.

## 13 Local time, and where it is inherited from (2026-08-08)

§7 chunk 2's last piece. A track may declare `time:` with a `tempo`, a
`meter`, or both; a 7/8 figure inside a 4/4 song is a track that says so.
That is what takes up
[project-core.md](project-core.md) §3.1's deferral of loops with their own
internal timeline — the local timeline turned out to be a property of
every track rather than a feature of loops, exactly as §1.5 predicted.

**Inheritance is from the song, never the parent.** §1.5 says song time is
"the composition of the maps from the root down", which reads as a track
inheriting from whatever places it. That cannot work, and §1.3 is the
reason: a track may be placed in more than one parent, and it renders
*once*. One stem, one cache entry, six placements in creek's case. A
single render cannot hold two meanings for "bar 2", so the fallback has
to be something singular, and the only singular thing above a track is
the song. This is forced rather than chosen — it is §1.3's consequence
arriving somewhere §1.5 had not been pushed.

**The maps never compose; only offsets add.** This is the part that made
the chunk small. A track renders to samples in its own time, starting at
its own sample 0. Its parent's `at` resolves to samples under the
parent's map. The daemon sums by sample offset. So a 7/8 child inside a
4/4 parent is an addition, and at no point does anything convert between
two meters — a conversion that has no meaning anyway, since the two
timelines are not measuring the same thing. Everything in one track file,
its clips and the `at` of every track it places, is in that one track's
time.

*Amended 2026-08-09 (multi-rate.md §3): offsets add within a rate.* A
track may now declare `rate:`, and its whole file — ticks included —
projects to samples at that rate, so the parent computes its offset in
its own rate and the child's stem passes through the edge's resample
node before the sum. The addition itself is untouched: every stem the
daemon sums arrived at the summing track's rate, and the tick layer
never was rate-dependent.

The unit is the *track*, though, not quite the file. A take under
`takes/<track>/` is a recording on that track, so its ticks are in that
track's timeline too, and `check`'s cross-check of `position` against
`position_samples` (project-core.md §3.1) has to derive through the same
map. It did not in the first version of this — it used the song's, which
rejected a take whose samples were right for the track it was recorded
on. Found in review (#95), which is the second thing on this branch that
only showed up once something outside the track file had to agree with
it.

**Each half is independently optional**, and that is a choice rather than
a consequence. The polymetric case usually wants a different meter at the
*same* tempo; demanding both would copy the song's bpm into a track file
that cannot be told when the song's changes. A second copy of one fact
that drifts is what §11 retired `arrangement.yaml` for.

**A broken local map does not fall back to the song's.** The first
implementation did, silently, because the resolver defaulted its map
argument — a track with an unparseable meter had its positions resolved
against a map its author never wrote, producing plausible numbers on top
of a reported error. The map is now a required argument with no default,
and `undefined` means *no valid map applies* rather than *none was
given*.

Two things worth recording about proving it:

- **Nothing that exists re-keys.** creek's four track action keys
  (`d723eef188f5`, `9953828a1b8b`, `7b2c2d14f283`, `9bf70a2d4afb`) are
  byte-identical before and after and still report `cached`, which is the
  claim "the song's map when the track declares none" makes and the only
  way to check it.
- **A local meter alone cannot test the render path.** The meter decides
  a tick position at load; ticks become samples through the *tempo* map.
  So a 7/8 track at the song's tempo passes every assertion with the
  graph still handing `planTrack` the song's map. The first version of
  the test file did exactly that, and it took mutating the graph to
  notice. Only a track with its own `tempo` exercises it.

*Not done here:* `field arrangement` still prints through the song's
meter, which is right for every project today and wrong the moment the
output track itself declares `time:`. It is a two-line fix in the same
place §11's length header already reads the map from, and it waits until
there is a project that can tell the difference.

## 14 Sends wait for the real-time engine (2026-08-08)

§7 chunk 4 is deferred until the engine
([audio-engine.md](../../audio-engine.md)) exists, which already lists
`routing/buses/sends` among its responsibilities. Nothing in §1.7 or §1.8
is withdrawn — the target rule, the cycle detection, the reach-into-itself
message and level-not-offset all stand, and they are the specification for
whoever builds it. What is deferred is building it *offline*.

**What surfaced.** A send declares no `at` (§1.8), so an offline renderer
has to derive one: at what offsets does the sent signal arrive? The
motivating case in §1.7 is `snare` inside `verse` with `verse` placed at
bars 5 and 13, and the answer there is clearly "both" — the send delivers
the source at every offset it occupies, which is §12's `reaches` walk
carrying offsets instead of gains. But that only fixes the *source* side.
The target has placements too, and if a plate is itself placed at bar 3,
the offsets are either measured from the song (right, and then the plate's
own placement must be forbidden from mattering) or from the target
(wrong — moving a reverb bus would slide the reverb off the sound it is
reverberating). Every rule that makes the first one work amounts to
refusing most targets by name, which is a type distinction reintroduced
through validation after decision 1 removed it from the schema.

**Why that is the feature telling us something rather than a puzzle to
solve.** §1.8 already says a send "routes *signal*, computed as it goes",
and warns that faking it offline is "the trap: a project would render one
way and play another". That argument was made about negative delay; it
applies to the whole edge. A placement expresses a *position* and a send
expresses *flow*, and offsets are how an offline model spells position —
so an offline send is the one construct in this design that has to be
translated into a vocabulary it does not share. In real time the question
does not arise: there are no offsets, the signal arrives when it arrives,
and the level is the only thing the edge ever carried.

**This does not undo §9's sequencing.** Nesting went before the engine
because it changes the model the engine renders, and that is still why
chunks 1–3 and the local timelines landed first. Sends do not change that
model — they add an edge kind on top of a containment graph that is
already built and already rendering. Adding one later costs nothing that
adding it now would have saved, and adding it now costs a set of offline
alignment rules that the engine would immediately make wrong.

**Consequence for §8.** The definition of done loses its sends clause
until then; see the note there. What remains of this plan is chunk 6,
folding `sounds/` in.

## 15 Chunk 6 is not only a layout change (2026-08-08)

§7 chunk 6 calls itself "a layout and namespace change rather than a
behavioural one, and it should not be able to break nesting on its way
in". The second half holds. The first does not, and bloom shows it
without needing a hypothetical.

Decision 12's headline example is that an `eq` sound becomes a track with
one input and one insert. bloom has three of those — `kit-punch` (eq on
`kit-sc`), `vocal-48k` and `loop-cd` (normalize). None of them could be
written as a track:

- `inputs[].track` is a slug naming a *track*, and `kit-sc` is a sound, so
  the wrapped thing cannot go in `inputs:`.
- The other way in is a clip, and a clip's `duration` was **required**
  while a placement's is optional.

So the fold would have forced a hand-written duration onto every effect
wrapper, matching the render length of whatever it wraps, with nothing
keeping the two in step when that render changed. That is the second
structure that drifts, introduced by the chunk that was supposed to move
files.

The asymmetry had a stated reason, in `stem.ts`: a clip's duration is
required because "a clip's source is committed content whose length
validate can read, while a child track's render length is unknowable at
plan time". True of an asset. False of a buildable sound — `kit-sc` is a
SuperCollider render whose length is as unknowable while planning as any
track's, and which `execute()` already resolves for placed tracks. The
rule was right about assets and had been generalised to clips, which is
why it survived: every clip in the project happened to be one of the
cases it was true for.

So an omitted clip duration means the whole source, and chunk 6 gets §1.11
early — not the whole merge of `clips:` and `inputs:`, just the one
property that made them different in a way that mattered. Landed
2026-08-08; project-core.md §3.2 carries the amendment, since that is
where the requirement was decided.

**One trap, worth recording because it nearly shipped.** The loader bailed
out of the entire clip block when a duration failed to resolve, and an
absent duration resolves to `undefined` by the same path. Making the field
optional therefore silently turned `duration:` into a way to skip the
source check, the id check and the fade check — a clip pointing at a
nonexistent sound passed `check` clean. Absent and unresolvable have to
stay distinguishable, and a test now holds each of them.

**The layout question in §6 is answered: `sounds/` goes entirely**
(2026-08-08). Two shelves for one kind is the "four nouns for one object"
problem decision 1 removed, one layer down —
[project-layout.md](project-layout.md) §4.5's rule that a package is the
singular of its directory would give a single kind two label packages.
§4.1's argument for the shelf was that "the audio/sounds pair teaches the
system's central distinction: audio is committed bytes, a sound is a
definition", and that pair survives the rename: `audio/` against
`tracks/` teaches it just as well, because the definition side is now the
only side that was ever authored.

Remaining, in order: effect sounds become tracks; leaf content for
`supercollider` and `generative`, which is §6's third open question and
the only genuinely undecided part; then `sounds/` and the `sound:` label
retire, forwarding.

## 16 Chunk 6 pauses on normalize (2026-08-09)

§15's "effect sounds become tracks" stopped one file in: `normalize` has
no insert form, and reading bloom's two normalize sounds showed why it
never will — they are different features. `vocal-48k` conditions an input
to the project rate (its `sample_rate` can only hold one correct value;
its `bit_depth` is unobservable on an internal float stem), while
`loop-cd` formats a CD deliverable nothing references because nothing
should. One schema, two jobs, neither an insert.

Pulling that thread reached a real decision — whether a project can hold
more than one sample rate — and that is its own plan:
[multi-rate.md](multi-rate.md), which records the answers (outbound
formatting moves to `field export`; a track may declare `rate:`;
conversion is an automatic cached node on the placement edge; import
reads headers and warns). Chunk 6 resumes after that plan's step 2 frees
`loop-cd` to retire; the eq fold and the leaf-content question (§6) are
unaffected by it but sequenced behind it so the sounds shelf empties once
rather than twice.

## 17 The eq fold lands: a clip plays a track (2026-08-09)

§16's tail sequenced the eq fold behind multi-rate "so the sounds shelf
empties once rather than twice", and that reasoning did not survive the
morning: the shelf *retires* once either way — retirement is the finale's
move — and a file leaving it early empties nothing twice. Resequenced
2026-08-09: the fold is decided, unblocked and small, so it goes first,
with the multi-rate steps interleaved behind it. `kit-punch` is now a
track with one clip and one insert, and `sounds/kit-punch.yaml` is gone.

**The transition spelling is decided: a clip plays a track as
`source: track:<name>`.** The same string a placement already wires in
`sources` and the label already uses (`//songs/creek/track:drums`), now
legal where an author writes it. A bare slug keeps meaning the song's
one namespace — assets and sounds — because tracks are deliberately
outside it (a track and a sound may legally share a name today), and a
bare slug that tried both would be a search path, which project-core.md
§3.4 has forbidden since it was written ("two ways to resolve one name").
Whether a bare slug ever comes to mean a track is the
finale's question, when `sounds/` retires and the namespaces actually
merge — undecided here, deliberately. That merge is also where `check`
owes a migration-quality collision message and `field import`'s
name guard widens; nothing merges yet, so neither changed yet.

A clip that plays a track is checked exactly as a placement is (unknown,
self, midi — each with the placement's own message shape), joins the
containment-cycle walker as an edge, counts toward `explain`'s level
answer with its `gain_db` (clips carry no pan), and still requires
`loop.every` to loop — a track's length is as unknowable at plan time as
any buildable's. It keeps the clip powers a placement lacks:
`source_offset`, `slip`, loops. The graph needed nothing: `refLabel` has
resolved `track:` refs since placements landed, so the authored spelling
and the wiring spelling are now one string.

**The proof the fold is only a fold:** `kit-punch`'s own action key
changed by construction — rule `eq` became rule `stem` — so the claim is
not "same key" but "same audio", and it held bit-for-bit: the track
render hashes identically to the sound render it replaces
(`d1ae4edb90b7…`). Because action keys see content hashes and never
spellings, `drums` — whose YAML changed from `kit-punch` to
`track:kit-punch` — kept its key (`6cd170a1cbfe`, cached), and
`field build creek/track:main` came back entirely from cache: the whole
song, bit-identical, through a model with one fewer kind in it.

## 18 One list: a track's inputs (DECIDED, 2026-08-09)

A track file is a name, an optional `time:`, optional `inserts:`, and
one list: `inputs:`. Every entry places one thing on the track's
timeline, the thing is named by the entry's field, and there are three
kinds of thing:

- `track: <name>` — another track's render
- `audio: <name>` — committed bytes, from the song's ledger or the one
  cross-scope spelling, `audio: //shared/asset:<name>`
- a generator block, authored spec inline — `supercollider: {...}` or
  `generative: {...}`

Placement fields are uniform across kinds — `at`, `duration`, `loop`,
`source_offset`, `slip`, `gain_db`, `pan`, `fade_in`, `fade_out`, and
an `id` — because there is no field among them whose meaning depends on
what produced the audio. Any kind, any count, anywhere: generators will
usually be one per track by convention, because that is what you want
to name and reuse, and the schema does not enforce a convention.

```yaml
name: drums
inputs:
  - track: kit-punch
    at: [1]
    duration: [4]
    loop:
      every: [2]
      fade: 0
```

What this decides, and what it retires:

1. **§1.11 lands in full, and the file format catches up with the
   planner.** `planTrack` has sorted clips and placements into one list
   since placements existed — the two-list split was only ever spelled
   in YAML. `clips:` retires. A `content:` leaf block, proposed on the
   way to this decision, never ships: "the track *is* its content"
   turned out to be nothing more than "the track has one input", so the
   identity-versus-edge distinction the block encoded dissolves into
   the list.

2. **The kind lives in the field name, never in a value prefix.** #100's
   `source: track:kit-punch` (§17) lived exactly one PR: it read as a
   type error — a source that is a track — and the fix is that no field
   ever holds more than one kind. *Rejected: value prefixes* (`source:
   track:x`), for that reading. *Rejected: restricting generator
   entries to leaf tracks* — the only real dependency was run-recorded
   state needing a stable attachment point, which `id` provides
   (below).

3. **Ids answer §6's placement-identity question by construction.**
   Every entry may carry an `id`; automation attaches to entries, not
   to ex-clips specifically. A `generative` entry must carry one,
   because its takes attach to it: run-recorded state (variants,
   `chosen`) stays out of the track file exactly as it stays out of a
   sound's recipe today, living under `audio/<track>/`, keyed by the
   entry's id. The exact file shape — and how `field generate <track>`
   resolves when the track has one generative entry — is the
   implementing chunk's to settle, with a migration for today's
   `audio/<name>/variants.yaml`.
   Amended 2026-08-09 (step 3, settled on concrete files): the id
   requirement fell. Takes key on the *gen node's name* — the owning
   track's, or `<track>-<id>` — the uniform rule supercollider entries
   got at step 2, so a leaf's takes live at
   `audio/<track>/variants.yaml` and the common fold moves no files:
   `still-water-keys`' directory survived its fold untouched. The file
   says `gen: <name>` where it said `sound: <name>` (a one-line rekey,
   told by a check diagnostic), and `field generate`/`field choose`
   take the node name, so the sole-entry leaf reads as `field generate
   <track>`. The stable attachment the required id was for is the
   name itself: renaming a track orphans `audio/<track>/` exactly as
   it always did for a renamed sound, and check diagnoses both the
   same way — a takes file in a directory no generative request
   claims is named as a rename's leftover. (Review caught this
   sentence promising the diagnostic before it existed; the scan that
   makes it true covers both sides, so the sound half is new too —
   nothing opened `audio/` before it.) Ids stay what the first
   sentence says — optional, for automation and for telling two
   generators apart.

4. **`type:` leaves the track file.** Every track is audio; `midi` was
   a placeholder kind that renders nothing, places nothing, and is
   placed by nothing. When MIDI becomes real it arrives as an entry
   kind — a part driving an instrument is content a track plays — which
   is decision 1's no-kinds argument applied to the schema's own
   discriminator. A future track-level kind has to argue against
   decision 1 to return.

5. **The namespace collision §17 recorded as the finale's sleeping
   issue dissolves.** With kind-in-field, no bare namespace ever holds
   both bytes and tracks: `audio:` resolves in the ledger, `track:`
   among tracks. The migration-quality `check` collision message and
   the `field import` guard widening that §17 anticipated are no longer
   owed. The `sound:` label still forwards to `track:` at the finale —
   labels are a separate grammar and keep their own compatibility
   story.

6. **Every existing action key survives the format change.** Entry
   spelling is wiring (`sources` never reaches a key); the resolved
   placement plan for every existing structure is identical entry for
   entry, so the migration must prove itself the way #100 did: drums
   stays `6cd170a1cbfe`, `field build creek/track:main` comes back
   entirely cached. The leaf folds owe the same proof downstream:
   however a generator entry is keyed internally, the folded track's
   bytes are identical, so every consumer's key holds.
   Amended 2026-08-09 (#103, the first fold): the downstream half was
   wrong. The wrapper stem re-encodes what scsynth wrote (24-bit →
   float32), so the folded track's bytes differ while its samples do
   not: each *direct* consumer re-keys exactly once and re-renders
   byte-identically, and everything below it stays cached — kit-punch
   came back `d1ae4edb90b7…`, the hash it has carried since #100. The
   proof a fold owes is "the layer under the direct consumers never
   moves", not "nothing rebuilds". Step 3's folds pay the same one-time
   price: wrapping a chosen take's committed bytes in a stem re-encodes
   them the same way, so expect their direct consumers to rebuild once,
   byte-identically.

Sequencing, revising §16's tail and §17's remainder:

1. **The format lands alone**: `clips:`/`inputs:` become one `inputs:`
   list with `track:`/`audio:` entries, `type:` goes, ids and uniform
   fields arrive; bloom rewrites; the old spellings get `mixes/`-grade
   diagnostics naming what to move where; the cache proof above gates
   it. No generator entries yet.
2. **`supercollider:` entries** — `kit-sc`, `pad-sc`,
   `seven-eight-loop` fold into tracks.
3. **`generative:` entries** — `generate`/`choose` retarget to entries;
   `lead-take` and `still-water-keys` fold, takes migrating per
   decision 3.
4. **Multi-rate interleaves unchanged** ([multi-rate.md](multi-rate.md)
   §4): its step 2 frees `loop-cd`, its step 3 frees `vocal-48k`.
5. **Finale**: `sounds/` empties, the `sound:` label forwards,
   `rg 'type: normalize' examples/bloom/songs` finds nothing.
