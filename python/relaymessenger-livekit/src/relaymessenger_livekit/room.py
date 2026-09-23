"""Moved to `relaymessenger_calls.room`; this import path stays and is the same module."""

import sys

from relaymessenger_calls import room as _moved

sys.modules[__name__] = _moved
