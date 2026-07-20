import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const SANDBOX_CODEX_HOME = "/home/agent/.codex";
const HOST_CODEX_AUTH = "/home/agent/.host-codex/auth.json";
const HOST_ENV_FILE = resolve(import.meta.dir, "../../../../..", ".sandcastle/.env");
const EMPTY_HOST_ENV_FILE = resolve(import.meta.dir, "../../../../..", ".sandcastle/.env.example");

const readHostEnvironment = () => {
  try {
    return readFileSync(HOST_ENV_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const hostEnvironmentKeys = (hostEnvironment: string) =>
  new Set(
    hostEnvironment
      .split("\n")
      .map((line) => line.match(/^\s*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );

interface SandboxCreateOptions {
  readonly env: Record<string, string>;
  readonly [key: string]: unknown;
}

type RuntimeDockerProvider = ReturnType<typeof docker> & {
  readonly create: (options: SandboxCreateOptions) => Promise<unknown>;
};

interface SandboxProviderOptions {
  readonly hostEnvironment?: string;
  readonly providerFactory?: (options?: DockerOptions) => ReturnType<typeof docker>;
}

export const prompts = {
  implementer: resolve(import.meta.dir, "../../../prompts/implement.md"),
  integrationRepair: resolve(import.meta.dir, "../../../prompts/repair-integration.md"),
  planner: resolve(import.meta.dir, "../../../prompts/plan.md"),
  reviewer: resolve(import.meta.dir, "../../../prompts/review.md"),
};

export const createSandboxProvider = (options: SandboxProviderOptions = {}) => {
  const hostOnlyKeys = hostEnvironmentKeys(options.hostEnvironment ?? readHostEnvironment());
  const provider = (options.providerFactory ?? docker)({
    env: { CODEX_HOME: SANDBOX_CODEX_HOME },
    mounts: [
      {
        hostPath: "~/.codex/auth.json",
        readonly: true,
        sandboxPath: HOST_CODEX_AUTH,
      },
      {
        hostPath: EMPTY_HOST_ENV_FILE,
        readonly: true,
        sandboxPath: ".sandcastle/.env",
      },
    ],
  }) as RuntimeDockerProvider;

  const wrappedProvider = {
    ...provider,
    // Sandcastle loads .sandcastle/.env automatically. Strip every declared
    // host-only value after that merge and before Docker receives the environment.
    create: (createOptions: SandboxCreateOptions) =>
      provider.create({
        ...createOptions,
        env: Object.fromEntries(
          Object.entries(createOptions.env).filter(([key]) => !hostOnlyKeys.has(key)),
        ),
      }),
  };
  return wrappedProvider as unknown as ReturnType<typeof docker>;
};

export const hooks = {
  host: {
    // Docker file mounts require the nested destination to exist in each
    // generated worktree before the container starts. `touch` preserves the
    // real host file for head-mode runs while creating an empty ignored file
    // in branch worktrees.
    onWorktreeReady: [{ command: "touch .sandcastle/.env" }],
  },
  sandbox: {
    onSandboxReady: [
      {
        command: [
          `mkdir -p "${SANDBOX_CODEX_HOME}"`,
          `test -f "${HOST_CODEX_AUTH}"`,
          `cp "${HOST_CODEX_AUTH}" "${SANDBOX_CODEX_HOME}/auth.json"`,
        ].join(" && "),
      },
      { command: "bun ci", timeoutMs: 300_000 },
    ],
  },
};
