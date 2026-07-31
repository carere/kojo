import type {
  ProjectRetentionPolicy,
  ProjectRetentionSetInput,
  ProjectRetentionSnapshot,
  ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import { Context, type Effect } from "effect";

export type RetentionRepositoryMutation =
  | {
      readonly _tag: "success";
      readonly snapshot: ProjectRetentionSnapshot;
      readonly alreadyApplied: boolean;
    }
  | { readonly _tag: "request-key-conflict" };

export interface RetentionRepositoryShape {
  readonly policy: (project: ProjectSnapshot) => Effect.Effect<ProjectRetentionPolicy>;
  readonly show: (
    project: ProjectSnapshot,
    observedAtMs?: number,
  ) => Effect.Effect<ProjectRetentionSnapshot>;
  readonly set: (
    project: ProjectSnapshot,
    input: ProjectRetentionSetInput,
  ) => Effect.Effect<RetentionRepositoryMutation>;
  readonly reset: (
    project: ProjectSnapshot,
    requestKey: RequestKey,
  ) => Effect.Effect<RetentionRepositoryMutation>;
  readonly cleanup: (
    project: ProjectSnapshot,
    nowMs?: number,
  ) => Effect.Effect<ProjectRetentionSnapshot>;
}

export class RetentionRepository extends Context.Service<
  RetentionRepository,
  RetentionRepositoryShape
>()("kojo/host/RetentionRepository") {}
