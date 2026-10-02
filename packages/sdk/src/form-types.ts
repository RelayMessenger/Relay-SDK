/** Form wire types from contracts/relay-v1-openapi.yaml. */
export interface FormOption {
  /** Case-sensitive ASCII token, 1–100 characters, unique within the field. */
  value: string;
  /** Visible label, 1–30 Unicode scalar characters, no surrounding whitespace. */
  label: string;
}

interface FormFieldBase {
  /** Stable ASCII token, 1–100 characters, unique across every page. */
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

/** The keyboard iOS shows. `email` and `phone` also check the answer (an
 * email address; an E.164 number such as +13135550123). */
export type FormTextKeyboard = "default" | "email" | "phone" | "number" | "url";

export interface FormTextField extends FormFieldBase {
  type: "text";
  /** False by default. Default max_length is 30 single-line, 300 multiline. */
  multiline?: boolean;
  /** Positive maximum answer length in Unicode scalars; not a label limit. */
  max_length?: number;
  /** "default" when omitted. */
  keyboard?: FormTextKeyboard;
}

export interface FormSelectField extends FormFieldBase {
  type: "select";
  /** False by default. Multiple selections return an array in source order. */
  multiple?: boolean;
  /** 1–20 options. */
  options: FormOption[];
}

export interface FormPickerField extends FormFieldBase {
  type: "picker";
  /** 1–200 options. */
  options: FormOption[];
}

export interface FormDateField extends FormFieldBase {
  /** A valid Gregorian YYYY-MM-DD string, without a time zone. */
  type: "date";
  /** Earliest choosable day, YYYY-MM-DD; 1900-01-01 when omitted. */
  min_date?: string;
  /** Latest choosable day, YYYY-MM-DD, not before min_date; 2100-12-31 when omitted. */
  max_date?: string;
}

export type FormField = FormTextField | FormSelectField | FormPickerField | FormDateField;

export interface FormPage {
  /** Stable unique ASCII token, 1–19 characters. */
  id: string;
  /** 1–80 Unicode scalar characters. */
  title: string;
  /** 1–50 fields, displayed in array order. */
  fields: FormField[];
}

export interface FormSplash {
  title?: string;
  text?: string;
  button_title: string;
}

export interface FormReceivedMessage {
  title: string;
  subtitle?: string;
}

export interface FormReplyMessage {
  title: "Form sent";
  subtitle?: string;
}

/** Single-value fields use strings; multi-select (including opt-in) uses arrays. */
export type FormAnswers = Record<string, string | string[]>;

/** Agent-only; one form per Message, separate from buttons and selections. */
export interface FormPart {
  type: "form";
  title: string;
  pages: FormPage[];
  show_summary?: boolean;
  splash?: FormSplash;
  received_message?: FormReceivedMessage;
  reply_message?: FormReplyMessage;
}

export interface FormPartResponse extends FormPart {
  /** The form's received_message.title, else its title; the words a client that does not draw the form shows in its place. */
  readonly value: string;
  /** Viewer-specific durable state. False for an agent viewer. */
  readonly has_responded: boolean;
  /** This viewer's answers, or null. Agents read answers on form_response instead. */
  readonly answers: FormAnswers | null;
  reactions: null;
}

/** User-only metadata after plain text "Form sent", with explicit reply_to.part_index. */
export interface FormResponsePart {
  type: "form_response";
  answers: FormAnswers;
}

/** Metadata only; contributes no additional visible fallback text. */
export interface FormResponsePartResponse extends FormResponsePart {}
