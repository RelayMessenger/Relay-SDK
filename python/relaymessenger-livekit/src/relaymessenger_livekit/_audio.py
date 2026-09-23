"""Moved to `relaymessenger_calls._audio`; this import path stays and is the same module."""

import sys

from relaymessenger_calls import _audio as _moved

sys.modules[__name__] = _moved
