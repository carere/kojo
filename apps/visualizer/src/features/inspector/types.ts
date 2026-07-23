export type WorkflowRunState =
  | "Running"
  | "Suspended"
  | "Interrupted"
  | "Failed"
  | "Completed"
  | "Discarded";

export interface InspectorProjectSummary {
  readonly availability: {
    readonly reason?: string;
    readonly status: "Available" | "Unavailable";
  };
  readonly displayName: string;
  readonly id: string;
  readonly registrationState: "Enabled" | "Disabled" | "Archived";
}

export interface InspectorRunSummary {
  readonly attempt: number;
  readonly createdAt: string;
  readonly project: InspectorProjectSummary;
  readonly runId: string;
  readonly state: WorkflowRunState;
  readonly workflowName: string;
}

export interface InspectorEvidence {
  readonly artifacts: ReadonlyArray<{
    readonly availability: "Available" | "Unavailable";
    readonly byteLength: number;
    readonly fingerprint: string;
    readonly mediaType: string;
    readonly name: string;
  }>;
  readonly attempt: number;
  readonly causationId?: string | null;
  readonly details: unknown;
  readonly eventId: string;
  readonly parentEventId?: string | null;
  readonly recordedAt: string;
  readonly schema: { readonly status: "Known" | "Unknown"; readonly version: number };
  readonly sequence: number;
  readonly subject: string;
  readonly type: string;
}

export interface InspectorRun {
  readonly actions: ReadonlyArray<{
    readonly enabled: boolean;
    readonly name: "discard" | "resume" | "suspend";
    readonly reason?: string;
  }>;
  readonly attempts: ReadonlyArray<{
    readonly finishedAt?: string | null;
    readonly number: number;
    readonly startedAt: string;
    readonly state: WorkflowRunState;
  }>;
  readonly children: ReadonlyArray<InspectorRun>;
  readonly createdAt: string;
  readonly evidence: ReadonlyArray<InspectorEvidence>;
  readonly input: unknown;
  readonly invocationKey?: string | null;
  readonly outcome: unknown;
  readonly parentRunId?: string | null;
  readonly project: InspectorProjectSummary;
  readonly projectId: string;
  readonly resumeCompatibility: { readonly reason?: string; readonly status: string };
  readonly rootRunId: string;
  readonly runId: string;
  readonly runtimeConfigurationCompatibility: { readonly reason?: string; readonly status: string };
  readonly state: WorkflowRunState;
  readonly workflowName: string;
}
