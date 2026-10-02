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


class _TextField(_Field):
    type: Literal["text"]


class FormTextField(_TextField, total=False):
    multiline: bool
    max_length: int
    #: The keyboard iOS shows; ``email`` and ``phone`` (E.164) answers are checked.
    keyboard: Literal["default", "email", "phone", "number", "url"]


class _SelectField(_Field):
    type: Literal["select"]
    options: List[FormOption]


class FormSelectField(_SelectField, total=False):
    multiple: bool


class FormPickerField(_Field):
    type: Literal["picker"]
    options: List[FormOption]


class _DateField(_Field):
    type: Literal["date"]


class FormDateField(_DateField, total=False):
    #: YYYY-MM-DD; 1900-01-01 when omitted.
    min_date: str
    #: YYYY-MM-DD, not before min_date; 2100-12-31 when omitted.
    max_date: str


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
    #: The form's received_message.title, else its title; the words a client
    #: that does not draw the form shows.
    value: str
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
