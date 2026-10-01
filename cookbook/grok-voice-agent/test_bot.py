"""The greeting cue reaches Grok while the persona stays the system instruction."""

import warnings

from pipecat.adapters.services.grok_realtime_adapter import GrokRealtimeLLMAdapter
from pipecat.processors.aggregators.llm_context import LLMContext

from bot import GREETING_CUE, PERSONA, build


def test_the_greeting_cue_reaches_grok() -> None:
    context = LLMContext()
    context.add_message(GREETING_CUE)  # type: ignore[arg-type]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        params = GrokRealtimeLLMAdapter().get_llm_invocation_params(context, system_instruction=PERSONA)
    # No deprecated "system" context message (Pipecat 1.9+).
    assert not [w for w in caught if issubclass(w.category, DeprecationWarning) and "system" in str(w.message)]
    assert params["system_instruction"] == PERSONA
    assert "Greet them" in str(params["messages"])


def test_the_pipeline_builds_offline() -> None:
    transport, worker, _ = build("test-token", "00000000-0000-0000-0000-000000000000", "test-key")
    assert worker is not None and transport is not None
