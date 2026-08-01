import { createHash, randomUUID } from "node:crypto";
import {
  type DeletionPlanCounts,
  DeletionPlanCounts as DeletionPlanCountsSchema,
  type DeletionPlanItem,
  type DeletionScope,
  DeletionScope as DeletionScopeSchema,
  RequestKey,
} from "@kojo/control";
import { Schema } from "effect";

export const DELETION_PLAN_VERSION = 1 as const;
export const DELETION_PLAN_TTL_MS = 15 * 60 * 1_000;

export type DeletionWorkKind =
  | "run"
  | "occurrence"
  | "schedule"
  | "engine"
  | "owned-file"
  | "provider";

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const DeletionWorkItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("run"),
    key: Schema.String,
    runId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("occurrence"),
    key: Schema.String,
    scheduleKey: Schema.String,
    scheduledAtMs: Schema.Number,
    scheduleRevision: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    key: Schema.String,
    scheduleKey: Schema.String,
    scheduledAtMs: Schema.optionalKey(Schema.Number),
    scheduleRevision: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("engine"),
    key: Schema.String,
    runId: Schema.String,
    workflowKey: Schema.String,
    workflowRevision: Schema.String,
    engineGeneration: PositiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal("owned-file"),
    key: Schema.String,
    relativePath: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider"),
    key: Schema.String,
    runId: Schema.String,
    providerCleanup: Schema.optionalKey(Schema.Literals(["supported", "unsupported"])),
  }),
]);
export type DeletionWorkItem = typeof DeletionWorkItemSchema.Type;

export interface DeletionTargetSnapshot {
  readonly version: typeof DELETION_PLAN_VERSION;
  readonly scope: DeletionScope;
  readonly scopeDigest: string;
  readonly items: ReadonlyArray<DeletionWorkItem>;
  readonly counts: typeof DeletionPlanCounts.Type;
  readonly preconditions: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
  }>;
}

export const DeletionTargetSnapshotSchema = Schema.Struct({
  version: Schema.Literal(DELETION_PLAN_VERSION),
  scope: DeletionScopeSchema,
  scopeDigest: Schema.String,
  items: Schema.Array(DeletionWorkItemSchema),
  counts: DeletionPlanCountsSchema,
  preconditions: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
});

export interface DeletionPlanRecord {
  readonly planKey: RequestKey;
  readonly target: DeletionTargetSnapshot;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}

/** JSON canonicalization for scope digests and request fingerprints. */
export const stableJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Deletion scope is not JSON encodable");
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

export const canonicalScope = (scope: DeletionScope): DeletionScope =>
  scope.kind === "occurrences" ? { ...scope, scheduleKeys: [...scope.scheduleKeys].sort() } : scope;

export const deletionScopeDigest = (scope: DeletionScope) =>
  createHash("sha256")
    .update(stableJson(canonicalScope(scope)))
    .digest("hex");

export const newDeletionPlanKey = (): RequestKey =>
  Schema.decodeUnknownSync(RequestKey)(randomUUID());

export const publicPlanItems = (
  items: ReadonlyArray<DeletionWorkItem>,
): ReadonlyArray<typeof DeletionPlanItem.Type> => items.map(({ kind, key }) => ({ kind, key }));

export const countsFor = (
  items: ReadonlyArray<DeletionWorkItem>,
): typeof DeletionPlanCounts.Type => ({
  runs: items.filter((item) => item.kind === "run").length,
  occurrences: items.filter((item) => item.kind === "occurrence").length,
  schedules: items.filter((item) => item.kind === "schedule").length,
  engine: items.filter((item) => item.kind === "engine").length,
  ownedFiles: items.filter((item) => item.kind === "owned-file").length,
  providers: items.filter((item) => item.kind === "provider").length,
});

export const makeDeletionPlan = (
  target: Omit<DeletionTargetSnapshot, "version" | "scopeDigest" | "counts"> & {
    readonly scope: DeletionScope;
  },
  observedAtMs: number,
  planKey: RequestKey = newDeletionPlanKey(),
): DeletionPlanRecord => {
  const items = [...target.items].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind === 0 ? left.key.localeCompare(right.key) : kind;
  });
  const snapshot: DeletionTargetSnapshot = {
    version: DELETION_PLAN_VERSION,
    scope: canonicalScope(target.scope),
    scopeDigest: deletionScopeDigest(target.scope),
    items,
    counts: countsFor(items),
    preconditions: [...target.preconditions].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
  };
  return {
    planKey,
    target: snapshot,
    observedAtMs,
    expiresAtMs: observedAtMs + DELETION_PLAN_TTL_MS,
  };
};

export const isDeletionPlanExpired = (plan: DeletionPlanRecord, nowMs: number) =>
  nowMs >= plan.expiresAtMs;

export const deletionPlanMatches = (
  plan: DeletionPlanRecord,
  scope: DeletionScope,
  nowMs: number,
) =>
  !isDeletionPlanExpired(plan, nowMs) &&
  plan.target.scopeDigest === deletionScopeDigest(scope) &&
  stableJson(plan.target.scope) === stableJson(canonicalScope(scope));
