"""Tasks between agents: A2A 1.0 Tasks, and the events that carry them.

A task one Relay agent sends another is an A2A 1.0 Task (a2a.proto), in its
JSON form: camelCase fields, enum values by their proto names. These types
copy ``A2aTask``, ``A2aMessage``, ``A2aArtifact`` and ``A2aPart`` of Relay's
API contract field for field (Relay Server ``server/src/agent-tasks.ts``).

Four events reach an agent on its webhooks or the Agent WebSocket
(``webhook-events.ts``): the agent working on a task receives ``task.created``,
``task.message`` and ``task.canceled``; the agent that sent it receives
``task.updated``. Only the standard library is used.
"""

from __future__ import annotations

from typing import Any, Dict, Final, List, Literal, TypedDict, Union

#: a2a.proto ``TaskState``, less ``TASK_STATE_UNSPECIFIED``.
A2aTaskState = Literal[
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_AUTH_REQUIRED",
]
#: The states the agent working on a task may set with ``relay.tasks.update_status``,
#: with or without the ``TASK_STATE_`` prefix. Only creation sets SUBMITTED,
#: and only the agent that sent the task cancels it.
A2aCalleeTaskState = Literal[
    "TASK_STATE_WORKING",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
    "WORKING",
    "INPUT_REQUIRED",
    "AUTH_REQUIRED",
    "COMPLETED",
    "FAILED",
    "REJECTED",
]
#: a2a.proto: "This is a terminal state." Nothing changes a Task after one.
TERMINAL_TASK_STATES: Final = frozenset(
    {"TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"}
)


class A2aPart(TypedDict, total=False):
    """a2a.proto ``Part``: exactly one of ``text``, ``raw`` (base64), ``url`` or ``data``."""

    text: str
    raw: str
    url: str
    data: Any
    metadata: Dict[str, Any]
    filename: str
    mediaType: str


class _A2aMessageRequired(TypedDict):
    messageId: str
    #: ``ROLE_USER`` from the agent that sent the task or message, ``ROLE_AGENT`` from the agent that answers.
    role: Literal["ROLE_USER", "ROLE_AGENT"]
    parts: List[A2aPart]


class A2aMessage(_A2aMessageRequired, total=False):
    """a2a.proto ``Message``."""

    contextId: str
    taskId: str
    metadata: Dict[str, Any]
    extensions: List[str]
    referenceTaskIds: List[str]


class _A2aArtifactRequired(TypedDict):
    artifactId: str
    parts: List[A2aPart]


class A2aArtifact(_A2aArtifactRequired, total=False):
    """a2a.proto ``Artifact``: an id unique within the Task, and at least one part."""

    name: str
    description: str
    metadata: Dict[str, Any]
    extensions: List[str]


class _A2aTaskStatusRequired(TypedDict):
    state: A2aTaskState
    #: ISO 8601.
    timestamp: str


class A2aTaskStatus(_A2aTaskStatusRequired, total=False):
    message: A2aMessage


class _A2aTaskRequired(TypedDict):
    id: str
    contextId: str
    status: A2aTaskStatus
    #: ``metadata["relay"]["requester"]`` is the verified agent that sent the
    #: task: its Card, with its ``owner``.
    metadata: Dict[str, Any]


class A2aTask(_A2aTaskRequired, total=False):
    """a2a.proto ``Task``."""

    artifacts: List[A2aArtifact]
    history: List[A2aMessage]


# The events -------------------------------------------------------------------


class TaskCreatedEvent(TypedDict):
    """``task.created``: another agent sent this agent a task, in TASK_STATE_SUBMITTED."""

    task: A2aTask


class TaskMessageEvent(TypedDict):
    """``task.message``: the agent that sent the task sent more, usually the
    answer this agent asked for with TASK_STATE_INPUT_REQUIRED."""

    task_id: str
    message: A2aMessage


class TaskCanceledEvent(TypedDict):
    """``task.canceled``: the agent that sent the task canceled it."""

    task_id: str


class TaskUpdatedEvent(TypedDict):
    """``task.updated``: the agent working on a task this agent sent changed its
    state or added an Artifact. It carries the whole Task."""

    task: A2aTask


TaskEventType = Literal["task.created", "task.message", "task.canceled", "task.updated"]
TASK_EVENT_TYPES: Final = ("task.created", "task.message", "task.canceled", "task.updated")


class _WebhookEnvelope(TypedDict):
    """``WebhookEnvelopeBase``: the same envelope on a webhook and on the Agent WebSocket."""

    api_version: Literal["v1"]
    webhook_version: str
    event_id: str
    created_at: str
    trace_id: str
    agent_id: str


class TaskCreatedWebhook(_WebhookEnvelope):
    event_type: Literal["task.created"]
    data: TaskCreatedEvent


class TaskMessageWebhook(_WebhookEnvelope):
    event_type: Literal["task.message"]
    data: TaskMessageEvent


class TaskCanceledWebhook(_WebhookEnvelope):
    event_type: Literal["task.canceled"]
    data: TaskCanceledEvent


class TaskUpdatedWebhook(_WebhookEnvelope):
    event_type: Literal["task.updated"]
    data: TaskUpdatedEvent


TaskWebhook = Union[TaskCreatedWebhook, TaskMessageWebhook, TaskCanceledWebhook, TaskUpdatedWebhook]


# REST responses ---------------------------------------------------------------


class TaskResponse(TypedDict):
    """The Task after ``relay.tasks.update_status`` or ``relay.tasks.add_artifact``."""

    task: A2aTask


class TaskListResponse(TypedDict):
    """One page of ``relay.tasks.list``, most recently updated first."""

    tasks: List[A2aTask]
    #: Empty on the last page.
    next_page_token: str


__all__ = [
    "A2aArtifact",
    "A2aCalleeTaskState",
    "A2aMessage",
    "A2aPart",
    "A2aTask",
    "A2aTaskState",
    "A2aTaskStatus",
    "TASK_EVENT_TYPES",
    "TERMINAL_TASK_STATES",
    "TaskCanceledEvent",
    "TaskCanceledWebhook",
    "TaskCreatedEvent",
    "TaskCreatedWebhook",
    "TaskEventType",
    "TaskListResponse",
    "TaskMessageEvent",
    "TaskMessageWebhook",
    "TaskResponse",
    "TaskUpdatedEvent",
    "TaskUpdatedWebhook",
    "TaskWebhook",
]
