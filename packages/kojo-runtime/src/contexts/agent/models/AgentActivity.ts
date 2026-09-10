/** Provider measurements. Missing fields mean unavailable, not zero. */
export interface AgentUsage {
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

/** Public provider activity; private reasoning and raw transport data are excluded. */
export type AgentActivity =
  | {
      readonly kind: "started";
      readonly at: number;
      readonly agent: string;
      readonly provider: string;
      readonly model: string;
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
    }
  | {
      readonly kind: "message" | "tool-started" | "tool-finished" | "output" | "omitted";
      readonly at: number;
      readonly name?: string;
      readonly toolId?: string;
      readonly text: string;
      readonly failed?: boolean;
      readonly redacted?: boolean;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: "finished";
      readonly at: number;
      readonly outcome: "succeeded" | "failed" | "interrupted";
      readonly usage?: AgentUsage;
    };
