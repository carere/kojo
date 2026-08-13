import { describe, expect, it } from "@effect/vitest";
import {
  agentInstalls,
  agentNames,
  agentSpellings,
  canonicalAgent,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";

/**
 * The near-miss `--agent` accepts, and why it is one spelling rather than one more agent.
 *
 * `kojo init --agent claude` is what a person types after being told every answer may be given on
 * the command line. Rejecting it stops the prompt-free path at its first step, for a difference of
 * five characters.
 */
describe("how an agent may be spelled", () => {
  it("accepts `claude` and means `claude-code` by it", () => {
    expect(agentSpellings).toContain("claude");
    expect(canonicalAgent("claude")).toBe("claude-code");
  });

  it("leaves every canonical name meaning itself", () => {
    for (const name of agentNames) expect(canonicalAgent(name)).toBe(name);
  });

  it("adds no agent: every spelling lands on one the image knows how to install", () => {
    for (const spelling of agentSpellings) {
      expect(agentInstalls[canonicalAgent(spelling)]).toBeDefined();
    }
    expect(Object.keys(agentInstalls)).toHaveLength(agentNames.length);
  });
});
