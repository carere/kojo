export type AutomaticStart = "disabled" | "enabled" | "unknown";
export type ManagerState = "loaded" | "unavailable" | "unloaded";
export type ProcessState = "running" | "stopped" | "unknown";
export type Responsiveness = "responsive" | "unresponsive" | "unknown";

export interface DaemonStatus {
  readonly installed: boolean;
  readonly managedCli: string;
  readonly automaticStart: AutomaticStart;
  readonly manager: ManagerState;
  readonly process: ProcessState;
  readonly responsiveness: Responsiveness;
  readonly ready: boolean;
  readonly loginLifetime: "macOS GUI login session";
  readonly detail?: string;
}
