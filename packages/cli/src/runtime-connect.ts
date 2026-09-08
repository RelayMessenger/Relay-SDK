/** Optional, offline: writes the token into the configuration of the runtime you chose.
 * It never installs anything, never starts anything, and never opens a network connection. */
export type RuntimeConnectTarget =
  | { runtime: 'openclaw'; configPath: string; stateDir: string; account: string; profile?: string; brain?: string }
  | { runtime: 'hermes'; profileHome: string; stateDir?: string; profile?: string }
  | { runtime: 'claude-code'; channelDir: string; context: string; claudeConfigDir?: string };

export interface RuntimeConnectInput {
  /** Already signed in and resolved by the caller using the SDK. Never print this input. */
  agent: { token: string; origin: string; handle: string };
  target: RuntimeConnectTarget;
}
export interface RuntimeConnectPlan {
  readonly status: 'ready' | 'required-action' | 'conflict';
  readonly code: string;
  readonly message: string;
  /** No paths, user-controlled labels, or tokens appear in these messages. */
  readonly actions: readonly string[];
}
export interface RuntimeConnectConsent {
  consent: true;
  /** The caller must stop the runtime it chose before writing or undoing, not unrelated sessions. */
  runtimeStopped: true;
}
export interface RuntimeConnectResult {
  readonly status: 'configured' | 'required-action' | 'conflict';
  readonly code: string;
  readonly message: string;
  /** The undo lives in memory only: no backup file ever holds the token. */
  readonly rollback?: (consent: RuntimeConnectConsent) => Promise<RuntimeConnectResult>;
}
export { planRuntimeConnect, applyRuntimeConnect } from './runtime-connect/implementation.js';
