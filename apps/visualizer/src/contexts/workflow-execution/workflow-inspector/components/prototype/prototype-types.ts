import type { PrototypeRun } from "./prototype-data";

export interface WorkflowInspectorPrototypeModel {
  selectedProject: () => string;
  selectProject: (projectId: string) => void;
  selectedRun: () => PrototypeRun;
  selectRun: (runId: string) => void;
  runs: () => ReadonlyArray<PrototypeRun>;
  isScheduleEnabled: (scheduleId: string) => boolean;
  toggleSchedule: (scheduleId: string) => void;
  requestResume: () => void;
  requestFreshStart: () => void;
  requestStop: () => void;
  requestReveal: () => void;
  requestDownload: (name: string) => void;
  showAddProject: () => void;
}
