export type ProjectCondition = "ready" | "limited" | "needs-attention";
export type RunState = "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";

export interface PrototypeProject {
  id: string;
  name: string;
  path: string;
  condition: ProjectCondition;
  summary: string;
  runningCount: number;
}

export interface PrototypeRun {
  id: string;
  workflow: string;
  state: RunState;
  trigger: "manual" | "schedule" | "child";
  started: string;
  detail: string;
  parentId?: string;
  schedule?: string;
}

export interface PrototypeSchedule {
  id: string;
  workflow: string;
  expression: string;
  timeZone: string;
  enabled: boolean;
  condition: "available" | "unavailable" | "needs-attention";
  next: string | null;
  detail: string;
}

export const projects: ReadonlyArray<PrototypeProject> = [
  {
    id: "apollo",
    name: "Apollo",
    path: "~/work/apollo",
    condition: "ready",
    summary: "3 schedules · 18 runs",
    runningCount: 2,
  },
  {
    id: "borealis",
    name: "Borealis",
    path: "~/work/borealis",
    condition: "limited",
    summary: "1 finding · 1 suspended",
    runningCount: 1,
  },
  {
    id: "catalyst",
    name: "Catalyst",
    path: "~/labs/catalyst",
    condition: "needs-attention",
    summary: "Configuration cannot load",
    runningCount: 0,
  },
];

export const schedules: ReadonlyArray<PrototypeSchedule> = [
  {
    id: "nightly-evaluate",
    workflow: "Evaluate release",
    expression: "*/15 9-18 * * 1-5",
    timeZone: "Europe/Paris",
    enabled: true,
    condition: "available",
    next: "Today, 14:45 · in 8 min",
    detail: "Allow overlap · revision sch_91c",
  },
  {
    id: "weekday-review",
    workflow: "Review dependencies",
    expression: "0 8 * * 1-5",
    timeZone: "Europe/Paris",
    enabled: false,
    condition: "available",
    next: null,
    detail: "Skip overlap · revision sch_a20",
  },
  {
    id: "release-audit",
    workflow: "Audit candidate",
    expression: "0 17 * * 5",
    timeZone: "UTC",
    enabled: true,
    condition: "needs-attention",
    next: null,
    detail: "Workflow revision unavailable",
  },
];

export const initialRuns: ReadonlyArray<PrototypeRun> = [
  {
    id: "run_7F3A",
    workflow: "Evaluate release",
    state: "running",
    trigger: "manual",
    started: "4m ago",
    detail: "Implement candidate · 2 of 4 activities",
  },
  {
    id: "run_7E9C",
    workflow: "Evaluate release",
    state: "suspended",
    trigger: "schedule",
    schedule: "nightly-evaluate · 14:15",
    started: "22m ago",
    detail: "Waiting for developer approval",
  },
  {
    id: "run_7E9C.1",
    workflow: "Review implementation",
    state: "completed",
    trigger: "child",
    parentId: "run_7E9C",
    started: "26m ago",
    detail: "Child run · replay reused 3 activities",
  },
  {
    id: "run_7D42",
    workflow: "Evaluate release",
    state: "completed",
    trigger: "schedule",
    schedule: "nightly-evaluate · 14:00",
    started: "37m ago",
    detail: "Completed in 11m 42s",
  },
  {
    id: "run_7C8B",
    workflow: "Review dependencies",
    state: "failed",
    trigger: "manual",
    started: "Yesterday",
    detail: "Typed failure · dependency policy",
  },
];

export const traceEvents = [
  {
    sequence: 18,
    time: "14:36:42",
    kind: "run.recovered",
    title: "Project Runtime recovered the run",
    detail: "Replaying durable execution after Host restart",
    tone: "amber",
  },
  {
    sequence: 19,
    time: "14:36:43",
    kind: "activity.replayed",
    title: "Inspect repository reused its result",
    detail: "Activity result replayed · no external work repeated",
    tone: "violet",
  },
  {
    sequence: 20,
    time: "14:36:44",
    kind: "child.completed",
    title: "Review implementation completed",
    detail: "Child Workflow Run run_7E9C.1 · 8m 12s",
    tone: "green",
  },
  {
    sequence: 21,
    time: "14:36:45",
    kind: "run.suspended",
    title: "Waiting for developer approval",
    detail: "Manual resume required · same durable run",
    tone: "blue",
  },
] as const;

export const occurrences = [
  {
    time: "14:00",
    state: "started",
    run: "run_7D42",
    runState: "completed",
    note: "Started one Workflow Run",
  },
  {
    time: "14:15",
    state: "started",
    run: "run_7E9C",
    runState: "suspended",
    note: "Waiting for approval",
  },
  {
    time: "14:30",
    state: "skipped",
    run: null,
    runState: null,
    note: "Overlap policy skipped this instant",
  },
  { time: "14:45", state: "planned", run: null, runState: null, note: "Due in 8 minutes" },
] as const;

export const stateTone: Record<RunState, string> = {
  running: "bg-emerald-400/15 text-emerald-700 dark:text-emerald-300",
  suspended: "bg-sky-400/15 text-sky-700 dark:text-sky-300",
  stopping: "bg-amber-400/15 text-amber-700 dark:text-amber-300",
  stopped: "bg-zinc-400/15 text-zinc-600 dark:text-zinc-300",
  failed: "bg-rose-400/15 text-rose-700 dark:text-rose-300",
  completed: "bg-violet-400/15 text-violet-700 dark:text-violet-300",
};

export const projectTone: Record<ProjectCondition, string> = {
  ready: "bg-emerald-400",
  limited: "bg-amber-400",
  "needs-attention": "bg-rose-400",
};
