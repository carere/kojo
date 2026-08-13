import type { FactoryChoices } from "../models/FactoryChoices.ts";
import type { StarterAgent } from "./starter.ts";

/** YAML has no escaping worth guessing at, so every scalar this file writes is a JSON string. */
const scalar = (value: string): string => JSON.stringify(value);

/**
 * The roster: who the agents are, and what each of them is for.
 *
 * **This file is read by `YamlRoster`, and every key below is one that adapter decodes.** Nothing
 * decorative is stamped here — an unread key in a config file is the same lie as a placeholder
 * command that exits 0, and this file is where a person would most reasonably believe it.
 *
 * The sandbox provider and the image name are therefore *not* here. They live in
 * `.kojo/workflows/`, because a provider is built per run — `CreateSandboxOptions` carries no
 * `env`, so a run's own environment can only be attached by the code that constructs the provider.
 * A YAML key naming a provider would be a key nothing reads.
 *
 * The prompt files are found by convention, `prompts/<agent name>/{system,user}.md`, so the
 * optional `prompts:` key is left out of what is stamped.
 */
export const config = (choices: FactoryChoices, agents: ReadonlyArray<StarterAgent>): string =>
  [
    "# This file is yours. Kojo wrote it once and will never overwrite it.",
    "#",
    "# The roster. Every agent a workflow calls by name must be here, and every agent here must",
    "# have `prompts/<name>/system.md` and `prompts/<name>/user.md` beside it — both are read when",
    "# the factory loads, so a missing prompt is an error before a run exists to be confused by it.",
    "#",
    "# An agent is not a model. It is a system prompt, a tool allowlist, and a model, and all three",
    "# decide what it does. That is why `system.md` is a file rather than a line in this one.",
    "",
    "agents:",
    ...agents.flatMap((agentDefinition) => [
      `  ${agentDefinition.name}:`,
      "    # One line. It is what a human reads beside this agent's phase in the trace.",
      `    purpose: ${scalar(agentDefinition.purpose)}`,
      `    model: ${scalar(choices.model)}`,
      "    # What this agent may reach for. An empty list means the provider's own default set —",
      "    # it does not mean no tools.",
      ...(agentDefinition.tools.length === 0
        ? ["    tools: []"]
        : ["    tools:", ...agentDefinition.tools.map((tool) => `      - ${scalar(tool)}`)]),
      "",
    ]),
  ].join("\n");
