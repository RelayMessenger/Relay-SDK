/** Form wire types from contracts/relay-v1-openapi.yaml. */
export interface FormOption {
  /** Case-sensitive ASCII token, 1–100 characters, unique within the field. */
  value: string;
  /** Trimmed visible label, 1–30 Unicode scalar characters. */
  label: string;
}

interface FormFieldBase {
  /** Stable ASCII token, 1–100 characters, unique across every page. */
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  /** Positive maximum answer length in Unicode scalars; not a label limit. */
  max_length?: number;
}

export interface FormTextField extends FormFieldBase {
  type: "text";
  /** False by default. Default max_length is 30 single-line, 300 multiline. */
  multiline?: boolean;
}

export interface FormSelectField extends FormFieldBase {
  type: "select";
  /** False by default. Multiple selections return an array in source order. */
  multiple?: boolean;
  /** 1–20 options; every value must fit max_length (default 100). */
  options: FormOption[];
}

export interface FormPickerField extends FormFieldBase {
  type: "picker";
  /** 1–200 options; every value must fit max_length (default 100). */
  options: FormOption[];
}

export interface FormDateField extends FormFieldBase {
  /** A valid Gregorian YYYY-MM-DD string, without a time zone. */
  type: "date";
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
