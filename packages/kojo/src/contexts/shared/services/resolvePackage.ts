import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedPackage, Split } from "../models/ResolvedPackage.ts";

/**
 * What this process resolves, and what another directory resolves — asked of the machine.
 *
 * **Synchronous, and node's own modules rather than the `FileSystem` port.** The same choice
 * `factoryWorkflows.ts` makes, for the same reason: this answers a question about module
 * resolution, and module resolution is what the runtime already did before any layer existed.
 * Everything here is a read of a `package.json` and a `realpath`, and none of it can be usefully
 * faked — a fake would be a claim about resolution rather than a measurement of it.
 */

/**
 * One `package.json`, if it names something. A directory marker with no name is not a package.
 *
 * **The manifest is realpathed, not the directory it is in**, and that distinction is the whole
 * correctness of this file. A package manager installing a `file:` dependency does not link the
 * directory: bun fills a real directory with links to each of the original's files. So the
 * directory's own realpath is the *copy's* path while every file in it — and therefore every module
 * the runtime loads out of it — is the original. Comparing directories there reports two copies of
 * a package that is demonstrably one, which is worse than the fault it was written to catch:
 * it refuses a factory that works. Measured against `bun install`, not reasoned about.
 */
const packageAt = (directory: string): ResolvedPackage | undefined => {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.version !== "string") return undefined;
    return {
      name: record.name,
      version: record.version,
      directory: dirname(realpathSync(manifest)),
    };
  } catch {
    return undefined;
  }
};

/** Every directory from this one up to the root, which is the walk both lookups below perform. */
const upwards = function* (from: string): Generator<string> {
  let directory = from;
  for (;;) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
};

/** The package a file belongs to: the nearest `package.json` above it that names a version. */
const packageAbove = (from: string): ResolvedPackage | undefined => {
  for (const directory of upwards(from)) {
    const found = packageAt(directory);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * What a bare specifier resolves to from a directory — node's own algorithm, minus what cannot
 * apply here.
 *
 * There are no conditional exports to honour and no self-reference to consider: the callers ask
 * about `kojo` and `effect` from a directory that is neither. What is left is the `node_modules`
 * walk, and the realpath at the end of it, which is the part that matters.
 */
export const installedPackage = (from: string, name: string): ResolvedPackage | undefined => {
  for (const directory of upwards(from)) {
    if (directory.endsWith("/node_modules")) continue;
    const found = packageAt(join(directory, "node_modules", name));
    if (found !== undefined) return found;
  }
  return undefined;
};

/** This engine: the `kojo` package the process is running out of, wherever that is. */
export const thisEngine = (): ResolvedPackage | undefined =>
  packageAbove(dirname(fileURLToPath(import.meta.url)));

/** The `effect` this engine itself loaded, which is the copy every port and schema here came from. */
export const thisEffect = (): ResolvedPackage | undefined => {
  const engine = thisEngine();
  return engine === undefined ? undefined : installedPackage(engine.directory, "effect");
};

/**
 * Whether a directory resolves a different `effect` from the one this process is running on.
 *
 * `undefined` means *no evidence of a split*: either the two agree, or one of them cannot be
 * resolved at all. Not being able to resolve `effect` is a real fault and a different one — the
 * factory has not been installed — and it is reported where it can be told apart from this.
 */
export const splitEffect = (from: string): Split | undefined => {
  const mine = thisEffect();
  const theirs = installedPackage(from, "effect");
  if (mine === undefined || theirs === undefined) return undefined;
  return mine.directory === theirs.directory ? undefined : { mine, theirs };
};
