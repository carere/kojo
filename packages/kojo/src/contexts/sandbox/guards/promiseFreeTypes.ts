import { Effect, FileSystem, Path, type PlatformError } from "effect";

/**
 * The guard that keeps the Sandcastle boundary from spreading.
 *
 * Sandcastle's own build asserts that Effect never appears in its published types. This asserts the
 * inverse for Kojo: a bare promise never appears in **ours**. Same discipline, opposite direction,
 * and between them the two packages can hold different Effect versions and different async models
 * with neither leaking into the other.
 *
 * It grades the emitted declarations rather than the source, because a declaration file is what a
 * consumer actually sees. `src/scripts/check-public-types.ts` is the executable, and
 * `moon run kojo:check-public-types` is where it fails a build.
 */

/** One place a promise reached the published types, named well enough to go and delete it. */
export interface PromiseLeak {
  /** The declaration file, as the caller named it. */
  readonly file: string;
  /** One-based, so it pastes into an editor. */
  readonly line: number;
  /** The offending line, trimmed. */
  readonly text: string;
}

/**
 * Blank out comments and string bodies, keeping every line break.
 *
 * Both have to go. A docblock that says "returns a promise" is prose, not a leak, and a string
 * literal holding `Promise` is data. Blanking rather than deleting keeps line numbers true, which
 * is the only thing that makes a finding worth reporting.
 *
 * A character scanner rather than a regex, because the two hazards cancel each other: a `//` inside
 * a string would end a line early, and a quote inside a comment would open a string that never
 * closes. One pass that knows which state it is in has neither problem.
 */
const blankOut = (source: string): string => {
  let out = "";
  let index = 0;

  const keep = (count: number) => {
    out += source.slice(index, index + count);
    index += count;
  };
  const blank = (until: number) => {
    for (; index < until && index < source.length; index++) {
      out += source[index] === "\n" ? "\n" : " ";
    }
  };
  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      const newline = source.indexOf("\n", index);
      blank(newline === -1 ? source.length : newline);
      continue;
    }
    if (two === "/*") {
      const close = source.indexOf("*/", index + 2);
      blank(close === -1 ? source.length : close + 2);
      continue;
    }

    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      keep(1);
      while (index < source.length && source[index] !== quote) {
        // A backslash consumes whatever follows it, including the quote that would have closed.
        const step = source[index] === "\\" ? 2 : 1;
        blank(index + step);
      }
      if (index < source.length) keep(1);
      continue;
    }

    keep(1);
  }

  return out;
};

/**
 * Every `Promise` left in one declaration file once the prose is gone.
 *
 * The word itself is the finding — a `.d.ts` has no honest use for the identifier that is not a
 * promise reaching a caller. `PromiseLike` counts too: it is the shape `await` accepts, so a type
 * that returns one has leaked the boundary just as surely.
 *
 * Two names, not a prefix. `PromiseLeak` above is a Kojo type about promises rather than a promise,
 * and a check that flagged its own vocabulary is a check somebody switches off.
 */
export const promiseLeaksIn = (file: string, source: string): ReadonlyArray<PromiseLeak> => {
  const lines = blankOut(source).split("\n");
  const original = source.split("\n");
  const leaks: Array<PromiseLeak> = [];

  lines.forEach((line, offset) => {
    if (!/\bPromise(Like)?\b/.test(line)) return;
    leaks.push({ file, line: offset + 1, text: (original[offset] ?? line).trim() });
  });

  return leaks;
};

/**
 * Every `Promise` under one directory of emitted declarations, in a stable order.
 *
 * Reading a directory of build output rather than a list of files is deliberate: a check that is
 * told which files to look at is a check that misses the file somebody forgot to list. Note the one
 * way it can over-report — `tsc --build` does not delete the declaration of a source file that was
 * removed, so a stale leak survives until `tsc --build --clean`. It errs towards a finding, which is
 * the safe direction for a guard.
 */
export const promiseLeaksUnder = (
  directory: string,
): Effect.Effect<
  ReadonlyArray<PromiseLeak>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
    const declarations = entries.filter((entry) => entry.endsWith(".d.ts")).sort();

    const leaks: Array<PromiseLeak> = [];
    for (const declaration of declarations) {
      const source = yield* fileSystem.readFileString(path.join(directory, declaration));
      leaks.push(...promiseLeaksIn(declaration, source));
    }
    return leaks;
  });

/** What the check prints. One line per leak, plus the sentence that says why it is one. */
export const reportLeaks = (leaks: ReadonlyArray<PromiseLeak>): string =>
  [
    `${leaks.length} promise${leaks.length === 1 ? "" : "s"} reached the published types.`,
    "Every promise belongs in contexts/sandbox/adapters/boundary.ts; everything else is Effect.",
    ...leaks.map((leak) => `  ${leak.file}:${leak.line}  ${leak.text}`),
  ].join("\n");
