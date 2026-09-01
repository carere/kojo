import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { DaemonRun } from "../../workflow/models/DaemonRun.ts";

export interface TriggerDeliveryRequest {
  readonly projectId: string;
  readonly workflowName: string;
  readonly source: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly deliveredAt: string;
}

export interface TriggerAdmission {
  readonly run: DaemonRun;
  readonly duplicate: boolean;
  readonly acknowledgement: "durable";
}

export interface TriggerDeliveryObservation {
  readonly projectId: string;
  readonly workflowName: string;
  readonly source: string;
  readonly eventId: string;
  readonly state: "acknowledged" | "rejected";
  readonly runId?: string;
  readonly reason?: string;
  readonly observedAt: string;
}
