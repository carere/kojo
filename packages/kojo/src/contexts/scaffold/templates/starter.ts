import type { FactoryChoices, SandboxChoice } from "../models/FactoryChoices.ts";

/**
 * One agent a starter factory names, with the two prompt files that are its identity.
 *
 * `system` and `user` are separate for the reason `AgentDefinition` gives — one is who the agent
 * is, the other is the task template. Neither carries a JSON example: `renderPrompt` appends the
 * envelope's own JSON Schema to every call, so an example written by hand here would be a second
 * contract to keep in step, and D5 exists to make that unrepresentable.
 */
export interface StarterAgent {
  readonly name: string;
  /** One line. It is what a human reads beside this agent's phase in the trace. */
  readonly purpose: string;
  /** What the agent may reach for. Empty means the provider's own default set. */
  readonly tools: ReadonlyArray<string>;
  readonly system: string;
  readonly user: string;
}

/**
 * A starter factory: the agents it names, and the three files that are its contract.
 *
 * The four parts are grouped because they must agree — the workflow calls an agent by the name the
 * roster gives it, decodes the envelope `envelopes.ts` declares, and grades it with the check
 * `checks.ts` exports. Splitting them across four unrelated modules is exactly how a scaffolder
 * ships a factory that does not run.
 */
export interface Starter {
  readonly name: string;
  /** One line, shown beside the name when a person is asked which template to stamp. */
  readonly summary: string;
  readonly agents: ReadonlyArray<StarterAgent>;
  readonly envelopes: string;
  readonly checks: (choices: FactoryChoices) => string;
  /** The file name under `.kojo/workflows/`, and its content. */
  readonly workflow: (choices: FactoryChoices) => {
    readonly file: string;
    readonly source: string;
  };
}

/**
 * The provider expression a stamped workflow holds, and the import that makes it work.
 *
 * The sandbox answer reaches the target repository as **code**, not as configuration, and that is
 * deliberate: a provider is built per run because `CreateSandboxOptions` carries no `env`, so the
 * one place it can honestly live is the file that builds it.
 */
export const providerSource = (
  choices: FactoryChoices,
): { readonly symbol: string; readonly expression: string } => {
  const named = (symbol: string, expression: string) => ({ symbol, expression });
  const image = JSON.stringify(choices.imageName);

  const bySandbox: Record<SandboxChoice, { symbol: string; expression: string }> = {
    docker: named("docker", `docker({ imageName: ${image} })`),
    podman: named("podman", `podman({ imageName: ${image} })`),
    vercel: named("vercel", "vercel()"),
    daytona: named("daytona", "daytona()"),
    // A real answer, not an opt-out: the scope still cuts a branch and still hands the phases a
    // workspace. It does it on this machine instead of in a container.
    none: named("noSandbox", "noSandbox()"),
  };

  return bySandbox[choices.sandbox];
};

/** The header every stamped TypeScript file carries, so nobody has to guess who owns it. */
export const ownedByYou = (what: string): ReadonlyArray<string> => [
  "// This file is yours.",
  "//",
  `// ${what}`,
  "//",
  "// `kojo init` wrote it once and will never overwrite it: run initialisation again and this file",
  "// is kept, not replaced. The Kojo engine itself is a versioned dependency — nothing under",
  "// `.kojo/` is a copy of it, so upgrading Kojo does not mean re-applying your edits.",
];
