import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

export interface TraceProjection {
  readonly invocations?: ReadonlyArray<Record<string, JsonValue>>;
  readonly activePhases?: ReadonlyArray<Record<string, JsonValue>>;
  readonly run?: Record<string, JsonValue>;
  readonly phases: ReadonlyArray<Record<string, JsonValue>>;
  readonly gates: ReadonlyArray<Record<string, JsonValue>>;
  readonly sandboxes: ReadonlyArray<Record<string, JsonValue>>;
}
