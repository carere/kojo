export interface WorkflowActivityReceipt {
  readonly projectId: string;
  readonly workflowName: string;
  readonly activity: "active" | "inactive";
  readonly trigger: boolean;
  readonly pollerStarted: boolean;
  readonly pollerId?: string;
  readonly changedAt: string;
}

export interface TriggerPoller {
  readonly projectId: string;
  readonly workflowName: string;
  readonly pollerId: string;
  readonly startedAt: string;
}
