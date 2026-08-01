import type {
  ControlSubscriptionDelivery,
  ControlSubscriptionUpdate,
  ExecutionTracePage,
  HostOverview as HostOverviewSnapshot,
  ProjectCondition,
  ProjectIdentity,
  ProjectSnapshot,
  WorkflowRunId,
  WorkflowRunListItem,
  WorkflowRunSnapshot,
  WorkflowScheduleAllowedAction,
  WorkflowScheduleOccurrenceSnapshot,
  WorkflowScheduleSnapshot,
} from "@kojo/control";
import { RequestKey } from "@kojo/control";
import type { Stream } from "effect";
import { Schema } from "effect";
import type { ExecutionTraceSelection } from "../../traces/components/execution-trace";

export interface WorkflowInspectorProps {
  /** Test and embedded-client seam. The production route leaves this unset. */
  readonly loadOverview?: (signal: AbortSignal) => Promise<HostOverviewSnapshot | undefined>;
  /** Test seam for a Host-owned trace query. */
  readonly loadTrace?: (
    selection: ExecutionTraceSelection,
  ) => Promise<ExecutionTracePage | undefined>;
  /** Test seam for the live Host subscription. */
  readonly followTrace?: (
    selection: ExecutionTraceSelection,
    afterSequence: number,
  ) => Stream.Stream<ControlSubscriptionUpdate, unknown>;
  /** Test seam for acknowledging a live Host delivery. */
  readonly acknowledgeTrace?: (
    delivery: ControlSubscriptionDelivery,
  ) => import("effect").Effect.Effect<void>;
  readonly traceRefreshIntervalMs?: number;
}

export type WorkflowDefinition =
  HostOverviewSnapshot["projectDefinitions"][number]["definitions"]["workflows"][number];
export type ReadinessAssessment = NonNullable<HostOverviewSnapshot["readiness"]>[number];
export type RetentionSnapshot = NonNullable<HostOverviewSnapshot["retention"]>[number];
export type DialogKind = "fresh-start" | "reveal" | "stop" | null;
export type PanelKind = "navigator" | "inspector";

export interface ProjectRailProps {
  readonly projects: ReadonlyArray<ProjectSnapshot>;
  readonly selectedIdentity: ProjectIdentity | undefined;
  readonly conditionFor: (identity: ProjectIdentity) => ProjectCondition;
  readonly onSelect: (identity: ProjectIdentity) => void;
}

export interface ResourceNavigatorProps {
  readonly project: ProjectSnapshot;
  readonly condition: ProjectCondition;
  readonly definitions: ReadonlyArray<WorkflowDefinition>;
  readonly schedules: ReadonlyArray<WorkflowScheduleSnapshot>;
  readonly occurrences: ReadonlyArray<WorkflowScheduleOccurrenceSnapshot>;
  readonly runs: ReadonlyArray<WorkflowRunListItem>;
  readonly selectedRunId: WorkflowRunId | undefined;
  readonly onSelectRun: (runId: WorkflowRunId) => void;
  readonly onScheduleAction: (
    schedule: WorkflowScheduleSnapshot,
    action: WorkflowScheduleAllowedAction,
  ) => Promise<void>;
}

export interface RunGraphProps {
  readonly runs: ReadonlyArray<WorkflowRunListItem>;
  readonly selectedRunId: WorkflowRunId | undefined;
  readonly onSelectRun: (runId: WorkflowRunId) => void;
}

export interface InspectorPanelProps {
  readonly project: ProjectSnapshot;
  readonly run: WorkflowRunListItem | undefined;
  readonly definition: WorkflowDefinition | undefined;
  readonly retention: RetentionSnapshot | undefined;
  readonly canStart: boolean;
  readonly canReveal: boolean;
  readonly revealedRun: WorkflowRunSnapshot | undefined;
  readonly artifactIds: ReadonlyArray<string>;
  readonly busyAction: string | undefined;
  readonly onResume: (value: string) => Promise<void>;
  readonly onCompleteDeferred: (token: string, value: string) => Promise<void>;
  readonly onStop: () => void;
  readonly onFreshStart: () => void;
  readonly onReveal: () => void;
}

export const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export const conditionTone: Record<ProjectCondition, string> = {
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300",
  limited: "bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300",
  "needs-attention": "bg-rose-100 text-rose-800 dark:bg-rose-400/10 dark:text-rose-300",
};

export const conditionDot: Record<ProjectCondition, string> = {
  ready: "bg-emerald-500",
  limited: "bg-amber-500",
  "needs-attention": "bg-rose-500",
};

export const runTone: Record<WorkflowRunListItem["state"], string> = {
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300",
  suspended: "bg-sky-100 text-sky-800 dark:bg-sky-400/10 dark:text-sky-300",
  stopping: "bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300",
  stopped: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-400/10 dark:text-rose-300",
  completed: "bg-violet-100 text-violet-800 dark:bg-violet-400/10 dark:text-violet-300",
};

export const formatTime = (value: number | null) =>
  value === null ? "No next occurrence" : new Date(value).toLocaleString();

export const formatDateTime = (value: number | null) =>
  value === null ? "Not recorded" : new Date(value).toLocaleString();

export const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
};

export const formatOptionalBytes = (value: number | null) =>
  value === null ? "off" : formatBytes(value);

export const formatRetentionDuration = (value: number | null) => {
  if (value === null) return "off";
  const days = value / (24 * 60 * 60 * 1_000);
  return Number.isInteger(days) ? `${days}d` : `${Math.round(value / 1_000)}s`;
};

export const requestKey = () => Schema.decodeUnknownSync(RequestKey)(crypto.randomUUID());

export const parseJson = (
  source: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } => {
  if (source.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return { ok: false, message: "Use valid JSON for the sensitive value." };
  }
};

export const projectMatches = (
  snapshot: { readonly project: ProjectSnapshot },
  identity: ProjectIdentity,
) => snapshot.project.identity === identity;
