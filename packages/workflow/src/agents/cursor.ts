import { defineBuiltInAgentProvider } from "../index";

/** Immutable Cursor Agent Provider definition. Credentials resolve in the Host. */
export const cursor = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "cursor", ...options });
