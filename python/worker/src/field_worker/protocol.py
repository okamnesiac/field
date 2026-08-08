"""The wire shapes every generation worker shares.

Same family as field-audiod's (playback.md §3.3): request/response with
client-chosen ids, broadcast events, a versioned hello. The TS side's zod
schemas are the cross-language source of truth; this is the typed Python
mirror of the parts that do not vary by worker.

What *does* vary is the job: ACE takes a prompt and a duration, voice
takes a line of text. That is the backend's business (see `server.py`),
and it is the only thing either worker has to write.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class GenerationOutput:
    """What a finished job hands back, for any backend.

    `seeds` is aligned with `paths` — variant i used seeds[i] — because
    the recipe pairs them and a shifted pairing is a recipe that lies
    about what produced a file.
    """

    paths: list[Path]
    seeds: list[int]
    model: str


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


def required_str(request: JsonObject, key: str, op: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{op} needs a non-empty string {key!r}")
    return value


def required_number(request: JsonObject, key: str, op: str, minimum: float, maximum: float) -> float:
    value = request.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{op} needs a number {key!r}")
    if not minimum <= float(value) <= maximum:
        raise ValueError(f"{key!r} must be in [{minimum}, {maximum}]")
    return float(value)


def required_int(request: JsonObject, key: str, op: str, minimum: int, maximum: int) -> int:
    """A whole number, refused rather than truncated when it is not one.

    `int(float(...))` silently accepted `variants: 2.7` as 2 and
    `seed: 1.5` as 1 (#60 review) — a recipe would then record a seed the
    caller never asked for, which is the provenance lying about its own
    inputs in miniature.
    """
    value = request.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{op} needs a number {key!r}")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{key!r} must be a whole number, not {value}")
    whole = int(value)
    if not minimum <= whole <= maximum:
        raise ValueError(f"{key!r} must be in [{minimum}, {maximum}]")
    return whole


def reject_unknown(request: JsonObject, job: type, op: str) -> None:
    """Refuse a request carrying fields this job spec does not know.

    Fail closed, the rule render-pipeline decision 6 already applies to
    plans: reject what is not understood rather than proceeding on the
    part that is. A worker that quietly drops an unrecognised field is
    the worst kind of compatible — it succeeds, and the recipe written
    afterwards records an input the model never received.

    Not hypothetical. `--exaggeration 0.3` reached a daemon started
    before #65 knew the field; the daemon had every reason to think the
    job well-formed, and only a killed process stopped a take being
    committed at default pacing under a recipe claiming 0.3. A long-lived
    daemon is the whole point of the lifecycle, so "it was already
    running" is the normal case rather than an edge one.

    The allowed set is the job dataclass's own fields, which are the wire
    keys — deriving it means a field added to the spec cannot be
    forgotten here, and this check never becomes the reason a valid
    request is refused.
    """
    known = {f.name for f in fields(job)} | {"id", "op"}
    extra = sorted(set(request) - known)
    if extra:
        raise ValueError(
            f"{op}: unrecognised field(s) {', '.join(repr(e) for e in extra)} — "
            f"this worker does not understand them, and running anyway would "
            f"produce output that does not match what was asked for"
        )


def optional_number(
    request: JsonObject, key: str, minimum: float, maximum: float
) -> float | None:
    """Absent, or a number inside the range. Never silently clamped.

    A clamped value would be recorded in the recipe as the number the
    caller gave while the audio came from a different one — the same
    provenance-that-lies failure `required_int` refuses truncation for.
    """
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{key!r} must be a number when present")
    if not minimum <= float(value) <= maximum:
        raise ValueError(f"{key!r} must be in [{minimum}, {maximum}]")
    return float(value)


def optional_str(request: JsonObject, key: str) -> str | None:
    """Absent or a non-empty string. Empty is neither, and saying so is
    the difference between "no reference recording" and "a reference
    recording at the empty path" (#60 review)."""
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key!r} must be a string when present")
    if not value:
        raise ValueError(f"{key!r} must be a non-empty string when present")
    return value
