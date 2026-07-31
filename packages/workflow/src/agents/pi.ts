import { defineBuiltInAgentProvider } from "../index";

/** Immutable Pi Agent Provider definition. Credentials resolve in the Host. */
export const pi = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "pi", ...options });
