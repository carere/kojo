import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { LifecycleError } from "../models/LifecycleError.ts";

export interface DaemonSingletonLock {
  readonly unlock: () => void;
}

/** Acquire the Host advisory lock that gives one Daemon sole ownership of one data root. */
export const acquireDaemonSingletonLock = (path: string): DaemonSingletonLock => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(descriptor, 0o600);
  const stat = fstatSync(descriptor);
  if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile()) {
    closeSync(descriptor);
    throw new LifecycleError("UNSAFE_SINGLETON", "the singleton lock has unsafe ownership");
  }

  const lockLibrary =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : undefined;
  if (lockLibrary === undefined) {
    closeSync(descriptor);
    throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no supported advisory file lock");
  }
  const library = dlopen(lockLibrary, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const locked = library.symbols.flock(descriptor, 2 | 4);
  if (locked !== 0) {
    library.close();
    closeSync(descriptor);
    throw new LifecycleError("DAEMON_ALREADY_RUNNING", "another Daemon owns this data root");
  }
  return {
    unlock: () => {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    },
  };
};
