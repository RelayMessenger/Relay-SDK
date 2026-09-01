const RELAY_TOKEN_PATTERN = /\b(?:rly|relay)_[A-Za-z0-9._-]{12,}\b/giu;
const BEARER_PATTERN = /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu;
const ENV_PATTERN = /(RELAY_AGENT_TOKEN\s*=\s*)[^\s"']+/giu;

export interface Redactor {
  text(value: unknown): string;
}

export function createRedactor(agentToken: string): Redactor {
  const exact = agentToken.trim();
  return {
    text(value: unknown): string {
      let output = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
      if (exact) output = output.split(exact).join("[REDACTED]");
      return output
        .replace(RELAY_TOKEN_PATTERN, "[REDACTED]")
        .replace(BEARER_PATTERN, "$1[REDACTED]")
        .replace(ENV_PATTERN, "$1[REDACTED]");
    },
  };
}
