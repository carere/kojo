import { Effect, FileSystem, Path, type PlatformError } from "effect";

/** One place a promise reached the published types. */
export interface PromiseLeak {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Blank comments and string bodies while keeping each line break. */
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
        blank(index + (source[index] === "\\" ? 2 : 1));
      }
      if (index < source.length) keep(1);
      continue;
    }
    keep(1);
  }

  return out;
};

/** Find bare Promise and PromiseLike identifiers in one declaration file. */
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

/** Find promise leaks under one directory of emitted declarations. */
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

/** Render one actionable line for each leak. */
export const reportLeaks = (leaks: ReadonlyArray<PromiseLeak>): string =>
  [
    `${leaks.length} promise${leaks.length === 1 ? "" : "s"} reached the published types.`,
    "Every promise belongs in contexts/sandbox/adapters/boundary.ts; everything else is Effect.",
    ...leaks.map((leak) => `  ${leak.file}:${leak.line}  ${leak.text}`),
  ].join("\n");
