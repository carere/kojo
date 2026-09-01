import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type {
  AutomaticStart,
  LogoutPersistence,
  ManagerState,
  ProcessState,
} from "../models/DaemonStatus.ts";

export interface NativeServiceObservation {
  readonly automaticStart: AutomaticStart;
  readonly manager: ManagerState;
  readonly process: ProcessState;
  readonly loginLifetime: string;
  readonly logoutPersistence: LogoutPersistence;
  readonly detail?: string;
}

export interface NativeService {
  readonly serviceDocument: (paths: DaemonPaths) => string;
  readonly assertSupported: () => void;
  readonly inspect: () => NativeServiceObservation;
  readonly installAndStart: (serviceDefinition: string) => void;
  readonly start: (serviceDefinition: string) => void;
  readonly stop: () => void;
  readonly enable: () => void;
  readonly disable: (stopNow: boolean) => void;
  readonly keepRunningAfterLogout: () => void;
}
