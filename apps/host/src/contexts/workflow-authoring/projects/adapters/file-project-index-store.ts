import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Layer, Schema } from "effect";
import {
  emptyProjectIndexState,
  ProjectIndexState,
  ProjectIndexStore,
  type ProjectIndexStoreShape,
} from "../services/project-index-store";

const writeState = async (path: string, state: ProjectIndexState) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const readState = async (path: string): Promise<ProjectIndexState> => {
  try {
    const information = await lstat(path);
    const userId = process.getuid?.();
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      (userId !== undefined && information.uid !== userId) ||
      (information.mode & 0o777) !== 0o600
    ) {
      throw new Error("unsafe Project Index");
    }
    return Schema.decodeUnknownSync(ProjectIndexState)(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProjectIndexState();
    throw new Error("Kojo Project Index is invalid.");
  }
};

export const makeFileProjectIndexStore = async (path: string): Promise<ProjectIndexStoreShape> => {
  let state = await readState(path);
  let mutation = Promise.resolve();

  return {
    read: Effect.sync(() => state),
    update: <A>(
      change: (state: ProjectIndexState) => Effect.Effect<{ state: ProjectIndexState; result: A }>,
    ) => {
      const result = mutation.then(async () => {
        const update = await Effect.runPromise(change(state));
        await writeState(path, update.state);
        state = update.state;
        return update.result;
      });
      mutation = result.then(
        () => undefined,
        () => undefined,
      );
      return Effect.promise(() => result);
    },
  };
};

export const makeFileProjectIndexStoreLayer = (path: string) =>
  Layer.effect(
    ProjectIndexStore,
    Effect.promise(() => makeFileProjectIndexStore(path)),
  );
