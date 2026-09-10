import type { AgentCall } from "../../src/contexts/agent/ports/AgentInvoker.ts";

/** Unit tests select a provider but must not start it. */
export const agentSelection = {
  model: "scripted",
  system: "Unit test system prompt",
  provider: () => {
    throw new Error("A unit test must not start an agent provider");
  },
} satisfies Pick<AgentCall, "model" | "system" | "provider">;
