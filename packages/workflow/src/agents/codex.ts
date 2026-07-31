import { defineBuiltInAgentProvider } from "../index";

/** Immutable Codex Agent Provider definition. Credentials resolve in the Host. */
export const codex = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "codex", ...options });
