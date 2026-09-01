import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LifecycleError } from "../models/LifecycleError.ts";

const uid = (): number => process.getuid?.() ?? -1;

export const assertPrivateNode = (path: string, kind: "directory" | "file"): void => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new LifecycleError("UNSAFE_HOST_PATH", `${path} is a symbolic link`);
  }
  if (stat.uid !== uid()) {
    throw new LifecycleError("UNSAFE_HOST_PATH", `${path} is not owned by the current OS user`);
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new LifecycleError("UNSAFE_HOST_PATH", `${path} is not a ${kind}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new LifecycleError("UNSAFE_HOST_PATH", `${path} is accessible by another OS user`);
  }
};

export const ensurePrivateDirectory = (path: string): void => {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: true });
  assertPrivateNode(path, "directory");
  chmodSync(path, 0o700);
};

export const atomicPrivateFile = (path: string, content: string, mode = 0o600): void => {
  ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, content, "utf8");
    const stat = fstatSync(descriptor);
    if (stat.uid !== uid() || !stat.isFile()) {
      throw new LifecycleError("UNSAFE_HOST_PATH", `${temporary} has unsafe ownership`);
    }
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
};

export const removeOwnedPlainFile = (path: string): void => {
  if (!existsSync(path)) return;
  assertPrivateNode(path, "file");
  unlinkSync(path);
};

export const removeOwnedSocket = (path: string): void => {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    stat.uid !== uid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new LifecycleError("UNSAFE_HOST_PATH", `${path} is not a private owned socket`);
  }
  unlinkSync(path);
};
