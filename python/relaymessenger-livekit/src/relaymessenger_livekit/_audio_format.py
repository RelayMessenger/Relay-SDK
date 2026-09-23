"""Moved to `relaymessenger_calls._audio_format`; this import path stays and is the same module."""

import sys

from relaymessenger_calls import _audio_format as _moved

sys.modules[__name__] = _moved
