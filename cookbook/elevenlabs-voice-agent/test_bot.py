"""The greeting cue reaches Grok beside the persona, and the pipeline builds offline."""

import warnings

from pipecat.adapters.services.open_ai_responses_adapter import OpenAIResponsesLLMAdapter
from pipecat.processors.aggregators.llm_context import LLMContext

from bot import GREETING_CUE, PERSONA, build


def test_the_greeting_cue_reaches_grok() -> None:
    context = LLMContext()
    context.add_message(GREETING_CUE)  # type: ignore[arg-type]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        params = OpenAIResponsesLLMAdapter().get_llm_invocation_params(context, system_instruction=PERSONA)
    # No deprecated "system" context message (Pipecat 1.9+).
    assert not [w for w in caught if issubclass(w.category, DeprecationWarning) and "system" in str(w.message)]
    assert params["instructions"] == PERSONA
    assert "Greet them" in str(params["input"])


def test_the_pipeline_builds_offline() -> None:
    transport, worker, _ = build("test-token", "00000000-0000-0000-0000-000000000000", "test-key", "test-key")
    assert worker is not None and transport is not None


async def test_calls_run_side_by_side_once_each_and_a_failed_call_is_logged(monkeypatch) -> None:
    import asyncio

    from loguru import logger

    import bot

    answered: list[str] = []
    second_started = asyncio.Event()
    logged: list[str] = []
    overlapped: list[bool] = []
    sink = logger.add(lambda message: logged.append(str(message)), level="ERROR")

    async def answer(call_id: str) -> None:
        answered.append(call_id)
        if call_id == "c1":
            # The first call is still running when the second one rings.
            await asyncio.wait_for(second_started.wait(), 1)
            overlapped.append(True)
            raise RuntimeError("the call failed")
        second_started.set()

    async def fake_run_websocket(base_url, token, *, on_event, on_full_sync, on_error):  # type: ignore[no-untyped-def]
        created = {"event_id": "e1", "event_type": "call.created", "data": {"call": {"id": "c1"}}}
        await on_event(created, {"sequence": "1"})
        await on_event(created, {"sequence": "1"})  # redelivered
        await on_event({"event_id": "e2", "event_type": "message.received", "data": {}}, {"sequence": "2"})
        await on_event({"event_id": "e3", "event_type": "call.created", "data": {"call": {"id": "c2"}}}, {"sequence": "3"})
        await on_full_sync({"through_sequence": "3", "reason": "checkpoint_outside_retention"})
        await asyncio.sleep(0.2)

    monkeypatch.setattr(bot, "run_websocket", fake_run_websocket)
    try:
        await bot.serve("token", answer)
    finally:
        logger.remove(sink)
    assert answered == ["c1", "c2"]
    assert overlapped == [True]
    assert any("Call c1 failed" in line for line in logged)
