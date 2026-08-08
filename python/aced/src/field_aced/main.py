"""field-aced: the ACE-Step generation worker.

The lifecycle — flock ownership, NDJSON framing, the single-flight
generation gate, idle-exit-but-never-mid-generation, the SIGTERM unlink —
lives in `field_worker` and is shared with field-voiced
(voice-generation.md §1.4). What is left here is what is actually ACE's:
its job shape and its pipeline.
"""

from __future__ import annotations

import sys

from field_worker.server import serve

from .adapter import Pipeline
from .protocol import DAEMON_NAME, DAEMON_VERSION, SOCKET_DEFAULT


def main() -> int:
    return serve(DAEMON_NAME, DAEMON_VERSION, Pipeline(), SOCKET_DEFAULT)


if __name__ == "__main__":
    sys.exit(main())
