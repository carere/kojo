import { randomUUID } from "node:crypto";
import { chmod, link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { HostIdentity } from "../models/host-identity";
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
  try {
    return Schema.decodeUnknownSync(HostIdentity)((await readFile(path, "utf8")).trim());
  } catch (cause) {
    throw new InvalidHostIdentityError("Kojo Host Identity is invalid.", { cause });
  }
};

export const loadHostIdentity = async (path: string) => {
  await prepareHostStoreDirectory(dirname(path));
  const identity = Schema.decodeUnknownSync(HostIdentity)(`host:${randomUUID()}`);
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
