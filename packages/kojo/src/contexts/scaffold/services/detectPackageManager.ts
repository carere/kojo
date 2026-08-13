import { Effect, FileSystem, Path } from "effect";
import {
  lockfiles,
  packageManagers,
  type Toolchain,
  toolchainFor,
} from "../models/PackageManager.ts";

/**
 * What the repository says about itself, gathered before any decision is made.
 *
 * A record rather than two arguments so the decision below is a **pure function of evidence**. The
 * looking is one effect, the deciding is one function, and only the second one has to be tested
 * against a table of cases.
 */
export interface Evidence {
  /** The `packageManager` field of `package.json`, if there is one. Corepack's own declaration. */
  readonly declared?: string | undefined;
  /** Which of `lockfiles` were found. Order does not matter; the table decides precedence. */
  readonly present: ReadonlyArray<string>;
}

/**
 * Which manager this repository is built with, and what that costs the image and the commands.
 *
 * Precedence is Sandcastle's: the declared `packageManager` field first, then the lockfile table in
 * its order, then npm. Matching it is not politeness — Sandcastle builds worktrees and containers
 * for the same repository, and two tools that disagreed about which of two lockfiles wins would
 * produce an image for one manager and a command block for the other.
 *
 * **npm with no evidence is a guess, and it is recorded as one.** `evidence` is absent in that
 * case, and both stamped files say so in their own comments rather than asserting a lockfile that
 * is not there.
 */
export const packageManagerFrom = (evidence: Evidence): Toolchain => {
  const declared = (evidence.declared ?? "").split("@")[0];
  const named = packageManagers.find((manager) => manager === declared);
  if (named !== undefined) return toolchainFor(named, "the packageManager field of package.json");

  for (const [file, manager] of lockfiles) {
    if (evidence.present.includes(file)) return toolchainFor(manager, file);
  }

  return toolchainFor("npm");
};

/** The `packageManager` field, or nothing. A malformed `package.json` is silence, not a failure. */
const declaredIn = (json: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    const field =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).packageManager
        : undefined;
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Go and look at the repository.
 *
 * Every read is swallowed on the way out. This whole function is an attempt to be helpful, and a
 * repository whose `package.json` is unreadable is a repository that gets the npm default rather
 * than a failed initialisation — being wrong about the package manager is a comment to correct,
 * and refusing to stamp a factory is a person blocked.
 */
export const detectPackageManager = (
  root: string,
): Effect.Effect<Toolchain, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const json = yield* fileSystem
      .readFileString(path.join(root, "package.json"))
      .pipe(Effect.orElseSucceed(() => ""));

    const present: Array<string> = [];
    for (const [file] of lockfiles) {
      const found = yield* fileSystem
        .exists(path.join(root, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (found) present.push(file);
    }

    return packageManagerFrom({ declared: declaredIn(json), present });
  });
