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
- **The chosen sample is an ordinary committed asset**, landing through the
  same seam ace's chosen variants use, with the recipe beside it. The graph,
  clips, and takes see a normal asset.
- **Browsing is a TUI** — search, filter, audition previews, pick. This is
  Field's first interactive surface, which is most of the real cost of this
  plan and the reason it sits in Later.

A recipe, concretely:

```yaml
kind: splice
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
license: <content hash of the stored license document>
```

## 2 What provenance pays for

Both fall out of the recipe existing; neither is possible for anonymous
imported bytes.

- **`field splice list [song]`** — every Splice sample a song uses, with
  pack and provider: a ledger query over recipes, nothing more.
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
