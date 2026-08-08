"""field-voiced: the Chatterbox voice worker.

The lifecycle is `field_worker`'s, shared with field-aced. What is here is
what is actually voice's: its job shape and its pipeline.
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
