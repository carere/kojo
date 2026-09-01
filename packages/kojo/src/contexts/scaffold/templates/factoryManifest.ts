import type { StarterAgent } from "./starter.ts";

/** The non-source inputs retained with every Workflow Revision. */
export const factoryManifest = (agents: ReadonlyArray<StarterAgent>, dockerfile: boolean): string =>
  `${JSON.stringify(
    {
      formatVersion: 1,
      assets: [
        "kojo.config.yaml",
        ...agents.flatMap((agent) => [
          `prompts/${agent.name}/system.md`,
          `prompts/${agent.name}/user.md`,
        ]),
        ...(dockerfile ? ["sandbox/Dockerfile"] : []),
      ].sort(),
    },
    undefined,
    2,
  )}\n`;
