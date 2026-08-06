"""The bloom-aced wire protocol: NDJSON over a unix socket.

Same family as bloom-audiod's (playback.md §3.3): request/response with
client-chosen ids, broadcast events, a versioned hello. The TS side's zod
schemas are the cross-language source of truth; this module is the typed
Python mirror.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
DAEMON_NAME = "bloom-aced"
DAEMON_VERSION = "0.1.0"

JsonObject = dict[str, Any]


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
            value = request.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError(f"generate needs a non-empty string {key!r}")
            return value

        def required_number(key: str, minimum: float, maximum: float) -> float:
            value = request.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"generate needs a number {key!r}")
            if not minimum <= float(value) <= maximum:
                raise ValueError(f"{key!r} must be in [{minimum}, {maximum}]")
            return float(value)

        lyrics = request.get("lyrics")
        if lyrics is not None and not isinstance(lyrics, str):
            raise ValueError("'lyrics' must be a string when present")
        bpm: int | None = None
        if request.get("bpm") is not None:
            bpm = int(required_number("bpm", 30, 300))
        return GenerateJob(
            prompt=required_str("prompt"),
            duration_seconds=required_number("duration_seconds", 10, 600),
            seed=int(required_number("seed", 0, 2**31 - 1)),
            variants=int(required_number("variants", 1, 8)),
            output_dir=required_str("output_dir"),
            lyrics=lyrics,
            bpm=bpm,
        )


def ok_response(request_id: object, extra: JsonObject | None = None) -> JsonObject:
    response: JsonObject = {"ok": True}
    if request_id is not None:
        response["id"] = request_id
    if extra:
        response.update(extra)
    return response


def error_response(request_id: object, message: str) -> JsonObject:
    response: JsonObject = {"ok": False, "error": message}
    if request_id is not None:
        response["id"] = request_id
    return response
