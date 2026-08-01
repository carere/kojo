import { type DeletionScope, ProjectIdentity, RequestKey } from "@kojo/control";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  DELETION_PLAN_TTL_MS,
  deletionPlanMatches,
  deletionScopeDigest,
  isDeletionPlanExpired,
  makeDeletionPlan,
} from "../../../../../../src/contexts/workflow-execution/deletion/models/deletion-plan";

const identity = Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000040");
const planKey = Schema.decodeUnknownSync(RequestKey)("plan-40");
const expiryPlanKey = Schema.decodeUnknownSync(RequestKey)("plan-40-expiry");
const changedIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
  "00000000-0000-7000-8000-000000000041",
);

const target = (scope: DeletionScope) => ({
  scope,
  items: [
    { kind: "provider" as const, key: "provider:run-2", runId: "run-2" },
    { kind: "run" as const, key: "run:run-2", runId: "run-2" },
  ],
  preconditions: [
    { key: "run:run-2", value: "1:completed:2:" },
    { key: "schedule:z", value: "1:0:unavailable:10" },
  ],
});

it("uses a versioned, order-independent digest and deterministic plan items", () => {
  const first = {
    kind: "occurrences",
    identity,
    beforeMs: 2_000,
    scheduleKeys: ["z", "a"],
  } satisfies Extract<DeletionScope, { kind: "occurrences" }>;
  const second: DeletionScope = { ...first, scheduleKeys: ["a", "z"] };
  expect(deletionScopeDigest(first)).toBe(deletionScopeDigest(second));

  const plan = makeDeletionPlan(target(first), 10_000, planKey);
  expect(plan.target.version).toBe(1);
  expect(plan.target.scope).toMatchObject({ scheduleKeys: ["a", "z"] });
  expect(plan.target.items.map((item) => item.key)).toEqual(["provider:run-2", "run:run-2"]);
  expect(plan.expiresAtMs).toBe(10_000 + DELETION_PLAN_TTL_MS);
});

it("expires exactly at fifteen minutes and rejects scope drift", () => {
  const scope: DeletionScope = { kind: "project", identity };
  const plan = makeDeletionPlan(target(scope), 50_000, expiryPlanKey);

  expect(isDeletionPlanExpired(plan, 50_000 + DELETION_PLAN_TTL_MS - 1)).toBe(false);
  expect(isDeletionPlanExpired(plan, 50_000 + DELETION_PLAN_TTL_MS)).toBe(true);
  expect(deletionPlanMatches(plan, scope, 50_000 + 1)).toBe(true);
  expect(
    deletionPlanMatches(plan, { kind: "project", identity: changedIdentity }, 50_000 + 1),
  ).toBe(false);
});
