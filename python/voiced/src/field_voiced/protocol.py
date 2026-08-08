"""field-voiced's own half of the wire protocol: what a voice job is.

Everything else — framing, hello, ok/error, the generation result — is
`field_worker.protocol`, shared with field-aced. The TS side's zod schemas
in src/voiced/protocol.ts are the cross-language source of truth; this is
the typed Python mirror.
"""

from __future__ import annotations

from dataclasses import dataclass

from field_worker.protocol import JsonObject, optional_number, optional_str
from field_worker.protocol import required_int as _required_int
from field_worker.protocol import required_str as _required_str

DAEMON_NAME = "field-voiced"
DAEMON_VERSION = "0.1.0"
SOCKET_DEFAULT = ".field/voiced.sock"


@dataclass(frozen=True)
class VoiceJob:
    """One voice generation request.

    No duration: a line's length follows from its text, which is why the
    recipe schema refuses `duration_seconds` on a voice recipe
    (voice-generation.md §1.6).

    `voice_ref` is a *path*, already resolved by the CLI from the recipe's
    asset name — the worker never learns what an asset is, the same
    boundary that keeps musical time out of field-audiod. `None` means the
    model's own voice, which is a first-class case rather than a fallback
    (§6) and is what bloom uses today.
    """

    text: str
    seed: int
    variants: int
    output_dir: str
    voice_ref: str | None = None
    # Chatterbox's expressive knobs. `conviction` is its `cfg_weight`
    # renamed for the recipe (voice-generation.md §8) and translated in
    # adapter.py; the wire keeps our name so the protocol and the file
    # agree. `None` means the model's default, which is not the same as
    # a value we picked — the recipe records only what was asked for.
    exaggeration: float | None = None
    conviction: float | None = None

    @staticmethod
    def from_request(request: JsonObject) -> "VoiceJob":
        return VoiceJob(
            text=_required_str(request, "text", "generate"),
            seed=_required_int(request, "seed", "generate", 0, 2**31 - 1),
            variants=_required_int(request, "variants", "generate", 1, 8),
            output_dir=_required_str(request, "output_dir", "generate"),
            voice_ref=optional_str(request, "voice_ref"),
            # Bounds match the schema's, which are narrower than the
            # model's on purpose: a range can widen later without
            # invalidating a committed recipe, and cannot narrow.
            exaggeration=optional_number(request, "exaggeration", 0.25, 2.0),
            conviction=optional_number(request, "conviction", 0.1, 1.0),
        )
