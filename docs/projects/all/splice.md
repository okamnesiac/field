---
status: Draft
---

# Plan: Splice support

**Status:** Unstarted. Sketched 2026-08-09 from a later.md line; no code, no
PRs. The open questions in §4 gate any chunking.

**Goal:** Bring Splice samples into a song the way ace brings generations in:
search parameters go in, a TUI auditions the options, choosing one commits
the sample with the full recipe of how it was found — so a song can always
list its Splice samples and fetch their licenses.

## 1 Shape

Shaped like ace, not like import. `field import` takes bytes it knows nothing
about; the whole point here is that Field ran the search, so it knows
everything — and writes it down.

- **The recipe records the search, the choice, and the license.** Unlike an
  ace recipe it *documents* rather than reproduces: the same query against
  Splice's catalog returns different results next year, and the license is
  tied to the account that downloaded the sample. So the bytes are committed,
  never re-fetched — the same committed-not-cached stance as
  [ace-generation.md](ace-generation.md) §3.1, arrived at from a stronger
  premise (there is no seed to replay).
- **The chosen sample resolves by label; no ledger row is minted.** The
  seam this bullet first named — choose imports the pick as an ordinary
  asset — was ace-generation.md §3.1 as written, and project-layout.md
  §4.8 (DECIDED) dissolved it: choosing repoints what a label means, and
  a recipe minting an asset named for itself would self-collide under
  §4.3's one namespace. A Splice recipe named for its sample is that
  same collision, so the same fix applies: the recipe's own label
  resolves to the chosen bytes, exactly as a generative sound's does and
  as gen nodes do after nested-tracks.md §18 step 3. The graph, entries,
  and takes see committed content either way. The item is a directory
  (project-layout.md §4.11): `audio/<name>/` holds the sample, the
  recipe, and the stored license together.
- **Browsing is a TUI** — search, filter, audition previews, pick. This
  is Field's first *input*-interactive surface, which is most of the real
  cost of this plan and the reason it sits in Later. It is not the first
  live tty surface: `src/commands/loop-ui.ts` (watch.md §2) already
  renders ANSI with a plain sequential fallback, and its discipline —
  rendering as a pure function over an injected write — is the one to
  inherit rather than re-decide.

A recipe, concretely — living in the item's directory (§4.11) beside
the bytes and the license it names, with `type:` as the discriminator
the format settled on (project-layout.md §4.2):

```yaml
# songs/creek/audio/dusk-break/splice.yaml
type: splice
searched: 2026-08-09
query: dusty breakbeat
filters:
  bpm: 140-160
  key: f minor
  instrument: drums
chose:
  sample: OS_DUSK_150_drum_break_fmin.wav
  pack: DUSK — Nostalgic Breaks
  provider: Origin Sound
license:
  file: audio/dusk-break/license.pdf
  sha256: <hash of those bytes, so check can verify the proof exists>
```

## 2 What provenance pays for

Both fall out of the recipe existing; neither is possible for anonymous
imported bytes.

- **`field splice list [song]`** — every Splice sample the song *stores*,
  with pack and provider: a query over recipes, nothing more. Stored and
  used can differ — a sample removed from every track keeps its bytes
  and recipe until someone deletes them — and telling them apart is a
  `deps()` walk from the output track over the same names, cheap for
  the same reason the list is.
- **Licenses, fetched and kept.** Splice's license is per-sample and lives
  in their account pages; the recipe stores it content-addressed next to the
  asset, so the proof travels with the project instead of with the
  subscription.

## 3 Definition of done

Search from Field, audition in the TUI, choose; the sample plays in a real
song; `field splice list` names it; the license is in the repo; the recipe
reads as a reviewable diff.

## 4 Open questions

1. **How Field talks to Splice.** There is no official public API. Two
   candidate routes, unverified: the local library the Splice desktop app
   maintains (files plus a metadata database — browse what the account
   already downloaded, no network side at all), or the unofficial endpoints
   the web app uses (full catalog search, but fragile and possibly against
   terms). The local-library route is smaller, honest about licensing, and
   may be the whole v1 — "browse my Splice library" rather than "browse
   Splice". Verify what actually exists before chunking.
2. **Whether the TUI lives in `field`** or as a separate tool that ends by
   invoking the non-interactive commands. Bears on every future interactive
   surface, so worth deciding deliberately, not by default.
3. **Preview playback** — through audiod like everything else, or something
   throwaway for auditioning short previews. Leaning audiod: auditioning in
   the mix is the ace lesson worth repeating.
