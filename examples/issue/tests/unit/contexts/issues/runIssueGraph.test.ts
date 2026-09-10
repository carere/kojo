import type { WorkItemProgress } from "@carere/kojo-runtime/contexts/trace/models/WorkItemProgress";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { runIssueGraph } from "../../../../.kojo/issues/runIssueGraph.ts";

const issue = (number: number, blockedBy: ReadonlyArray<number> = []) => ({
  number,
  title: `Issue ${number}`,
  body: "The issue specification",
  url: `https://github.com/example/project/issues/${number}`,
  blockedBy,
});

class InMemoryIssueDelivery {
  readonly starts: Array<{ number: number; revision: string }> = [];
  readonly merges: Array<number> = [];
  active = 0;
  maximum = 0;
  revision = "base";

  readonly implement = (item: ReturnType<typeof issue>, revision: string) =>
    Effect.gen({ self: this }, function* () {
      this.starts.push({ number: item.number, revision });
      this.active++;
      this.maximum = Math.max(this.maximum, this.active);
      yield* Effect.yieldNow;
      this.active--;
      return { issue: item.number, branch: `issue/${item.number}`, sha: `commit-${item.number}` };
    });

  readonly integrate = (result: { issue: number }) =>
    Effect.sync(() => {
      this.merges.push(result.issue);
      this.revision += `+${result.issue}`;
      return this.revision;
    });
}

describe("the authored issue graph", () => {
  it.effect("starts dependents from integrated blocker revisions within the capacity limit", () =>
    Effect.gen(function* () {
      const delivery = new InMemoryIssueDelivery();
      const progress: Array<WorkItemProgress> = [];
      const result = yield* runIssueGraph({
        issues: [issue(3, [1, 2]), issue(1), issue(2), issue(4)],
        mode: "graph",
        concurrency: 2,
        baseRevision: "base",
        delivery: {
          implement: delivery.implement,
          integrate: delivery.integrate,
          observe: (_name, items) => Effect.sync(() => void progress.push(...items)),
        },
      });
      expect(delivery.maximum).toBe(2);
      expect(delivery.starts).toEqual([
        { number: 1, revision: "base" },
        { number: 2, revision: "base" },
        { number: 3, revision: "base+1+2" },
        { number: 4, revision: "base+1+2" },
      ]);
      expect(delivery.merges).toEqual([1, 2, 3, 4]);
      expect(result.revision).toBe("base+1+2+3+4");
      expect(progress.find((item) => item.key === "3")).toMatchObject({
        state: "waiting",
        waitingFor: "dependencies",
        dependencies: ["1", "2"],
      });
      expect(progress.find((item) => item.key === "4")).toMatchObject({
        state: "waiting",
        waitingFor: "capacity",
      });
      expect(progress.filter((item) => item.key === "1").map((item) => item.state)).toEqual([
        "waiting",
        "executing",
        "accepted",
        "integrating",
        "integrated",
      ]);
      expect(
        progress.findIndex((item) => item.key === "3" && item.state === "executing"),
      ).toBeGreaterThan(
        progress.findIndex((item) => item.key === "2" && item.state === "integrated"),
      );
    }),
  );

  it.effect("keeps a single issue on its accepted commit without an integration merge", () =>
    Effect.gen(function* () {
      const delivery = new InMemoryIssueDelivery();
      const result = yield* runIssueGraph({
        issues: [issue(1)],
        mode: "single",
        concurrency: 2,
        baseRevision: "base",
        delivery,
      });
      expect(delivery.merges).toEqual([]);
      expect(result.revision).toBe("commit-1");
    }),
  );

  for (const [name, issues, concurrency] of [
    ["a cycle", [issue(1, [2]), issue(2, [1])], 2],
    ["an external blocker", [issue(1, [9])], 2],
    ["a duplicate issue", [issue(1), issue(1)], 2],
    ["invalid capacity", [issue(1)], 0],
  ] as const) {
    it.effect(`refuses ${name} before work starts`, () =>
      Effect.gen(function* () {
        const delivery = new InMemoryIssueDelivery();
        const result = yield* Effect.exit(
          runIssueGraph({
            issues,
            mode: "graph",
            concurrency,
            baseRevision: "base",
            delivery,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(delivery.starts).toEqual([]);
        expect(delivery.merges).toEqual([]);
      }),
    );
  }

  it.effect("does not start a dependent when integration fails", () =>
    Effect.gen(function* () {
      const delivery = new InMemoryIssueDelivery();
      const progress: Array<WorkItemProgress> = [];
      const result = yield* Effect.exit(
        runIssueGraph({
          issues: [issue(1), issue(2, [1])],
          mode: "graph",
          concurrency: 2,
          baseRevision: "base",
          delivery: {
            implement: delivery.implement,
            integrate: () => Effect.fail("merge conflict"),
            observe: (_name, items) => Effect.sync(() => void progress.push(...items)),
          },
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(delivery.starts.map((start) => start.number)).toEqual([1]);
      expect(progress.findLast((item) => item.key === "1")).toMatchObject({
        state: "failed",
        detail: expect.stringContaining("merge conflict"),
      });
      expect(progress.findLast((item) => item.key === "2")).toMatchObject({
        state: "waiting",
        waitingFor: "dependencies",
      });
    }),
  );
});
