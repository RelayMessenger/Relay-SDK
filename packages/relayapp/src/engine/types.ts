/**
 * Narrow engine-adapter boundary. The receive loop only knows this interface;
 * AcpEngine (claude/codex over stdio) and OpencodeEngine (HTTP: session
 * create / prompt_async / permission reply-by-id) both slot in without the
 * loop knowing which. `SessionRef` is opaque per engine — adapters own their
 * own binding from conversation_id to whatever session identity they need.
 */

export interface SessionRef {
  conversationId: string;
  /** Working directory the engine session should operate in. */
  cwd: string;
}

export interface PermissionAsk {
  requestId: string;
  toolName?: string;
  title?: string;
  /**
   * Security-relevant detail of the operation being approved (raw tool input,
   * affected paths). Rendered on the phone card so the owner sees what they
   * are allowing, not just a tool title.
   */
  inputPreview?: string;
  options: Array<{ optionId: string; label: string; kind?: string }>;
}

export type PermissionDecision =
  | { behavior: "selected"; optionId: string }
  | { behavior: "cancelled" };

export interface TurnCallbacks {
  /** Streaming assistant text; the bridge finalizes quietly, so this is informational. */
  onDelta?(text: string): void;
  /** Tool activity, surfaced as a typing label. */
  onToolEvent?(event: { kind: string; title?: string }): void;
  /** Blocking permission ask — resolve with the user's decision. */
  onPermissionAsk(ask: PermissionAsk): Promise<PermissionDecision>;
}

export interface TurnResult {
  text: string;
  stopReason: string;
}

export interface EngineAdapter {
  readonly engine: string;
  startTurn(ref: SessionRef, promptText: string, callbacks: TurnCallbacks): Promise<TurnResult>;
  abort(ref: SessionRef): Promise<void>;
  dispose(): Promise<void>;
}
