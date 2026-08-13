import { Effect, FileSystem, Path } from "effect";
import { type Declared, declarations, type EngineDependency } from "../models/EngineDependency.ts";
import { ScaffoldError } from "../models/ScaffoldError.ts";

/**
 * The repository's own manifest, which is the one file `.kojo/` cannot do without.
 *
 * It is not stamped by `plan`, and that is deliberate rather than an oversight: every planned file
 * is written whole or kept whole, and this one has to be **merged**. A repository being turned into
 * a factory usually already has a `package.json` full of somebody's own decisions, and the honest
 * edit is to add the two entries that are missing and to touch nothing else.
 *
 * So the rule here is narrower than `stamp`'s, not wider. `stamp` never overwrites a file; this
 * never overwrites a *value*. A dependency already declared — at any version, in any of the four
 * dependency blocks — is left exactly as it is and reported as a mismatch when it disagrees. A
 * scaffolder that silently re-pinned somebody's `effect` would be the same class of defect as one
 * that silently replaced their workflow.
 */

/** What became of the manifest. `unreadable` is a file that is there and is not JSON. */
export type ManifestOutcome = "created" | "updated" | "kept" | "unreadable";

/** A dependency this repository already declares at a version that is not the engine's. */
export interface Mismatch {
  readonly name: string;
  /** What the engine needs. */
  readonly wanted: string;
  /** What the repository says, and what was left in place. */
  readonly declared: string;
}

/** What happened to `package.json`, in the terms `kojo init` prints and `kojo doctor` re-checks. */
export interface ManifestReport {
  readonly path: string;
  readonly outcome: ManifestOutcome;
  /** The entries this run added. Empty on `kept`. */
  readonly added: ReadonlyArray<Declared>;
  /** The entries this run refused to change. */
  readonly mismatched: ReadonlyArray<Mismatch>;
}

/** Everything the decision below needs, and nothing that needs a disk. */
export interface ManifestDecision extends ManifestReport {
  /** What to write. Absent when there is nothing to write. */
  readonly content?: string;
}

/** The four blocks a dependency may already be declared in, in the order they are searched. */
const blocks = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const objectAt = (manifest: Record<string, unknown>, key: string): Record<string, string> => {
  const found = manifest[key];
  return found !== null && typeof found === "object" ? (found as Record<string, string>) : {};
};

/** What this repository already says about one package, wherever it says it. */
const declaredIn = (manifest: Record<string, unknown>, name: string): string | undefined => {
  for (const block of blocks) {
    const specifier = objectAt(manifest, block)[name];
    if (typeof specifier === "string") return specifier;
  }
  return undefined;
};

/**
 * A package name a registry would accept, out of a directory name a person chose.
 *
 * Only reached when the repository has no manifest at all, so it never renames anything: it names
 * something that had no name.
 */
export const manifestName = (directory: string): string => {
  const cleaned = directory.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = cleaned.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  return trimmed === "" ? "factory" : trimmed;
};

const serialise = (manifest: Record<string, unknown>): string =>
  `${JSON.stringify(manifest, undefined, 2)}\n`;

/**
 * What the manifest should become, as a pure function of what it is.
 *
 * Pure for the reason `plan` is pure: "what would initialisation declare, into a repository that
 * already declares this" is a question a unit test can put to a value, and putting it to a
 * directory somebody has to create first is how a rule this delicate goes ungraded.
 */
export const manifestFor = (options: {
  /** The file as it is, or nothing when there is none. */
  readonly existing?: string | undefined;
  /** The repository's directory name, used only when a manifest is created. */
  readonly directory: string;
  readonly engine: EngineDependency;
}): ManifestDecision => {
  const path = "package.json";
  const wanted = declarations(options.engine);

  if (options.existing === undefined) {
    return {
      path,
      outcome: "created",
      added: wanted,
      mismatched: [],
      content: serialise({
        name: manifestName(options.directory),
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          wanted.map((entry) => [entry.name, entry.specifier] as const),
        ),
      }),
    };
  }

  const parsed: unknown = (() => {
    try {
      return JSON.parse(options.existing) as unknown;
    } catch {
      return undefined;
    }
  })();

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      path,
      outcome: "unreadable",
      added: [],
      mismatched: wanted.map((entry) => ({
        name: entry.name,
        wanted: entry.specifier,
        declared: "unknown — the file is not a JSON object",
      })),
    };
  }

  const manifest = { ...(parsed as Record<string, unknown>) };
  const dependencies = { ...objectAt(manifest, "dependencies") };
  const added: Array<Declared> = [];
  const mismatched: Array<Mismatch> = [];

  for (const entry of wanted) {
    const already = declaredIn(manifest, entry.name);
    if (already === undefined) {
      dependencies[entry.name] = entry.specifier;
      added.push(entry);
    } else if (already !== entry.specifier) {
      mismatched.push({ name: entry.name, wanted: entry.specifier, declared: already });
    }
  }

  if (added.length === 0) return { path, outcome: "kept", added: [], mismatched };

  manifest.dependencies = dependencies;
  return { path, outcome: "updated", added, mismatched, content: serialise(manifest) };
};

/** Read the manifest, decide, and write it back only when the decision has something to write. */
export const declareEngine = (options: {
  readonly root: string;
  readonly engine: EngineDependency;
}): Effect.Effect<ManifestReport, ScaffoldError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(options.root, "package.json");

    const existing = yield* fileSystem
      .readFileString(target)
      .pipe(Effect.orElseSucceed(() => undefined));

    const decision = manifestFor({
      existing,
      directory: path.basename(options.root),
      engine: options.engine,
    });

    if (decision.content !== undefined) {
      yield* fileSystem.writeFileString(target, decision.content).pipe(
        Effect.mapError(
          (cause) =>
            new ScaffoldError({
              operation: "write",
              target: "package.json",
              reason: cause.message,
              cause,
            }),
        ),
      );
    }

    return {
      path: decision.path,
      outcome: decision.outcome,
      added: decision.added,
      mismatched: decision.mismatched,
    };
  });
