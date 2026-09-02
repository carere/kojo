import { createSignal } from "solid-js";

export type DaemonConnectionState = "connected" | "retrying" | "reconnect";

const [daemonConnectionState, setDaemonConnectionState] =
  createSignal<DaemonConnectionState>("connected");
const consecutiveReadAttempts = new Map<string, number>();
let mutationsLocked = false;
let manualReconnectInProgress = false;

export { daemonConnectionState };

export const noteDaemonRetry = (): void => {
  setDaemonConnectionState("retrying");
};

export const requireDaemonReconnect = (): void => {
  mutationsLocked = true;
  manualReconnectInProgress = false;
  setDaemonConnectionState("reconnect");
};

export const beginDaemonReconnect = (): void => {
  consecutiveReadAttempts.clear();
  manualReconnectInProgress = true;
  setDaemonConnectionState("retrying");
};

export const noteDaemonConnected = (): void => {
  if (mutationsLocked || daemonConnectionState() === "reconnect") return;
  setDaemonConnectionState("connected");
};

export const daemonMutationsAllowed = (): boolean => {
  daemonConnectionState();
  return !mutationsLocked;
};

export const daemonReadsAllowed = (): boolean => daemonConnectionState() !== "reconnect";

export const beginDaemonRead = (path: string): boolean => {
  if (!daemonReadsAllowed()) return false;
  const attempts = (consecutiveReadAttempts.get(path) ?? 0) + 1;
  if (attempts > 3) {
    requireDaemonReconnect();
    return false;
  }
  consecutiveReadAttempts.set(path, attempts);
  return true;
};

export const noteDaemonReadFailure = (path: string): void => {
  if ((consecutiveReadAttempts.get(path) ?? 0) >= 3) requireDaemonReconnect();
};

export const noteDaemonReadSuccess = (path: string): void => {
  consecutiveReadAttempts.delete(path);
  if (mutationsLocked && !manualReconnectInProgress) return;
  mutationsLocked = false;
  manualReconnectInProgress = false;
  setDaemonConnectionState("connected");
};
