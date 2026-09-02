import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

export interface TraceProjection {
  readonly phases: ReadonlyArray<Record<string, JsonValue>>;
  readonly gates: ReadonlyArray<Record<string, JsonValue>>;
  readonly sandboxes: ReadonlyArray<Record<string, JsonValue>>;
}
