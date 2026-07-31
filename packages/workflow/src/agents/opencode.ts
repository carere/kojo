import { defineBuiltInAgentProvider } from "../index";

/** Immutable OpenCode Agent Provider definition. Credentials resolve in the Host. */
export const opencode = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "opencode", ...options });
