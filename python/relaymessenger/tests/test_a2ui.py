"""A2UI cards: the builders against A2UI's own v0.9.1 schemas, the send against
a local HTTP server, and taps read from Relay Server's message.received fixture.

tests/fixtures/a2ui/v0_9_1 holds A2UI's schemas, byte for byte from
google/A2UI at fcec476 (specification/v0_9_1), the copies Relay Server
validates against. tests/fixtures/webhooks/2026-08-30/message.received.json is
Relay Server's fixture of the same name (server/test/fixtures/webhooks).
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from relaymessenger import Relay, RelayAPIError, a2ui
from relaymessenger.a2ui import (
    A2UI_MEDIA_TYPE,
    A2UI_BASIC_CATALOG_ID,
    RELAY_A2UI_CATALOG_ID,
    a2ui_messages,
    a2ui_part,
    surface_messages,
    client_capabilities,
    create_surface,
    delete_a2ui_surface,
    delete_surface,
    read_a2ui_action,
    read_a2ui_actions,
    send_a2ui,
    send_a2ui_surface,
    update_a2ui_surface,
    update_components,
    update_data_model,
)

FIXTURES = Path(__file__).parent / "fixtures"
SCHEMAS = FIXTURES / "a2ui" / "v0_9_1"
RECEIVED = FIXTURES / "webhooks" / "2026-08-30" / "message.received.json"


def _schema(name: str) -> Dict[str, Any]:
    loaded: Dict[str, Any] = json.loads((SCHEMAS / name).read_text())
    return loaded


SERVER_TO_CLIENT = _schema("server_to_client.json")
# The event schema carries no $id; Relay Server gives it one beside server_to_client.json.
CLIENT_TO_SERVER = {**_schema("client_to_server.json"), "$id": "https://a2ui.org/specification/v0_9/client_to_server.json"}
# The envelope's `catalog.json` is the catalog in use: the basic catalog here,
# so components are checked too, not only the envelope.
_REGISTRY = Registry().with_resources(
    [
        ("https://a2ui.org/specification/v0_9/catalog.json", Resource.from_contents(_schema("catalog.json"))),
        ("https://a2ui.org/specification/v0_9/common_types.json", Resource.from_contents(_schema("common_types.json"))),
        (SERVER_TO_CLIENT["$id"], Resource.from_contents(SERVER_TO_CLIENT)),
    ]
)
SERVER_VALIDATOR = Draft202012Validator(SERVER_TO_CLIENT, registry=_REGISTRY)
CLIENT_VALIDATOR = Draft202012Validator(CLIENT_TO_SERVER, registry=_REGISTRY)

#: Relay Server's bet card (server/test/a2ui.test.ts `betComponents`).
BET_COMPONENTS: List[Dict[str, Any]] = [
    {"id": "root", "component": "Card", "child": "body"},
    {"id": "body", "component": "Column", "children": ["title", "status", "bet"]},
    {"id": "title", "component": "Text", "text": "Lakers win tonight?", "variant": "h3"},
    {"id": "status", "component": "Text", "text": {"path": "/status"}},
    {"id": "bet_icon", "component": "Icon", "name": "check"},
    {
        "id": "bet",
        "component": "Button",
        "child": "bet_icon",
        "variant": "primary",
        "action": {"event": {"name": "place_bet", "context": {"side": "yes", "stake": 50}}},
    },
]


def assert_valid_server_messages(messages: List[Any]) -> None:
    for message in messages:
        errors = [e.message for e in SERVER_VALIDATOR.iter_errors(message)]
        assert not errors, (message, errors)


def test_the_schemas_reject_what_they_should() -> None:
    # The validator is live: a message missing its version, and a Button with no action, fail.
    assert list(SERVER_VALIDATOR.iter_errors({"deleteSurface": {"surfaceId": "x"}}))
    no_action = {k: v for k, v in BET_COMPONENTS[5].items() if k != "action"}
    assert list(SERVER_VALIDATOR.iter_errors(update_components("x", [no_action])))


def test_card_is_relay_servers_bet_card_and_valid_a2ui() -> None:
    messages = surface_messages("bet-lakers", BET_COMPONENTS, data_model={"status": "Open"}, catalog_id=A2UI_BASIC_CATALOG_ID)
    # server/test/a2ui.test.ts betCard("bet-lakers"): create, components, model.
    assert messages == [
        {"version": "v0.9.1", "createSurface": {"surfaceId": "bet-lakers", "catalogId": A2UI_BASIC_CATALOG_ID}},
        {"version": "v0.9.1", "updateComponents": {"surfaceId": "bet-lakers", "components": BET_COMPONENTS}},
        {"version": "v0.9.1", "updateDataModel": {"surfaceId": "bet-lakers", "value": {"status": "Open"}}},
    ]
    assert_valid_server_messages(list(messages))


def test_builders_cover_every_server_to_client_message() -> None:
    messages = [
        create_surface("s", theme={"primaryColor": "#FF0000"}, send_data_model=True),
        update_components("s", [{"id": "root", "component": "Text", "text": "Done"}]),
        update_data_model("s", "Placed", path="/status"),
        update_data_model("s", path="/status"),
        delete_surface("s"),
    ]
    assert messages[0] == {
        "version": "v0.9.1",
        "createSurface": {
            "surfaceId": "s",
            "catalogId": RELAY_A2UI_CATALOG_ID,
            "theme": {"primaryColor": "#FF0000"},
            "sendDataModel": True,
        },
    }
    # No value removes the key at path: the key is absent, not null.
    assert messages[3] == {"version": "v0.9.1", "updateDataModel": {"surfaceId": "s", "path": "/status"}}
    assert update_data_model("s", None, path="/x")["updateDataModel"] == {"surfaceId": "s", "path": "/x", "value": None}
    assert_valid_server_messages(messages)
    with pytest.raises(ValueError):
        update_components("s", [])


def test_a2ui_part_is_the_contracts_data_part() -> None:
    part = a2ui_part([delete_surface("s")])
    assert part == {
        "type": "data",
        "media_type": "application/a2ui+json",
        "data": [{"version": "v0.9.1", "deleteSurface": {"surfaceId": "s"}}],
    }
    with pytest.raises(ValueError):
        a2ui_part([])


def test_the_fixture_tap_is_valid_a2ui_and_reads_back() -> None:
    raw = RECEIVED.read_bytes()
    event = json.loads(raw)
    action = event["data"]["parts"][1]["data"][0]
    assert not list(CLIENT_VALIDATOR.iter_errors(action))

    taps = read_a2ui_actions(event)
    assert len(taps) == 1
    tap = taps[0]
    assert (tap.name, tap.surface_id, tap.source_component_id) == ("place_bet", "bet-lakers", "bet")
    assert tap.timestamp == "2026-09-24T20:00:00Z"
    assert tap.context == {"side": "yes", "stake": 50}
    assert tap.action == action["action"]
    assert tap.chat_id == "00000000-0000-7000-8000-000000000023"
    assert tap.message_id == "00000000-0000-7000-8000-000000000022"
    assert tap.sender_handle == "advait"
    assert tap.data_model is None
    # The raw webhook body and its text read the same.
    assert read_a2ui_action(raw) == tap
    assert read_a2ui_action(raw.decode()) == tap
    assert a2ui_messages(event) == [action]


def test_a_tap_carries_the_surfaces_data_model() -> None:
    event = json.loads(RECEIVED.read_text())
    event["data"]["metadata"]["a2uiClientDataModel"] = {
        "version": "v0.9.1",
        "surfaces": {"bet-lakers": {"stake": 75}},
    }
    tap = read_a2ui_action(event)
    assert tap is not None and tap.data_model == {"stake": 75}


def test_only_message_received_carries_taps() -> None:
    event = json.loads(RECEIVED.read_text())
    assert read_a2ui_actions({**event, "event_type": "message.sent"}) == []
    assert read_a2ui_actions({**event, "event_type": "reaction.added"}) == []
    event["data"]["parts"] = [event["data"]["parts"][0]]
    assert read_a2ui_action(event) is None
    # A data part of another media type is not A2UI.
    event["data"]["parts"] = [{"type": "data", "media_type": "application/json", "data": [{"action": {}}]}]
    assert a2ui_messages(event) == []


def test_client_capabilities_lists_the_apps_catalogs() -> None:
    assert client_capabilities(json.loads(RECEIVED.read_text())) == [RELAY_A2UI_CATALOG_ID, A2UI_BASIC_CATALOG_ID]
    assert client_capabilities({"event_type": "message.received", "data": {"parts": []}}) == []


# Send -------------------------------------------------------------------------


Seen = List[Tuple[str, str, Dict[str, str], Any]]


class _Server:
    def __init__(self) -> None:
        self.seen: Seen = []
        self.replies: List[Tuple[int, Any]] = []

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                server.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                status, reply = server.replies.pop(0) if server.replies else (202, None)
                if reply is None:
                    reply = {"chat_id": "chat", "message": {"id": "m1", "parts": body["message"]["parts"]}}
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server() -> Iterator[_Server]:
    s = _Server()
    s.start()
    yield s
    s.stop()


async def test_send_a2ui_surface_posts_the_data_part(server: _Server) -> None:
    relay = Relay("tok", base_url=server.base_url + "/")
    response = await send_a2ui_surface(
        relay,
        "chat/1",
        "bet-lakers",
        BET_COMPONENTS,
        data_model={"status": "Open"},
        text="Your bet",
        reply_to={"message_id": "m0", "part_index": 0},
        silent=True,
    )
    method, path, headers, body = server.seen[0]
    assert (method, path) == ("POST", "/v1/chats/chat%2F1/messages")
    assert headers["authorization"] == "Bearer tok"
    assert headers["user-agent"].startswith("relaymessenger-python/")
    assert headers["content-type"] == "application/json"
    assert "idempotency-key" not in headers
    parts = body["message"]["parts"]
    assert parts[0] == {"type": "text", "value": "Your bet"}
    assert parts[1] == a2ui_part(surface_messages("bet-lakers", BET_COMPONENTS, data_model={"status": "Open"}))
    assert parts[1]["media_type"] == A2UI_MEDIA_TYPE
    assert body["message"]["reply_to"] == {"message_id": "m0", "part_index": 0}
    assert body["message"]["silent"] is True
    assert response["message"]["id"] == "m1"


async def test_update_and_delete_change_the_same_surface(server: _Server) -> None:
    relay = Relay("tok", base_url=server.base_url)
    done = [{"id": "body", "component": "Column", "children": ["title", "status"]}]
    await update_a2ui_surface(relay, "chat", "bet-lakers", components=done, data_model="Done", path="/status")
    await update_a2ui_surface(relay, "chat", "bet-lakers", path="/stake")
    await delete_a2ui_surface(relay, "chat", "bet-lakers", idempotency_key="del-1")
    update, remove, delete = (seen[3]["message"] for seen in server.seen)
    assert update == {
        "parts": [
            a2ui_part([update_components("bet-lakers", done), update_data_model("bet-lakers", "Done", path="/status")])
        ]
    }
    assert remove["parts"][0]["data"] == [{"version": "v0.9.1", "updateDataModel": {"surfaceId": "bet-lakers", "path": "/stake"}}]
    assert delete == {"parts": [a2ui_part([delete_surface("bet-lakers")])], "idempotency_key": "del-1"}
    assert server.seen[2][2]["idempotency-key"] == "del-1"
    with pytest.raises(ValueError):
        await update_a2ui_surface(relay, "chat", "bet-lakers")


async def test_a_send_that_applied_nothing_raises_with_a2ui_errors(server: _Server) -> None:
    refused = {
        "error": {"status": 409, "code": 1005, "message": "Surface exists.", "doc_url": "https://docs.relayapp.im/x"},
        "success": False,
        "trace_id": "t1",
        # Relay Server's A2uiFailure (contracts/developer/openapi.yaml at f1200152).
        "a2ui_errors": [
            {
                "part_index": 0,
                "data_index": 0,
                "a2ui_message": {
                    "version": "v0.9.1",
                    "error": {
                        "code": "VALIDATION_FAILED",
                        "surfaceId": "twice",
                        "path": "/surfaceId",
                        "message": "Surface exists.",
                    },
                },
            }
        ],
    }
    server.replies.append((409, refused))
    with pytest.raises(RelayAPIError) as caught:
        await send_a2ui_surface(Relay("tok", base_url=server.base_url), "chat", "twice", BET_COMPONENTS)
    error = caught.value
    assert (error.status, error.code, error.trace_id, str(error)) == (409, 1005, "t1", "Surface exists.")
    assert error.a2ui_errors == refused["a2ui_errors"]
    assert len(server.seen) == 1, "a refused send is not retried"
    # Relay's A2UI errors are A2UI error messages.
    failure = error.a2ui_errors[0]
    assert (failure["part_index"], failure["data_index"]) == (0, 0)
    assert failure["a2ui_message"]["error"]["path"] == "/surfaceId"
    assert not list(CLIENT_VALIDATOR.iter_errors(failure["a2ui_message"]))


async def test_a_partial_send_returns_a2ui_errors(server: _Server) -> None:
    applied = {"chat_id": "chat", "message": {"id": "m1"}, "a2ui_errors": [
        {"part_index": 0, "data_index": 1, "a2ui_message": {"version": "v0.9.1", "error": {
            "code": "VALIDATION_FAILED", "surfaceId": "t", "path": "", "message": "No such surface."}}},
        # A fault in metadata.a2uiClientDataModel has no place in parts.
        {"part_index": None, "data_index": None, "a2ui_message": {"version": "v0.9.1", "error": {
            "code": "VALIDATION_FAILED", "surfaceId": "t", "path": "/surfaces", "message": "Not an object."}}},
    ]}
    server.replies.append((202, applied))
    response = await send_a2ui(Relay("tok", base_url=server.base_url), "chat", [delete_surface("s"), delete_surface("t")])
    errors = response["a2ui_errors"]
    assert [(e["part_index"], e["data_index"]) for e in errors] == [(0, 1), (None, None)]
    assert errors[0]["a2ui_message"]["error"]["surfaceId"] == "t"
    for e in errors:
        assert not list(CLIENT_VALIDATOR.iter_errors(e["a2ui_message"]))


async def test_only_a_keyed_send_is_retried(server: _Server) -> None:
    relay = Relay("tok", base_url=server.base_url, retry_base_delay=0)
    busy = {"error": {"status": 503, "code": 5000, "message": "Busy."}, "success": False}
    server.replies.extend([(503, busy), (503, busy)])
    with pytest.raises(RelayAPIError) as caught:
        await send_a2ui(relay, "chat", [delete_surface("s")])
    assert caught.value.status == 503 and len(server.seen) == 1
    response = await send_a2ui(relay, "chat", [delete_surface("s")], idempotency_key="k")
    assert len(server.seen) == 3 and response["chat_id"] == "chat"


async def test_a_network_failure_is_a_relay_api_error() -> None:
    relay = Relay("tok", base_url="http://127.0.0.1:9", max_retries=0)
    with pytest.raises(RelayAPIError) as caught:
        await send_a2ui(relay, "chat", [delete_surface("s")])
    assert caught.value.status is None and caught.value.retryable


def test_the_package_exports_the_a2ui_module() -> None:
    import relaymessenger

    assert relaymessenger.a2ui is a2ui
    assert set(a2ui.__all__) <= set(dir(a2ui))
    with pytest.raises(ValueError):
        Relay("")


def test_the_readme_card_is_valid_a2ui() -> None:
    import ast
    import re

    readme = (Path(__file__).parent.parent / "README.md").read_text()
    found = re.search(r"^BET = (\[.*?^\])$", readme, re.S | re.M)
    assert found, "README defines BET"
    components = ast.literal_eval(found.group(1))
    assert_valid_server_messages(list(surface_messages("bet-lakers", components, data_model={"status": "Open"})))
    done = [{"id": "body", "component": "Column", "children": ["title", "status"]}]
    assert_valid_server_messages([update_components("bet-lakers", done), update_data_model("bet-lakers", "Done", path="/status")])
    # The README's button is the one the fixture tap names.
    button = next(c for c in components if c["component"] == "Button")
    tap = read_a2ui_action(RECEIVED.read_bytes())
    assert tap is not None
    assert (button["id"], button["action"]["event"]["name"], button["action"]["event"]["context"]) == (
        tap.source_component_id,
        tap.name,
        tap.context,
    )
