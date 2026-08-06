"""`python -m bloom_aced` — the BLOOM_ACED_PYTHON spawn path.

The [project.scripts] entry point needs the package installed; this needs
only an interpreter that can import it (PYTHONPATH suffices), which is how
tests and CI run the daemon without the multi-GB model environment.
"""

import sys

from .main import main

sys.exit(main())
