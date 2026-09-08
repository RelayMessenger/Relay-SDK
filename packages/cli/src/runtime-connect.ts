/** Optional, offline runtime handoff. This module never installs, launches, or opens a socket. */
export type RuntimeConnectTarget =
  | { runtime: 'openclaw'; configPath: string; stateDir: string; account: string; profile?: string; brain?: string }
  | { runtime: 'hermes'; profileHome: string; profile?: string }
  | { runtime: 'claude-code'; channelDir: string; context: string; claudeConfigDir?: string };

export interface RuntimeConnectInput {
  /** Already authenticated/resolved by the caller using the SDK. Never print this input. */
  agent: { token: string; origin: string; handle: string };
  target: RuntimeConnectTarget;
}
export interface RuntimeConnectPlan {
  readonly status: 'ready' | 'required-action' | 'conflict';
  readonly code: string;
  readonly message: string;
  /** No paths, user-controlled labels, or credentials are included in diagnostics. */
  readonly actions: readonly string[];
}
export interface RuntimeConnectConsent {
  consent: true;
  /** Caller must stop the selected runtime before apply/rollback, not unrelated sessions. */
  runtimeStopped: true;
}
export interface RuntimeConnectResult {
  readonly status: 'configured' | 'required-action' | 'conflict';
  readonly code: string;
  readonly message: string;
  /** In-memory rollback capability: no secret-bearing backup file. */
  readonly rollback?: (consent: RuntimeConnectConsent) => Promise<RuntimeConnectResult>;
}
export { planRuntimeConnect, applyRuntimeConnect } from './runtime-connect/implementation.js';
