import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

/** The recovery promise declared by the adapter that performs an external action. */
export type ExternalActionRecoveryPolicy =
  | "recover-result"
  | "prove-not-performed"
  | "safe-repetition"
  | "unresolved";

export type ExternalActionState =
  | "intended"
  | "unresolved"
  | "retry-authorized"
  | "result-confirmed"
  | "not-performed"
  | "repetition-safe";

export interface ExternalActionIntent {
  readonly actionId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly phasePath: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly recoveryPolicy: ExternalActionRecoveryPolicy;
  readonly state: ExternalActionState;
  readonly uncertaintyRevision: number;
  readonly intendedAt: string;
  readonly updatedAt: string;
  readonly evidence?: {
    readonly kind: "original-result" | "not-performed" | "safe-repetition" | "unresolved";
    readonly detail: string;
    readonly observedAt: string;
    readonly result?: JsonValue;
  };
  readonly retryAuthorization?: {
    readonly reason: string;
    readonly possibleDuplicationAcknowledged: true;
    readonly uncertaintyRevision: number;
    readonly authorizedAt: string;
    readonly consumedAt?: string;
  };
}

export type ExternalActionDecision =
  | { readonly kind: "perform"; readonly action: ExternalActionIntent }
  | {
      readonly kind: "reuse-result";
      readonly action: ExternalActionIntent;
      readonly result: JsonValue;
    }
  | { readonly kind: "hold"; readonly action: ExternalActionIntent };

export type ExternalActionEvidence =
  | { readonly kind: "original-result"; readonly detail: string; readonly result: JsonValue }
  | { readonly kind: "not-performed"; readonly detail: string }
  | { readonly kind: "safe-repetition"; readonly detail: string }
  | { readonly kind: "unresolved"; readonly detail: string };

export interface AuthorizeUncertainRetryRequest {
  readonly dataIdentity: string;
  readonly requestId: string;
  readonly canonicalRequest: string;
  readonly runId: string;
  readonly actionId: string;
  readonly reason: string;
  readonly possibleDuplicationAcknowledged: true;
  readonly authorizedAt: string;
  readonly mutation?: MutationEnvelope;
}
