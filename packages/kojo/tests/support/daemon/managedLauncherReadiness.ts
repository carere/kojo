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

export const managedLauncherReadinessTimeoutMillis = 30_000;

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
