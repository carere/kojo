import { defineBuiltInAgentProvider } from "../index";

/** Immutable GitHub Copilot Agent Provider definition. Credentials resolve in the Host. */
export const githubCopilot = (options: {
  readonly model: string;
  readonly providerKey: string;
  readonly revision: string;
}) => defineBuiltInAgentProvider({ kind: "github-copilot", ...options });
