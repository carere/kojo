import type { AutomaticStart, ManagerState, ProcessState } from "../models/DaemonStatus.ts";

export interface NativeServiceObservation {
  readonly automaticStart: AutomaticStart;
  readonly manager: ManagerState;
  readonly process: ProcessState;
  readonly detail?: string;
}

export interface NativeService {
  readonly inspect: () => NativeServiceObservation;
  readonly installAndStart: (launchAgent: string) => void;
  readonly start: (launchAgent: string) => void;
  readonly stop: () => void;
  readonly enable: () => void;
  readonly disable: (stopNow: boolean) => void;
}
