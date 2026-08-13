// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this module writes a Dockerfile, and
// `${AGENT_UID}` is Docker's own build-arg syntax rather than a TypeScript interpolation somebody
// forgot to make a template literal. Turning it into one would emit the value of a variable that
// does not exist in this program.

import { agentInstalls, type FactoryChoices } from "../models/FactoryChoices.ts";

/**
 * The image a factory's phases and agents run in.
 *
 * **Edge 7 lives here and in `commands.ts`, and neither is complete without the other.** The
 * package-manager block below and the `install` command in `.kojo/commands.ts` are rendered from
 * one `Toolchain` value, so there is no way to stamp a factory whose image lacks the tool its
 * first command block calls. If you change one by hand, change the other.
 *
 * The structure — `node:22-bookworm`, the uid/gid build args, the rename of the base image's
 * `node` user to `agent`, `ENTRYPOINT ["sleep", "infinity"]` — is Sandcastle's, because Sandcastle
 * is what starts the container: its Docker provider passes `--user <host uid>:<host gid>`, mounts
 * the worktree, and runs `docker exec` against a container that must therefore still be alive.
 */
export const dockerfile = (choices: FactoryChoices): string => {
  const install = agentInstalls[choices.agent];
  const evidence =
    choices.toolchain.evidence === undefined
      ? "no lockfile was found, so npm was assumed"
      : `detected from ${choices.toolchain.evidence}`;

  const managerBlock =
    choices.toolchain.image.length === 0
      ? [
          `# ${choices.toolchain.manager} ships with the base image, so there is nothing to install.`,
        ]
      : [...choices.toolchain.image];

  return [
    "# This file is yours. Kojo wrote it once and will never overwrite it.",
    "#",
    "# It is the image every sandboxed phase and every agent of this factory runs inside. Kojo",
    `# builds it as \`${choices.imageName}\` — the same name \`.kojo/workflows/\` asks for, so`,
    "# renaming it here means renaming it there too.",
    "",
    "FROM node:22-bookworm",
    "",
    "# Everything a repository needs before it is a repository.",
    "RUN apt-get update && apt-get install -y \\",
    "  git \\",
    "  curl \\",
    "  jq \\",
    "  && rm -rf /var/lib/apt/lists/*",
    "",
    "# --- the toolchain your phases need ------------------------------------------",
    `# ${choices.toolchain.manager}, ${evidence}. \`.kojo/commands.ts\` runs`,
    `# \`${choices.toolchain.install}\`, so this block and that file are one decision. A code phase`,
    "# that calls a tool the image does not carry fails inside the container, minutes after the",
    "# run started and nowhere near the file that was wrong.",
    ...managerBlock,
    "",
    "# --- the container user ------------------------------------------------------",
    "# Sandcastle starts containers with `--user <host uid>:<host gid>` and checks the image agrees.",
    "# `kojo init` passes this machine's uid and gid as build args; a rebuild on another machine",
    "# should do the same.",
    "ARG AGENT_UID=1000",
    "ARG AGENT_GID=1000",
    "RUN groupmod -o -g $AGENT_GID node \\",
    "  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node",
    "",
    ...(install.beforeUser.length === 0
      ? []
      : [`# --- ${choices.agent}, installed as root ---`, ...install.beforeUser, ""]),
    "USER ${AGENT_UID}:${AGENT_GID}",
    "",
    ...(install.afterUser.length === 0
      ? []
      : [`# --- ${choices.agent}, installed as the agent user ---`, ...install.afterUser, ""]),
    "WORKDIR /home/agent",
    "",
    "# Sandcastle bind-mounts the run's worktree and then execs into it, so the container has to",
    "# outlive its own start-up. Nothing here is the process that does the work.",
    'ENTRYPOINT ["sleep", "infinity"]',
    "",
  ].join("\n");
};
