import { Effect, FileSystem, type Layer, Option, PlatformError } from "effect";

/** A directory, as `FileSystem.File.Info` spells one. Only `type` is ever read. */
const directoryInfo: FileSystem.File.Info = {
  type: "Directory",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o755,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
};

/**
 * A filesystem that lives in a `Map`, for unit tests about *what* is written rather than *where*.
 *
 * Four methods, because four are all the scaffolder calls. `FileSystem.layerNoop` fills the rest
 * with defects, which is the behaviour a test wants: a scaffolder that started reading directories
 * or opening handles would fail here loudly instead of quietly passing against a fake that guessed
 * an answer for it.
 *
 * Paths are used verbatim. The scaffolder joins them with the real `Path` service, so what lands in
 * the map is exactly what a real filesystem would have been asked for.
 */
export interface MemoryFileSystem {
  readonly layer: Layer.Layer<FileSystem.FileSystem>;
  /** Everything written, in the order it was written. */
  readonly files: Map<string, string>;
  /** Every directory the scaffolder asked for. */
  readonly directories: Set<string>;
}

export const memoryFileSystem = (
  seed?: Readonly<Record<string, string>>,
  seedDirectories?: ReadonlyArray<string>,
): MemoryFileSystem => {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const directories = new Set<string>(seedDirectories ?? []);

  const layer = FileSystem.layerNoop({
    exists: (path: string) => Effect.succeed(files.has(path) || directories.has(path)),
    // Only `type` is ever asked for, and only by `Flag.directory`, which refuses a `--path` that
    // is not a directory before a handler runs.
    stat: (path: string) =>
      directories.has(path)
        ? Effect.succeed(directoryInfo)
        : Effect.succeed({ ...directoryInfo, type: "File" as const }),
    // A missing file is a **failure**, never a defect. `detectPackageManager` recovers from it
    // with `orElseSucceed`, which catches failures and not defects — so a fake that died here
    // would make an ordinary repository with no `package.json` look like a broken scaffolder.
    readFileString: (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path) ?? "")
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
              description: `nothing at ${path}`,
            }),
          ),
    writeFileString: (path: string, content: string) =>
      Effect.sync(() => void files.set(path, content)),
    makeDirectory: (path: string) => Effect.sync(() => void directories.add(path)),
  });

  return { layer, files, directories };
};
