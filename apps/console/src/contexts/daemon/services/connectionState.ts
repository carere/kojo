import { createSignal } from "solid-js";

export type DaemonConnectionState = "connected" | "retrying" | "reconnect";

const [daemonConnectionState, setDaemonConnectionState] =
  createSignal<DaemonConnectionState>("connected");
const consecutiveReadFailures = new Map<string, number>();

export { daemonConnectionState };

export const noteDaemonRetry = (): void => {
  setDaemonConnectionState("retrying");
};

export const requireDaemonReconnect = (): void => {
  setDaemonConnectionState("reconnect");
};

export const beginDaemonReconnect = (): void => {
  consecutiveReadFailures.clear();
  setDaemonConnectionState("retrying");
};

export const noteDaemonConnected = (): void => {
  if (daemonConnectionState() === "reconnect") return;
  setDaemonConnectionState("connected");
};

export const daemonMutationsAllowed = (): boolean => daemonConnectionState() !== "reconnect";

export const daemonReadsAllowed = (): boolean => daemonConnectionState() !== "reconnect";

export const noteDaemonReadFailure = (path: string): void => {
  const failures = (consecutiveReadFailures.get(path) ?? 0) + 1;
  consecutiveReadFailures.set(path, failures);
  if (failures >= 3) requireDaemonReconnect();
};

export const noteDaemonReadSuccess = (path: string): void => {
  consecutiveReadFailures.delete(path);
  noteDaemonConnected();
};
