import { factoryDirectory, workflowsDirectory } from "../../shared/models/FactoryLayout.ts";
import type { FactoryChoices, TemplateName } from "../models/FactoryChoices.ts";
import type { FactoryPlan } from "../models/FactoryPlan.ts";
import { commands } from "../templates/commands.ts";
import { config } from "../templates/config.ts";
import { dockerfile } from "../templates/dockerfile.ts";
import { factoryManifest } from "../templates/factoryManifest.ts";
import { hotfix } from "../templates/hotfix.ts";
import { review } from "../templates/review.ts";
import { authoring, skill, skillsDirectory } from "../templates/skills.ts";
import type { Starter } from "../templates/starter.ts";
import { environment, ignore, readme } from "../templates/support.ts";

/** Every starter this build can stamp. The template answer names one of these. */
export const starters: Record<TemplateName, Starter> = { review, hotfix };

/**
 * Everything initialisation would write, as content.
 *
 * **Pure.** No filesystem, no clock, no process. That is what makes the two properties this ticket
 * turns on — that the package manager reached the image and the command block together, and that
 * every stamped command is obviously fake — questions a unit test can put to a value rather than
 * to a directory somebody has to create first.
 *
 * The paths are relative to the target repository root, which is also what makes a plan comparable
 * between two machines.
 */
export const plan = (choices: FactoryChoices): FactoryPlan => {
  const starter = starters[choices.template];
  const workflow = starter.workflow(choices);
  const at = (...parts: ReadonlyArray<string>) => [factoryDirectory, ...parts].join("/");
  const skillAt = (...parts: ReadonlyArray<string>) => [skillsDirectory, ...parts].join("/");

  return {
    directories: [],
    files: [
      { path: at("README.md"), content: readme(choices, starter) },
      { path: at("factory.json"), content: factoryManifest(starter.agents, true) },
      { path: at(".gitignore"), content: ignore() },
      { path: at(".env"), content: environment(choices) },
      { path: at("kojo.config.yaml"), content: config(choices, starter.agents) },
      { path: at("envelopes.ts"), content: starter.envelopes },
      { path: at("checks.ts"), content: starter.checks(choices) },
      { path: at("commands.ts"), content: commands(choices) },
      { path: at(workflowsDirectory, workflow.file), content: workflow.source },
      { path: at("sandbox", "Dockerfile"), content: dockerfile(choices) },
      ...starter.agents.flatMap((agent) => [
        { path: at("prompts", agent.name, "system.md"), content: agent.system },
        { path: at("prompts", agent.name, "user.md"), content: agent.user },
      ]),
      // **The only two files this plan writes outside `.kojo/`.** A skill has to sit where the
      // agent's harness looks for one, and no harness looks inside a factory — so an agent working
      // in a stamped repository knows how to drive the thing that is stamped there. See
      // `templates/skills.ts`; the content is independent of every answer, because it is about Kojo
      // rather than about this factory.
      { path: skillAt("SKILL.md"), content: skill() },
      { path: skillAt("authoring.md"), content: authoring() },
    ],
  };
};

/**
 * The default image tag for a repository, derived from its directory name.
 *
 * Sandcastle derives `sandcastle:<repo directory>` the same way when it is told nothing. The
 * `kojo-` prefix keeps the two apart on a machine that runs both, and the lowercasing is not
 * cosmetic: Docker refuses a tag with an upper-case letter in it.
 */
export const defaultImageName = (repositoryDirectory: string): string => {
  const cleaned = repositoryDirectory.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = cleaned.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  return `kojo-${trimmed === "" ? "factory" : trimmed}:latest`;
};
