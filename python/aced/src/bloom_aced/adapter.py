# pyright: basic, reportMissingImports=false
"""The one non-strict module: ACE-Step's untyped package, quarantined.

Everything else in bloom-aced is pyright-strict; this module owns the
boundary (ace-generation.md §3.4). File-level `# pyright: basic` rather
than scattered ignores, so the quarantine is one visible line. Imports
are lazy so the daemon starts fast and `hello` answers before any model
work happens.

Wired against ACE-Step 1.5 at the pinned commit, read from source:
`acestep.inference.generate_music(dit_handler, llm_handler, params,
config, save_dir)` with `llm_handler=None` honored when `thinking` is
off, `GenerationConfig.batch_size` as the variants knob, and per-variant
outputs in `result.audios[i]["path"]`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .protocol import GenerateJob

ProgressCallback = Callable[[float, str], None]
"""(fraction 0..1, human-readable stage) — forwarded to socket clients."""

CONFIG_PATH = "acestep-v15-turbo"


def models_root() -> Path:
    """Machine-global weights home: ~10 GB must never duplicate per project."""
    override = os.environ.get("BLOOM_ACE_MODELS")
    root = Path(override) if override else Path.home() / ".bloom" / "models" / "acestep"
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass(frozen=True)
class GenerationOutput:
    paths: list[Path]
    seeds: list[int]  # aligned with paths: variant i used seeds[i]
    model: str


class Pipeline:
    """Holds the loaded ACE-Step handler for the daemon's lifetime.

    Loading costs tens of seconds; the daemon-lite lifecycle exists so it
    happens once per session (ace-generation.md §3.3).
    """

    def __init__(self) -> None:
        self._handler = None

    @property
    def loaded(self) -> bool:
        return self._handler is not None

    def ensure_loaded(self, progress: ProgressCallback) -> None:
        if self._handler is not None:
            return
        from acestep.api.model_download import ensure_model_downloaded
        from acestep.api.server_utils import get_model_name
        from acestep.handler import AceStepHandler

        root = models_root()
        checkpoints = root / "checkpoints"
        checkpoints.mkdir(parents=True, exist_ok=True)
        progress(0.0, "downloading/verifying ACE-Step weights (first run pulls ~10 GB)")
        ensure_model_downloaded(get_model_name(CONFIG_PATH), str(checkpoints))
        ensure_model_downloaded("vae", str(checkpoints))

        progress(0.05, "loading models")
        handler = AceStepHandler()
        status, ok = handler.initialize_service(
            project_root=str(root),
            config_path=CONFIG_PATH,
            device="auto",
            use_flash_attention=True,
            compile_model=False,
            offload_to_cpu=False,
            offload_dit_to_cpu=False,
        )
        if not ok:
            raise RuntimeError(f"ACE-Step failed to load: {status}")
        self._handler = handler

    def generate(self, job: GenerateJob, progress: ProgressCallback) -> GenerationOutput:
        self.ensure_loaded(progress)
        from acestep.inference import GenerationConfig, GenerationParams, generate_music

        params = GenerationParams(
            caption=job.prompt,
            lyrics=job.lyrics if job.lyrics is not None else "[Instrumental]",
            instrumental=job.lyrics is None,
            duration=job.duration_seconds,
            seed=job.seed,
            thinking=False,  # no LM in v1: llm_handler=None below is honored
        )
        if job.bpm is not None:
            params.bpm = job.bpm

        # Deterministic per-variant seeds: base seed, +1 per sibling.
        seeds = [job.seed + i for i in range(job.variants)]
        config = GenerationConfig(
            batch_size=job.variants,
            use_random_seed=False,
            seeds=seeds,
            audio_format="wav",
        )

        output_dir = Path(job.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        progress(0.1, "generating")
        result = generate_music(self._handler, None, params, config, save_dir=str(output_dir))
        if not result.success:
            raise RuntimeError(result.error or result.status_message or "generation failed")
        # The recipe pairs variant i with seeds[i]; a partial batch would
        # silently shift that pairing, so all-or-nothing is the contract.
        paths = [Path(audio["path"]) for audio in result.audios if audio.get("path")]
        if len(paths) != job.variants:
            raise RuntimeError(
                f"ACE-Step reported success but produced {len(paths)} of "
                f"{job.variants} requested variants"
            )
        return GenerationOutput(paths=paths, seeds=seeds, model=CONFIG_PATH)
