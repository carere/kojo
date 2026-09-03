export type ManagedLauncherReadiness =
  | { readonly state: "ready" }
  | { readonly state: "exited"; readonly exitCode: number }
  | { readonly state: "timed-out"; readonly process: "running"; readonly timeoutMillis: number };

interface ManagedLauncherReadinessOptions {
  readonly endpointPresent: () => boolean;
  readonly exitCode: () => number | null;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ManagedLauncherExitDeadline {
  readonly cancel: () => void;
}

interface ManagedLauncherExitOptions {
  readonly exited: Promise<unknown>;
  readonly timeoutMillis: number;
  readonly onTimeout: () => Promise<void>;
  readonly startDeadline?: (
    expire: () => Promise<void>,
    timeoutMillis: number,
  ) => ManagedLauncherExitDeadline;
}

const startManagedLauncherExitDeadline = (
  expire: () => Promise<void>,
  timeoutMillis: number,
): ManagedLauncherExitDeadline => {
  const timer = setTimeout(() => void expire(), timeoutMillis);
  return { cancel: () => clearTimeout(timer) };
};

export const managedLauncherReadinessTimeoutMillis = 30_000;

export const waitForManagedLauncherExit = async (
  options: ManagedLauncherExitOptions,
): Promise<boolean> => {
  const startDeadline = options.startDeadline ?? startManagedLauncherExitDeadline;
  let deadline: ManagedLauncherExitDeadline | undefined;
  let deadlineExpired = false;
  const timedOut = new Promise<boolean>((resolve, reject) => {
    deadline = startDeadline(async () => {
      deadlineExpired = true;
      try {
        await options.onTimeout();
        resolve(false);
      } catch (cause) {
        reject(cause);
      }
    }, options.timeoutMillis);
  });
  const exited = options.exited.then(() => (deadlineExpired ? timedOut : true));
  try {
    return await Promise.race([exited, timedOut]);
  } finally {
    deadline?.cancel();
  }
};

export const observeManagedLauncherReadiness = async (
  options: ManagedLauncherReadinessOptions,
): Promise<ManagedLauncherReadiness> => {
  const timeoutMillis = managedLauncherReadinessTimeoutMillis;
  const pollMillis = 25;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + timeoutMillis;
  while (true) {
    const exitCode = options.exitCode();
    if (exitCode !== null) return { state: "exited", exitCode };
    if (options.endpointPresent()) {
      const endpointExitCode = options.exitCode();
      return endpointExitCode === null
        ? { state: "ready" }
        : { state: "exited", exitCode: endpointExitCode };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const timeoutExitCode = options.exitCode();
      return timeoutExitCode === null
        ? { state: "timed-out", process: "running", timeoutMillis }
        : { state: "exited", exitCode: timeoutExitCode };
    }
    await sleep(Math.min(pollMillis, remaining));
  }
};
