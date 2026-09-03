export interface NativeHostChildProcess {
  readonly processId: number;
  readonly command: string;
}

const managedDaemonCommand = "launcher/main.ts";

export const selectManagedDaemonChild = (
  children: ReadonlyArray<NativeHostChildProcess>,
): NativeHostChildProcess | undefined => {
  const matches = children.filter((child) => child.command.includes(managedDaemonCommand));
  return matches.length === 1 ? matches[0] : undefined;
};

interface NativeHostKillDiagnostic {
  readonly ownerProcessId: number | undefined;
  readonly childrenBefore: ReadonlyArray<NativeHostChildProcess>;
  readonly selectedChild: NativeHostChildProcess | undefined;
  readonly killReceipt: boolean | undefined;
  readonly selectedChildLiveAfterKill: boolean | undefined;
  readonly supervisionBefore: unknown;
  readonly supervisionAfter: unknown;
  readonly childrenAfter: ReadonlyArray<NativeHostChildProcess>;
}

export const nativeHostKillDiagnostic = (observation: NativeHostKillDiagnostic): string =>
  [
    "the native Host did not observe the selected managed Daemon failure",
    `Kill observation: ${JSON.stringify(observation)}`,
  ].join("\n");
