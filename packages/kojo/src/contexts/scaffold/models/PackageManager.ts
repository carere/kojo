/**
 * The four package managers a TypeScript repository is likely to be built with.
 *
 * A plain tuple rather than a `Schema`, because nothing decodes this from outside the process. It
 * is read off the target repository's own files by `detectPackageManager`, and it is written into
 * two stamped files that must agree — see `toolchainFor`.
 */
export const packageManagers = ["bun", "pnpm", "yarn", "npm"] as const;
export type PackageManager = (typeof packageManagers)[number];

/**
 * Lockfile to manager, in the order the files are looked for.
 *
 * The order is Sandcastle's own (`detectPackageManager` in its bundle), and matching it matters:
 * a repository can hold two lockfiles, and two tools that disagree about which one wins would
 * build an image for one manager and a command block for the other. Bun first, npm last.
 */
export const lockfiles: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * What one manager means to the two files that have to agree about it.
 *
 * **This type is edge 7 as a data structure.** Code phases run through the `Workspace` port, which
 * for an isolated provider is the container itself, and an agent asked to run the suite runs it
 * inside the sandbox whatever the provider is. So `install` — the command `.kojo/commands.ts`
 * ships — and `image` — the lines `.kojo/sandbox/Dockerfile` ships — are one decision with two
 * spellings. Holding them in one record is what stops the two from drifting: there is nowhere to
 * write one without the other.
 */
export interface Toolchain {
  readonly manager: PackageManager;
  /**
   * How dependencies are restored.
   *
   * Real, and deliberately not a placeholder. A lockfile is evidence, so this is knowledge rather
   * than a guess — unlike the test, lint and build commands, which no scaffolder can know. See
   * `models/Placeholder.ts`.
   */
  readonly install: string;
  /** The Dockerfile lines that put this manager in the image, run as root before `USER`. */
  readonly image: ReadonlyArray<string>;
  /** Which file said so, for the comment the Dockerfile carries. Absent when nothing said so. */
  readonly evidence?: string;
}

/**
 * The image lines per manager, against a `node:22-bookworm` base.
 *
 * npm needs none — the base image carries it. pnpm and yarn come from corepack, which ships with
 * Node. Bun is a separate binary and is installed globally with npm, which is the one line that
 * works the same on every architecture the base image is published for.
 */
const imageLines: Record<PackageManager, ReadonlyArray<string>> = {
  npm: [],
  pnpm: ["RUN corepack enable && corepack prepare pnpm@latest --activate"],
  yarn: ["RUN corepack enable && corepack prepare yarn@stable --activate"],
  bun: ["RUN npm install -g bun"],
};

const installCommands: Record<PackageManager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --immutable",
  bun: "bun install --frozen-lockfile",
};

/**
 * How a person restores dependencies **the first time**, which is a different command.
 *
 * `Toolchain.install` is what a phase runs inside the sandbox, so it is frozen against the
 * lockfile — a code phase that resolved a new version would grade something other than what was
 * committed. But `kojo init` has just added two entries to `package.json` that no lockfile knows
 * about, and every frozen form above **fails** on exactly that. So the one command the stamped
 * README and `kojo init` tell a person to run is this one, and the difference between the two is
 * written down here rather than discovered at the first step of the walk-through.
 */
export const firstInstall = (manager: PackageManager): string => `${manager} install`;

/** Everything a stamped factory needs to know about the manager it was initialised against. */
export const toolchainFor = (manager: PackageManager, evidence?: string): Toolchain => ({
  manager,
  install: installCommands[manager],
  image: imageLines[manager],
  ...(evidence === undefined ? {} : { evidence }),
});
