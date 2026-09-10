/** An authored observation of one work item. It does not establish execution authority. */
export interface WorkItemProgress {
  readonly key: string;
  readonly title: string;
  /** Increase for each change to this item. Keep revisions stable on Workflow replay. */
  readonly revision: number;
  readonly state: "waiting" | "executing" | "accepted" | "integrating" | "integrated" | "failed";
  readonly waitingFor?: "dependencies" | "capacity" | "human";
  readonly detail: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly url?: string;
}
