import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

export type TraceMutation =
  | { readonly kind: "run-started"; readonly record: JsonValue }
  | {
      readonly kind: "run-finished";
      readonly runId: string;
      readonly outcome: "succeeded" | "failed" | "suspended";
      readonly finishedAt: number;
    }
  | {
      readonly kind: "phase-entered";
      readonly runId: string;
      readonly phase: JsonValue;
    }
  | { readonly kind: "phase"; readonly record: JsonValue }
  | { readonly kind: "gate"; readonly record: JsonValue }
  | { readonly kind: "sandbox"; readonly record: JsonValue }
  | { readonly kind: "occurrence"; readonly record: JsonValue };

export interface TraceProjection {
  readonly phases: ReadonlyArray<Record<string, JsonValue>>;
  readonly gates: ReadonlyArray<Record<string, JsonValue>>;
  readonly sandboxes: ReadonlyArray<Record<string, JsonValue>>;
}
