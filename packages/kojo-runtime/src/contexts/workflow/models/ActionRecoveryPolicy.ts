import { Context } from "effect";

export type ActionRecoveryPolicy =
  | "recover-result"
  | "prove-not-performed"
  | "safe-repetition"
  | "unresolved";

/** Retained adapter contract for one authored Activity. Arbitrary effects default to unresolved. */
export const ActionRecoveryPolicy = Context.Reference<ActionRecoveryPolicy | undefined>(
  "kojo-runtime/workflow/ActionRecoveryPolicy",
  { defaultValue: () => undefined },
);
