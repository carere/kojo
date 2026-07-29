import { randomUUID } from "node:crypto";
import { chmod, link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareHostStoreDirectory, UnsafeHostStoreError } from "./host-store";

export class InvalidHostIdentityError extends Error {
  override readonly name = "InvalidHostIdentityError";
}

const readHostIdentity = async (path: string) => {
  const information = await lstat(path);
  const userId = process.getuid?.();
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    (userId !== undefined && information.uid !== userId)
  ) {
    throw new UnsafeHostStoreError("Kojo Host Identity must be owned by the current user.");
  }
  await chmod(path, 0o600);
  const identity = (await readFile(path, "utf8")).trim();
  if (
    !/^host:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity)
  ) {
    throw new InvalidHostIdentityError("Kojo Host Identity is invalid.");
  }
  return identity;
};

export const loadHostIdentity = async (path: string) => {
  await prepareHostStoreDirectory(dirname(path));
  const identity = `host:${randomUUID()}`;
  const temporaryPath = `${path}.${randomUUID()}.next`;
  await writeFile(temporaryPath, `${identity}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  try {
    await link(temporaryPath, path);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readHostIdentity(path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
};
