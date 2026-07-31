import { expect, it } from "vitest";
import {
  DEFAULT_PROJECT_RETENTION_POLICY,
  type DisposableRetentionCandidate,
  planDisposableCleanup,
} from "../../../../../../src/contexts/workflow-execution/retention/models/retention-policy";

const candidate = (
  key: string,
  bytes: number,
  finalizedAtMs: number | null,
  continuationRequired = false,
): DisposableRetentionCandidate => ({
  key,
  bytes,
  createdAtMs: finalizedAtMs ?? 0,
  finalizedAtMs,
  continuationRequired,
});

it("removes age-eligible content oldest first and then enforces size", () => {
  const plan = planDisposableCleanup(
    [candidate("old-large", 5, 0), candidate("old-small", 3, 1), candidate("recent", 4, 95)],
    { disposableMaxAgeMs: 10, disposableMaxBytes: 6 },
    100,
  );

  expect(plan.currentBytes).toBe(12);
  expect(plan.remove.map(({ key }) => key)).toEqual(["old-large", "old-small"]);
  expect(plan.protectedBytes).toBe(0);
});

it("orders age-only cleanup by finalization time", () => {
  const plan = planDisposableCleanup(
    [candidate("oldest", 1, 0), candidate("next", 1, 10), candidate("recent", 1, 91)],
    { disposableMaxAgeMs: 10, disposableMaxBytes: null },
    100,
  );

  expect(plan.remove.map(({ key }) => key)).toEqual(["oldest", "next"]);
});

it("orders size-only cleanup by oldest eligible content", () => {
  const plan = planDisposableCleanup(
    [candidate("oldest", 4, 0), candidate("next", 3, 1), candidate("newest", 2, 2)],
    { disposableMaxAgeMs: null, disposableMaxBytes: 4 },
    100,
  );

  expect(plan.remove.map(({ key }) => key)).toEqual(["oldest", "next"]);
});

it("uses size enforcement for a recent final candidate before its age limit", () => {
  const plan = planDisposableCleanup(
    [candidate("old", 1, 0), candidate("recent-final", 10, 95)],
    { disposableMaxAgeMs: 10, disposableMaxBytes: 6 },
    100,
  );

  expect(plan.remove.map(({ key }) => key)).toEqual(["old", "recent-final"]);
  expect(plan.protectedBytes).toBe(0);
});

it("keeps protected non-final and continuation content even when the limit is exceeded", () => {
  const plan = planDisposableCleanup(
    [candidate("running", 8, null), candidate("continued", 4, 0, true)],
    { disposableMaxAgeMs: 1, disposableMaxBytes: 1 },
    100,
  );

  expect(plan.remove).toEqual([]);
  expect(plan.protectedBytes).toBe(12);
  expect(plan.protectedOverLimit).toBe(true);
});

it("keeps a finality candidate protected while Agent continuation is required", () => {
  const plan = planDisposableCleanup(
    [candidate("continued-final", 8, 0, true), candidate("final", 2, 0)],
    { disposableMaxAgeMs: 1, disposableMaxBytes: 1 },
    100,
  );

  expect(plan.remove.map(({ key }) => key)).toEqual(["final"]);
  expect(plan.protectedBytes).toBe(8);
  expect(plan.protectedOverLimit).toBe(true);
});

it("uses the finality observed in one pass when content changes concurrently", () => {
  const plan = planDisposableCleanup(
    [candidate("final-at-scan", 3, 0), candidate("still-running-at-scan", 3, null)],
    { disposableMaxAgeMs: 1, disposableMaxBytes: 1 },
    100,
  );

  expect(plan.remove.map(({ key }) => key)).toEqual(["final-at-scan"]);
  expect(plan.protectedBytes).toBe(3);
});

it("does not remove content when both disposable limits are disabled", () => {
  const plan = planDisposableCleanup(
    [candidate("old", 10, 0)],
    { disposableMaxAgeMs: null, disposableMaxBytes: null },
    100,
  );

  expect(plan.remove).toEqual([]);
  expect(plan.protectedOverLimit).toBe(false);
});

it("is deterministic and idempotent after the first pass", () => {
  const content = [candidate("a", 4, 0), candidate("b", 2, 1)];
  const policy = { disposableMaxAgeMs: 1, disposableMaxBytes: 4 };
  const first = planDisposableCleanup(content, policy, 100);
  const second = planDisposableCleanup(
    content.filter((item) => !first.remove.some(({ key }) => key === item.key)),
    policy,
    100,
  );

  expect(first.remove.map(({ key }) => key)).toEqual(["a", "b"]);
  expect(second.remove).toEqual([]);
  expect(DEFAULT_PROJECT_RETENTION_POLICY.disposableMaxBytes).toBe(5 * 1024 ** 3);
});
