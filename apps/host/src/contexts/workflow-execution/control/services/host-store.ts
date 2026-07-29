import { chmod, lstat, mkdir } from "node:fs/promises";

export class UnsafeHostStoreError extends Error {
  override readonly name = "UnsafeHostStoreError";
}

const isOwnedDirectory = (information: Awaited<ReturnType<typeof lstat>>) => {
  const userId = process.getuid?.();
  return (
    information.isDirectory() &&
    !information.isSymbolicLink() &&
    (userId === undefined || information.uid === userId)
  );
};

export const prepareHostStoreDirectory = async (path: string) => {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const information = await lstat(path);
    if (!isOwnedDirectory(information)) {
      throw new UnsafeHostStoreError("Kojo Host store must be owned by the current user.");
    }
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if (!isOwnedDirectory(secured) || (secured.mode & 0o777) !== 0o700) {
      throw new UnsafeHostStoreError("Kojo Host store must be accessible only to its owner.");
    }
  } catch (error) {
    if (error instanceof UnsafeHostStoreError) throw error;
    throw new UnsafeHostStoreError("Kojo Host store cannot be secured for the current user.", {
      cause: error,
    });
  }
};
