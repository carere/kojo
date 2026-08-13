import type { EngineDependency } from "./EngineDependency.ts";
import type { Toolchain } from "./PackageManager.ts";

/**
 * The agent CLIs a stamped image knows how to install.
 *
 * Three of Sandcastle's six, and the three are the ones Kojo's own agent context has a provider
 * for — `kojoPi`, and Sandcastle's untouched `claudeCode()` and `codex()`. Offering a fourth would
 * stamp a Dockerfile for an agent nothing in this build can invoke.
 */
export const agentNames = ["pi", "claude-code", "codex"] as const;
export type AgentName = (typeof agentNames)[number];

/**
 * Every spelling `--agent` accepts — the three names, and the one near-miss.
 *
 * `--agent claude` is what a person types after reading that every answer may be given on the
 * command line, and being rejected for it — by a flag whose whole purpose is to spare them a
 * prompt — stops the prompt-free path at its first step. The canonical name is still `claude-code`,
 * and {@link canonicalAgent} is the only place a spelling becomes a name: this is a fourth spelling,
 * never a fourth agent, so nothing downstream has to know the alias exists.
 */
export const agentSpellings = [...agentNames, "claude"] as const;
export type AgentSpelling = (typeof agentSpellings)[number];

/** The agent one spelling means. Every canonical name means itself. */
export const canonicalAgent = (spelling: AgentSpelling): AgentName =>
  spelling === "claude" ? "claude-code" : spelling;

/**
 * Where the work runs, as an answer a person gives at a prompt.
 *
 * The same five providers `adapters/providers.ts` builds, named the way the CLI flag spells them.
 * `none` is a real answer, not an opt-out: a `sandboxed` scope over `noSandbox()` still cuts a
 * branch and still hands the phases a workspace — it just does it on the host.
 */
export const sandboxChoices = ["docker", "podman", "vercel", "daytona", "none"] as const;
export type SandboxChoice = (typeof sandboxChoices)[number];

/** Which of the two starter factories to stamp. */
export const templateNames = ["review", "hotfix"] as const;
export type TemplateName = (typeof templateNames)[number];

/** Whether this choice of provider is a container this machine can build an image for. */
export const buildsAnImage = (sandbox: SandboxChoice): boolean =>
  sandbox === "docker" || sandbox === "podman";

/**
 * What one agent's CLI costs the image, and what credential it wants.
 *
 * Every line here is copied from Sandcastle's own generated Dockerfiles and `.env` examples rather
 * than remembered, because an install command that is nearly right produces an image that builds
 * and an agent that is not there. The ordering matters and is not uniform: pi and codex install
 * globally as root and therefore before `USER`, while Claude Code's installer writes into
 * `~/.local/bin` and therefore after it.
 */
export interface AgentInstall {
  /** Dockerfile lines that must run as root. */
  readonly beforeUser: ReadonlyArray<string>;
  /** Dockerfile lines that must run as the agent user. */
  readonly afterUser: ReadonlyArray<string>;
  /** The `.env` block, comments included, that says which credential this agent reads. */
  readonly env: string;
  /** Sandcastle's own default model for this agent, offered when a person wants one suggested. */
  readonly defaultModel: string;
}

export const agentInstalls: Record<AgentName, AgentInstall> = {
  pi: {
    beforeUser: ["RUN npm install -g @mariozechner/pi-coding-agent"],
    afterUser: [],
    env: ["# Anthropic API key — pi reads this.", "ANTHROPIC_API_KEY="].join("\n"),
    defaultModel: "claude-sonnet-4-6",
  },
  "claude-code": {
    beforeUser: [],
    afterUser: [
      "RUN curl -fsSL https://claude.ai/install.sh | bash",
      'ENV PATH="/home/agent/.local/bin:$PATH"',
    ],
    env: [
      "# Claude Code OAuth token — get one by running `claude setup-token` on your host.",
      "# It lets the agent use your Claude subscription instead of an API key.",
      "CLAUDE_CODE_OAUTH_TOKEN=",
      "# Or an Anthropic API key instead — uncomment and fill in:",
      "# ANTHROPIC_API_KEY=",
    ].join("\n"),
    defaultModel: "claude-opus-4-8",
  },
  codex: {
    beforeUser: ["RUN npm install -g @openai/codex"],
    afterUser: [],
    env: ["# OpenAI API key — codex reads this.", "OPENAI_KEY="].join("\n"),
    defaultModel: "gpt-5.4",
  },
};

/**
 * Every answer initialisation needs, gathered before a single file is written.
 *
 * Four of the seven are the person's — agent, model, sandbox, template. The other three are read
 * off the machine: the toolchain from the repository's lockfile, the image name from its directory,
 * and the engine dependency from the `kojo` this process is running out of. Gathering them into one
 * value is what makes the plan a pure function of the answers, and therefore what makes "what would
 * this write" a question a unit test can ask without a filesystem.
 */
export interface FactoryChoices {
  readonly agent: AgentName;
  readonly model: string;
  readonly sandbox: SandboxChoice;
  readonly template: TemplateName;
  readonly toolchain: Toolchain;
  /** What `docker build --tag` is given, and what the stamped workflow names as its image. */
  readonly imageName: string;
  /**
   * What the repository must declare for a stamped file to resolve one line of itself.
   *
   * Here rather than only in the manifest writer because the README has to be able to *say* it:
   * a walk-through that begins with an install whose versions it cannot name is a walk-through that
   * only works when nothing has gone wrong.
   */
  readonly engine: EngineDependency;
}
