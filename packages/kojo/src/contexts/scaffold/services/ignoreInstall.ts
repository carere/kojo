import { Effect, FileSystem, Path } from "effect";
import { ScaffoldError } from "../models/ScaffoldError.ts";

/**
 * The repository's own `.gitignore`, covering what `kojo init`'s instructions create.
 *
 * `kojo init` prints "1. bun install" and walks away. The install writes `node_modules/`, and the
 * first approved run then refuses its merge with `MergeRefused: main holds uncommitted changes` —
 * over the very directory init told the person to create. Refusing a dirty trunk is correct;
 * creating the condition it will later refuse is the defect. So the scaffolder that asks for the
 * install is the one that arranges for its product to be ignored.
 *
 * This file follows `manifest.ts`, not `stamp.ts`, and for the same reason: a planned file is
 * written whole or kept whole, and a repository's own `.gitignore` is a file that rule would
 * mangle the second time it ran. The rule here is **merge, never rewrite**: what is already there
 * is kept byte for byte, and only the entries nothing covers are appended in one commented block.
 *
 * **The lockfile is deliberately not ignored.** The install writes one — `bun.lock`,
 * `package-lock.json`, whichever the manager owns — and it belongs in the history, not in this
 * file: the stamped `commands.install` restores dependencies *frozen against it* (`bun install
 * --frozen-lockfile`, `npm ci`), so a worktree cut from a branch that never committed the lockfile
 * is a sandbox whose install fails. It is also the evidence `detectPackageManager` reads on the
 * next stamp. What keeps it off the trunk's `git status` is the commit step init's instructions
 * now carry, not an ignore rule.
 */

/** What the install init instructs writes, and nothing must track. */
export const installArtifacts: ReadonlyArray<string> = ["node_modules/"];

/** What became of the repository's `.gitignore`. */
export type IgnoreOutcome = "created" | "updated" | "kept";

/** What happened, in the terms `kojo init` prints. */
export interface IgnoreReport {
  readonly path: string;
  readonly outcome: IgnoreOutcome;
  /** The entries this run appended. Empty on `kept`. */
  readonly added: ReadonlyArray<string>;
}

/** Everything the decision below decides, and nothing that needs a disk. */
export interface IgnoreDecision extends IgnoreReport {
  /** What to write. Absent when there is nothing to write. */
  readonly content?: string;
}

/**
 * Whether one existing line already covers one entry.
 *
 * Deliberately narrow: a line is a cover when, stripped of the anchors people spell it with — a
 * leading slash, a trailing slash, a leading `**` segment — it names the same directory. Full
 * gitignore pattern semantics are not reimplemented here; a wildcard that happens to match is not
 * recognised, and the cost of that is one redundant, clearly attributed entry rather than a
 * tracked `node_modules/`.
 */
const covers = (line: string, entry: string): boolean => {
  const bare = line.trim();
  if (bare === "" || bare.startsWith("#") || bare.startsWith("!")) return false;
  const normalise = (pattern: string) =>
    pattern
      .replace(/^\*\*\//, "")
      .replace(/^\//, "")
      .replace(/\/$/, "");
  return normalise(bare) === normalise(entry);
};

/** One commented block, saying who added it and why — the shape an appended rule should have. */
const block = (entries: ReadonlyArray<string>): string =>
  [
    "# What `kojo init`'s own instructions create. Added by `kojo init`; everything else in this",
    "# file is yours and was left untouched. The install it asks for writes this, and a run's",
    "# merge refuses a trunk holding uncommitted files — so the scaffolder that asks for the",
    "# install is the one that ignores its product. The lockfile is deliberately not here: the",
    "# sandbox restores dependencies frozen against it, so it belongs in the history. Commit it.",
    ...entries,
    "",
  ].join("\n");

/**
 * What the `.gitignore` should become, as a pure function of what it is.
 *
 * Pure for the reason `manifestFor` is pure: "what would initialisation append, to a repository
 * that already ignores this" is a question a unit test can put to a value.
 */
export const ignoreFor = (options: {
  /** The file as it is, or nothing when there is none. */
  readonly existing?: string | undefined;
}): IgnoreDecision => {
  const path = ".gitignore";

  if (options.existing === undefined) {
    return { path, outcome: "created", added: installArtifacts, content: block(installArtifacts) };
  }

  const lines = options.existing.split("\n");
  const missing = installArtifacts.filter((entry) => !lines.some((line) => covers(line, entry)));

  if (missing.length === 0) return { path, outcome: "kept", added: [] };

  const kept = options.existing.endsWith("\n") ? options.existing : `${options.existing}\n`;
  return { path, outcome: "updated", added: missing, content: `${kept}\n${block(missing)}` };
};

/** Read the repository's `.gitignore`, decide, and write only when there is something to write. */
export const ignoreInstall = (options: {
  readonly root: string;
}): Effect.Effect<IgnoreReport, ScaffoldError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(options.root, ".gitignore");

    const existing = yield* fileSystem
      .readFileString(target)
      .pipe(Effect.orElseSucceed(() => undefined));

    const decision = ignoreFor({ existing });

    if (decision.content !== undefined) {
      yield* fileSystem.writeFileString(target, decision.content).pipe(
        Effect.mapError(
          (cause) =>
            new ScaffoldError({
              operation: "write",
              target: ".gitignore",
              reason: cause.message,
              cause,
            }),
        ),
      );
    }

    return { path: decision.path, outcome: decision.outcome, added: decision.added };
  });
