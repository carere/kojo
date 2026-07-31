import { dlopen, FFIType, read } from "bun:ffi";
import { constants, fstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { ProjectSnapshot } from "@kojo/control";
import type { DisposableFileUnlinker, NoFollowUnlinkResult } from "./disposable-file-unlinker";

/**
 * bun:ffi is currently supported here only on Darwin and glibc Linux Hosts.
 * Unsupported Hosts fail the removal operation; they never fall back to a
 * path-based unlink.
 */
const glibcLinux =
  process.platform === "linux" &&
  (
    process.report?.getReport?.() as
      | { readonly header?: { readonly glibcVersionRuntime?: string } }
      | undefined
  )?.header?.glibcVersionRuntime !== undefined;
const nativeSupported = process.platform === "darwin" || glibcLinux;
const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
const nativeSymbols = nativeSupported
  ? dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.pointer },
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    }).symbols
  : undefined;

const atFdcwd = -2;
const closeOnExec =
  (constants as typeof constants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ??
  (process.platform === "darwin" ? 0x01000000 : 0x80000);
const noFollowDirectory =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
const noFollowFile =
  constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0) | closeOnExec;
const missingErrnos = new Set([2, 20]);
const loopErrnos = new Set(process.platform === "darwin" ? [62] : [40]);

const cString = (value: string) => Buffer.from(`${value}\0`);
const currentErrno = () => {
  if (nativeSymbols === undefined) throw new Error("no-follow native deletion is unsupported");
  const pointer = nativeSymbols[errnoSymbol]();
  if (pointer === null) throw new Error("errno pointer is unavailable");
  return read.i32(pointer as Parameters<typeof read.i32>[0]);
};

const openAt = (directoryFd: number, path: string, flags: number) => {
  if (nativeSymbols === undefined) throw new Error("no-follow native deletion is unsupported");
  return nativeSymbols.openat(directoryFd, cString(path), flags) as number;
};

const close = (fileDescriptor: number) => {
  if (fileDescriptor >= 0 && nativeSymbols !== undefined) nativeSymbols.close(fileDescriptor);
};

const throwFileSystemError = (operation: string, path: string, errorNumber: number): never => {
  const error = new Error(`${operation} failed for ${path} (errno ${errorNumber})`);
  Object.assign(error, { code: `E${errorNumber}` });
  throw error;
};

const openDirectoryPath = (path: string): number => {
  const components = resolve(path).split(sep).filter(Boolean);
  let directoryFd = openAt(atFdcwd, "/", noFollowDirectory);
  if (directoryFd < 0) throwFileSystemError("open directory", path, currentErrno());
  try {
    for (const component of components) {
      const next = openAt(directoryFd, component, noFollowDirectory);
      if (next < 0) throwFileSystemError("open directory", path, currentErrno());
      close(directoryFd);
      directoryFd = next;
    }
    return directoryFd;
  } catch (error) {
    close(directoryFd);
    throw error;
  }
};

const openProjectRoot = async (path: string): Promise<number | "missing" | "unsafe"> => {
  if (nativeSymbols === undefined) throw new Error("no-follow native deletion is unsupported");
  const absolute = resolve(path);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(absolute));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  const parentFd = openDirectoryPath(canonicalParent);
  try {
    const rootFd = openAt(parentFd, basename(absolute), noFollowDirectory);
    if (rootFd >= 0) return rootFd;
    return classifyOpenFailure(path);
  } finally {
    close(parentFd);
  }
};

const classifyOpenFailure = (path: string): "missing" | "unsafe" => {
  const errorNumber = currentErrno();
  if (missingErrnos.has(errorNumber)) return "missing";
  if (loopErrnos.has(errorNumber)) return "unsafe";
  throwFileSystemError("open disposable file", path, errorNumber);
  return "unsafe";
};

/**
 * Validates the initially opened regular leaf, then removes the current
 * non-directory entry from the pinned parent with unlinkat. A post-open
 * replacement symlink itself may be removed, but unlinkat never follows it,
 * so its target cannot be deleted.
 */
export const unlinkRegularFileNoFollow = async (
  project: ProjectSnapshot,
  path: string,
  beforeUnlink?: (path: string) => Promise<void>,
): Promise<NoFollowUnlinkResult> => {
  if (nativeSymbols === undefined) {
    throw new Error("no-follow native deletion is unsupported on this Host platform");
  }
  const projectRoot = resolve(project.path);
  const candidate = resolve(path);
  const candidateRelative = relative(projectRoot, candidate);
  if (
    candidateRelative === "" ||
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    candidateRelative.startsWith(sep)
  ) {
    return "unsafe";
  }
  const components = candidateRelative.split(sep).filter(Boolean);
  const name = components.pop();
  if (name === undefined) return "unsafe";

  const projectFd = await openProjectRoot(projectRoot);
  if (projectFd === "missing" || projectFd === "unsafe") return projectFd;
  let parentFd = projectFd;
  let fileFd = -1;
  try {
    for (const component of components) {
      const next = openAt(parentFd, component, noFollowDirectory);
      if (next < 0) return classifyOpenFailure(path);
      close(parentFd);
      parentFd = next;
    }
    fileFd = openAt(parentFd, name, noFollowFile);
    if (fileFd < 0) return classifyOpenFailure(path);
    if (!fstatSync(fileFd).isFile()) return "unsafe";
    if (beforeUnlink !== undefined) await beforeUnlink(path);
    const removed = nativeSymbols.unlinkat(parentFd, cString(name), 0) as number;
    if (removed === 0) return "removed";
    const errorNumber = currentErrno();
    if (missingErrnos.has(errorNumber)) return "missing";
    throwFileSystemError("unlink disposable file", path, errorNumber);
    return "missing";
  } finally {
    close(fileFd);
    close(parentFd);
  }
};

export const NoFollowDisposableFileUnlinker: DisposableFileUnlinker = {
  unlinkRegularFile: unlinkRegularFileNoFollow,
};
