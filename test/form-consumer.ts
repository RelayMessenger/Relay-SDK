import Relay, {
  formPart, formReply, partsWithForm,
  type FormAnswers, type FormField, type FormPart, type FormPartResponse,
  type FormResponsePart, type Message, type MessageContent, type SentMessage,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";

const fields: FormField[] = [
  { id: "name", type: "text", label: "Name", placeholder: "Required", required: true, max_length: 500 },
  { id: "notes", type: "text", label: "Notes", multiline: true, max_length: 1000 },
  { id: "single", type: "select", label: "One", options: [{ value: "a", label: "A" }] },
  { id: "multi", type: "select", label: "Many", multiple: true, options: [{ value: "a", label: "A" }] },
  { id: "picker", type: "picker", label: "Pick", options: [{ value: "a", label: "A" }] },
  { id: "date", type: "date", label: "Date" },
];
const form: FormPart = {
  type: "form", title: "Details", pages: [{ id: "details", title: "Details", fields }],
  show_summary: true, splash: { button_title: "Start" },
  received_message: { title: "Details" }, reply_message: { title: "Form sent" },
};
const answers: FormAnswers = { name: "Ada", multi: ["a"], date: "2028-02-29" };
const response: FormResponsePart = { type: "form_response", answers };
const read: FormPartResponse = { ...form, has_responded: true, answers, reactions: null };
const content: MessageContent = {
  parts: [{ type: "text", value: "Form sent" }, response],
  reply_to: { message_id: "source", part_index: 0 },
};
const relay = new Relay({ apiKey: "type-test" });
void relay.chats.messages.send("chat", { message: { parts: partsWithForm(undefined, form) } });
void relay.chats.messages.send("chat", { message: content });
void formPart(form);
void formReply([read, response], content.reply_to);
declare const sent: SentMessage;
declare const message: Message;
declare const event: RelayWebhookEvent;
void sent.parts.find((part) => part.type === "form")?.has_responded;
void message.parts?.find((part) => part.type === "form_response")?.answers;
if (event.event_type === "message.received") {
  const reply = formReply(event.data.parts, event.data.reply_to);
  const typed: FormAnswers | undefined = reply?.answers;
  void typed;
}

// @ts-expect-error Opt-in is a one-option multi-select, not a boolean answer.
const boolAnswer: FormAnswers = { optin: true };
// @ts-expect-error Viewer state belongs only to read types.
const badRequest: FormPart = { ...form, has_responded: false };
// @ts-expect-error Picker fields cannot be multi-select.
const badField: FormField = { id: "p", type: "picker", label: "Pick", options: [], multiple: true };
// @ts-expect-error The answered title is fixed by the contract.
const badTitle: FormPart = { ...form, reply_message: { title: "Completed" } };
void [boolAnswer, badRequest, badField, badTitle];
