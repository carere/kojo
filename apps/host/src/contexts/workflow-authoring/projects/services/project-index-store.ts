import { ProjectMutationResult, ProjectSnapshot, RequestKey } from "@kojo/control";
import { Context, type Effect, Schema } from "effect";

export const ProjectRequestReceipt = Schema.Struct({
  requestKey: RequestKey,
  operation: Schema.Literals(["register", "forget"]),
  fingerprint: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/, { expected: "a SHA-256 request fingerprint" }),
  ),
  selectorLookupKey: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{64}$/, { expected: "a SHA-256 selector lookup key" }),
    ),
  ),
  result: ProjectMutationResult,
});
export type ProjectRequestReceipt = typeof ProjectRequestReceipt.Type;

export const ProjectIndexState = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  projects: Schema.Array(ProjectSnapshot),
  receipts: Schema.Array(ProjectRequestReceipt),
});
export type ProjectIndexState = typeof ProjectIndexState.Type;

export interface ProjectIndexUpdate<A> {
  readonly state: ProjectIndexState;
  readonly result: A;
}

export interface ProjectIndexStoreShape {
  readonly read: Effect.Effect<ProjectIndexState>;
  readonly update: <A>(
    change: (state: ProjectIndexState) => Effect.Effect<ProjectIndexUpdate<A>>,
  ) => Effect.Effect<A>;
}

export class ProjectIndexStore extends Context.Service<ProjectIndexStore, ProjectIndexStoreShape>()(
  "kojo/host/ProjectIndexStore",
) {}

export const emptyProjectIndexState = (): ProjectIndexState => ({
  layoutVersion: 1,
  projects: [],
  receipts: [],
});

export const successfulMutation = (
  requestKey: RequestKey,
  project: ProjectSnapshot,
  alreadyApplied: boolean,
): ProjectMutationResult => ({ ok: true, requestKey, project, alreadyApplied });
