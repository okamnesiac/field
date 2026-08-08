"""The field-aced wire protocol: NDJSON over a unix socket.

Same family as field-audiod's (playback.md §3.3): request/response with
client-chosen ids, broadcast events, a versioned hello. The TS side's zod
schemas are the cross-language source of truth; this module is the typed
Python mirror.
"""

from __future__ import annotations

from dataclasses import dataclass

from field_worker.protocol import JsonObject
from field_worker.protocol import required_int as _required_int
from field_worker.protocol import required_number as _required_number
from field_worker.protocol import required_str as _required_str

DAEMON_NAME = "field-aced"
DAEMON_VERSION = "0.1.0"
SOCKET_DEFAULT = ".field/aced.sock"


@dataclass(frozen=True)
class GenerateJob:
    """One generation request: everything the recipe records.

    Durations are seconds here — musical time is projected by the CLI,
    exactly as with the playback daemon (the worker never learns what a
    bar is).
    """

    prompt: str
    duration_seconds: float
    seed: int
    variants: int
    output_dir: str
    lyrics: str | None = None
    bpm: int | None = None  # from the song's tempo map, projected by the CLI

    @staticmethod
    def from_request(request: JsonObject) -> "GenerateJob":
        def required_str(key: str) -> str:
            return _required_str(request, key, "generate")

        def required_number(key: str, minimum: float, maximum: float) -> float:
            return _required_number(request, key, "generate", minimum, maximum)

        lyrics = request.get("lyrics")
        if lyrics is not None and not isinstance(lyrics, str):
            raise ValueError("'lyrics' must be a string when present")
        bpm: int | None = None
        if request.get("bpm") is not None:
            bpm = _required_int(request, "bpm", "generate", 30, 300)
        return GenerateJob(
            prompt=required_str("prompt"),
            duration_seconds=required_number("duration_seconds", 10, 600),
            seed=_required_int(request, "seed", "generate", 0, 2**31 - 1),
            variants=_required_int(request, "variants", "generate", 1, 8),
            output_dir=required_str("output_dir"),
            lyrics=lyrics,
            bpm=bpm,
        )
