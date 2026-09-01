import type { Effect } from "effect";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";
import type { PurgeSafetyEvidence } from "../models/Purge.ts";

export interface PurgeSafetyRepository {
  readonly seal: (
    operationId: string,
    owner: LifecycleRecordedOwner,
    issuedAt: string,
    expiresAt: string,
  ) => Effect.Effect<PurgeSafetyEvidence, LifecycleError>;
}
