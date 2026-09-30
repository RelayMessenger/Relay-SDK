"""Form wire types from contracts/relay-v1-openapi.yaml."""
from typing import Dict, List, Literal, Optional, TypedDict, Union


class FormOption(TypedDict):
    value: str
    label: str


class _FieldRequired(TypedDict):
    id: str
    label: str


class _Field(_FieldRequired, total=False):
    placeholder: str
    required: bool
    max_length: int


class _TextField(_Field):
    type: Literal["text"]


class FormTextField(_TextField, total=False):
    multiline: bool


class _SelectField(_Field):
    type: Literal["select"]
    options: List[FormOption]


class FormSelectField(_SelectField, total=False):
    multiple: bool


class FormPickerField(_Field):
    type: Literal["picker"]
    options: List[FormOption]


class FormDateField(_Field):
    type: Literal["date"]


FormField = Union[FormTextField, FormSelectField, FormPickerField, FormDateField]
FormAnswers = Dict[str, Union[str, List[str]]]


class FormPage(TypedDict):
    id: str
    title: str
    fields: List[FormField]


class _Splash(TypedDict):
    button_title: str


class FormSplash(_Splash, total=False):
    title: str
    text: str


class _Received(TypedDict):
    title: str


class FormReceivedMessage(_Received, total=False):
    subtitle: str


class _ReplyMessage(TypedDict):
    title: Literal["Form sent"]


class FormReplyMessage(_ReplyMessage, total=False):
    subtitle: str


class _Part(TypedDict):
    type: Literal["form"]
    title: str
    pages: List[FormPage]


class FormPart(_Part, total=False):
    show_summary: bool
    splash: FormSplash
    received_message: FormReceivedMessage
    reply_message: FormReplyMessage


class FormPartResponse(FormPart):
    has_responded: bool
    answers: Optional[FormAnswers]
    reactions: None


class FormResponsePart(TypedDict):
    type: Literal["form_response"]
    answers: FormAnswers


class FormReplyTo(TypedDict):
    message_id: str
    part_index: int


class FormReply(TypedDict):
    answers: FormAnswers
    reply_to: FormReplyTo
