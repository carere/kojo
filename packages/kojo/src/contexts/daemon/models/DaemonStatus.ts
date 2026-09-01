export type AutomaticStart = "disabled" | "enabled" | "unknown";
export type ManagerState = "loaded" | "unavailable" | "unloaded";
export type ProcessState = "running" | "stopped" | "unknown";
export type Responsiveness = "responsive" | "unresponsive" | "unknown";
export type LogoutPersistence = "disabled" | "enabled" | "unknown" | "unsupported";

export interface DaemonStatus {
  readonly installed: boolean;
  readonly managedCli: string;
  readonly automaticStart: AutomaticStart;
  readonly manager: ManagerState;
  readonly process: ProcessState;
  readonly responsiveness: Responsiveness;
  readonly ready: boolean;
  readonly loginLifetime: string;
  readonly logoutPersistence: LogoutPersistence;
  readonly detail?: string;
}
