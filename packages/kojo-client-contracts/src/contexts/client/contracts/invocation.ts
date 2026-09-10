/** Measurements received from the provider. Absent values are unavailable. */
export interface InvocationUsage {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly contextTokens?: number;
  readonly contextCapacity?: number;
  readonly reportedCostUsd?: number;
  readonly estimatedCostUsd?: number;
  readonly estimateBasis?: string;
}

export interface InvocationDocument {
  readonly invocationId: string;
  readonly phasePath: string;
  readonly attempt: number;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly endedAt?: string;
  readonly state: "executing" | "succeeded" | "failed" | "interrupted";
  readonly system: string;
  readonly user: string;
  readonly renderedPrompt: string;
  readonly systemDelivery:
    | "user-message"
    | "not-sent"
    | "native-system"
    | "native-system-and-user-message";
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly usage?: InvocationUsage;
  readonly activities: ReadonlyArray<{
    readonly sequence: number;
    readonly kind: "message" | "tool-started" | "tool-finished" | "output" | "omitted";
    readonly at: string;
    readonly name?: string;
    readonly toolId?: string;
    readonly text: string;
    readonly failed?: boolean;
    readonly redacted?: boolean;
    readonly truncated?: boolean;
  }>;
}

/** Totals include each retained physical invocation once. Context occupancy is never summed. */
export interface InvocationTotals {
  readonly count: number;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly usagePartial: boolean;
  readonly reportedCostUsd?: number;
  readonly reportedCostPartial: boolean;
  readonly estimatedCostUsd?: number;
  readonly estimatedCostPartial: boolean;
  readonly estimateBases: ReadonlyArray<string>;
}
