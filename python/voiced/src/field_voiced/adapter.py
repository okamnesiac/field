# pyright: basic, reportMissingImports=false
"""The one non-strict module: Chatterbox's untyped package, quarantined.

Everything else in field-voiced is pyright-strict; this module owns the
boundary, exactly as field_aced/adapter.py owns ACE-Step's
(ace-generation.md §3.4). File-level `# pyright: basic` rather than
scattered ignores, so the quarantine is one visible line. Imports are lazy
so the daemon starts fast and `hello` answers before any model work
happens — and so the protocol tests run on a bare interpreter with no
torch at all, which is the coverage the aced harness already proved is
worth having (#59).

Wired against chatterbox-tts 0.1.7, read from the published wheel rather
than from its README:

  - `ChatterboxTTS.from_pretrained(device)` pulls five files from the
    `ResembleAI/chatterbox` HF repo and handles the MPS-unavailable
    fallback to CPU itself, so we pass the preference and let it decide.
  - `generate(text, audio_prompt_path=None, exaggeration=…, cfg_weight=…,
    temperature=…)` returns a `(1, N)` float tensor, watermarked.
  - `conds.pt` is among the downloaded files and is loaded as a builtin
    voice, which is what makes `audio_prompt_path=None` a real default
    voice rather than an error path (voice-generation.md §6).
  - **`generate` stores the conditionals it derives.** With a reference,
    `prepare_conditionals` assigns `self.conds`; without one it merely
    asserts `self.conds is not None` and reuses whatever is there. The
    model outliving a single job — which is the entire point of the
    daemon-lite lifecycle — therefore means one referenced job leaks its
    voice into every later default-voice job in the session. The recipe
    would say default and the committed audio would be someone else's
    voice: provenance that lies, which §1.1 exists to prevent (#60
    review).
  - `model.sr` is 24000 (`S3GEN_SR`). **Generated audio is 24 kHz**, so a
    voice variant is not at any project rate: creek will wrap it in a
    `normalize` sound, which is the rule render-pipeline.md chunk 5 just
    rebuilt around our own resampler.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

from field_worker.protocol import GenerationOutput, JsonObject
from field_worker.server import ProgressCallback

from .protocol import VoiceJob

MODEL_NAME = "chatterbox-0.1.7"


def device_preference() -> str:
    """Apple Silicon by default; `from_pretrained` falls back to CPU itself."""
    return os.environ.get("FIELD_VOICE_DEVICE", "mps")


def _detached(value: Any) -> Any:
    import torch

    if torch.is_tensor(value):
        # detach before clone: a device copy of a `requires_grad` tensor
        # is not a leaf, which is exactly what `copy.deepcopy` refuses.
        return value.detach().clone()
    return copy.deepcopy(value)


def clone_conds(conds: Any) -> Any:
    """An independent copy of a `Conditionals`, safe to hand to `generate`.

    `copy.deepcopy` looks like the obvious way to do this and fails
    on the product's default path: "Only Tensors created explicitly by
    the user (graph leaves) support the deepcopy protocol". The whole #60
    leak fix ran through that deepcopy, so it worked against a reading of
    the source and not at all against a loaded model.

    **The cause is the device transfer, and saying so matters.**
    `gen.embedding` is stored in `conds.pt` with `requires_grad=True` but
    arrives a leaf; `from_local` then finishes with `.to(device)`, and
    `Conditionals.to` calls `v.to(device=…)`, whose result carries a
    `grad_fn` — no longer a leaf, which is what deepcopy refuses. So the
    failure is conditional on the device (#64 review, verified against
    the cached `conds.pt`):

        as loaded          non-leaf: none            deepcopy: OK
        after .to('cpu')   non-leaf: none            deepcopy: OK
        after .to('mps')   non-leaf: [gen.embedding] deepcopy: RuntimeError

    `.to('cpu')` is a no-op on tensors already there, so they stay leaves
    and the old code passes — on CPU, and on any CI runner without MPS.
    `device_preference()` defaults to `"mps"`, so the default path is the
    broken one, which is why the first real run on a Mac found this and
    nothing before it could have. It also means no test here can guard
    it: a regression test would pass on the runners we have. This
    paragraph is the guard, so leave it pointing at the device rather
    than at forward passes — the wrong cause sends the next reader to
    `FIELD_VOICE_DEVICE=cpu`, where reverting to deepcopy looks fine.

    Field-by-field instead, detaching each tensor, which is the same
    shape Chatterbox's own `save`/`load` round-trip uses: `T3Cond` is
    rebuilt from its `__dict__`, and `gen` is a plain dict.
    """
    t3 = getattr(conds, "t3")
    gen = getattr(conds, "gen")
    rebuilt_t3 = type(t3)(**{k: _detached(v) for k, v in vars(t3).items()})
    rebuilt_gen = {k: _detached(v) for k, v in gen.items()}
    return type(conds)(rebuilt_t3, rebuilt_gen)


class Pipeline:
    """Holds the loaded Chatterbox model for the daemon's lifetime.

    Loading costs tens of seconds; the daemon-lite lifecycle exists so it
    happens once per session rather than once per line.
    """

    def __init__(self) -> None:
        self._model = None
        self._builtin_conds = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def parse_job(self, request: JsonObject) -> VoiceJob:
        """The Backend half that is voice's: what a generate request means."""
        return VoiceJob.from_request(request)

    def ensure_loaded(self, progress: ProgressCallback) -> None:
        if self._model is not None:
            return
        from chatterbox.tts import ChatterboxTTS

        progress(0.0, "downloading/verifying Chatterbox weights (first run pulls ~2 GB)")
        progress(0.05, "loading model")
        model = ChatterboxTTS.from_pretrained(device=device_preference())
        # The pristine builtin voice, kept aside before any job can
        # replace it. Copied rather than referenced because `generate`
        # mutates `conds.t3` in place when exaggeration differs, so a
        # shared reference would not stay pristine for long.
        self._builtin_conds = clone_conds(model.conds)
        self._model = model

    def generate(self, job: VoiceJob, progress: ProgressCallback) -> GenerationOutput:
        self.ensure_loaded(progress)
        import torch
        import torchaudio

        # Bound once rather than reached for per variant: `ensure_loaded`
        # has just set it, but the narrowing does not survive the call.
        model = self._model
        assert model is not None

        output_dir = Path(job.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Deterministic per-variant seeds: base seed, +1 per sibling, the
        # same rule field-aced uses so a recipe reads the same either way.
        # Seeding makes siblings differ from each other reproducibly
        # *within* a run; it does not make the run reproducible across
        # torch or model versions, which is exactly why §1.1 commits the
        # output instead of regenerating it from the recipe.
        seeds = [job.seed + i for i in range(job.variants)]
        paths: list[Path] = []
        for index, seed in enumerate(seeds):
            progress(0.1 + 0.85 * (index / job.variants), f"generating variant {index + 1}")
            torch.manual_seed(seed)
            if job.voice_ref is None:
                # Restore the builtin before every unreferenced variant.
                # A fresh copy each time, not the stored one: `generate`
                # may mutate what it is handed.
                model.conds = clone_conds(self._builtin_conds)
            # Only what was asked for. Passing Chatterbox's defaults
            # explicitly would look identical today and silently pin them
            # if the model's defaults ever moved — the recipe says what
            # was requested, and absent means "whatever the model does".
            #
            # `conviction` is our name for `cfg_weight` (§8): the
            # translation lives here because this module is the boundary
            # where Chatterbox's vocabulary starts.
            knobs = {}
            if job.exaggeration is not None:
                knobs["exaggeration"] = job.exaggeration
            if job.conviction is not None:
                knobs["cfg_weight"] = job.conviction
            wav = model.generate(job.text, audio_prompt_path=job.voice_ref, **knobs)
            path = output_dir / f"{index + 1}.wav"
            torchaudio.save(str(path), wav, model.sr)
            paths.append(path)

        # The recipe pairs variant i with seeds[i]; a short batch would
        # shift that pairing silently, so all-or-nothing is the contract —
        # the same rule as ACE's, for the same reason.
        if len(paths) != job.variants:
            raise RuntimeError(
                f"Chatterbox produced {len(paths)} of {job.variants} requested variants"
            )
        return GenerationOutput(paths=paths, seeds=seeds, model=MODEL_NAME)
