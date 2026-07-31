import { defineBuiltInAgentProvider } from "../index";

/** Immutable Claude Code Agent Provider definition. Credentials resolve in the Host. */
export const claudeCode = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "claude-code", ...options });
