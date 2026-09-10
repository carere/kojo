import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { readIssues } from "../../../../.kojo/issues/readIssues.ts";
import * as InMemoryWorkspace from "../../../support/InMemoryIssueWorkspace.ts";

const issue = (number: number, repository = "example/project") => ({
  number,
  html_url: `https://github.com/${repository}/issues/${number}`,
  repository_url: `https://api.github.com/repos/${repository}`,
  title: `Issue ${number}`,
  body: "Specification",
});
const request = { repository: "example/project", issue: 10, branch: "pr-branch", base: "main" };
const response = (value: unknown) => ({ stdout: JSON.stringify(value) });

describe("read the authored issue request", () => {
  it.effect("reads paginated children and their blocked-by relationships", () =>
    Effect.gen(function* () {
      const plan = yield* readIssues(request).pipe(
        Effect.provide(
          InMemoryWorkspace.layer({
            "gh api repos/example/project/issues/10": response(issue(10)),
            "gh api --paginate --slurp repos/example/project/issues/10/sub_issues": response([
              [issue(1)],
              [issue(2)],
            ]),
            "gh api --paginate --slurp repos/example/project/issues/1/dependencies/blocked_by":
              response([[]]),
            "gh api --paginate --slurp repos/example/project/issues/2/dependencies/blocked_by":
              response([[issue(1)]]),
          }),
        ),
      );
      expect(plan.mode).toBe("graph");
      expect(plan.issues.map((item) => [item.number, item.blockedBy])).toEqual([
        [1, []],
        [2, [1]],
      ]);
      expect(plan.url).toBe("https://github.com/example/project/issues/10");
    }),
  );

  it.effect("refuses a same-number blocker in another repository", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        readIssues(request).pipe(
          Effect.provide(
            InMemoryWorkspace.layer({
              "gh api repos/example/project/issues/10": response(issue(10)),
              "gh api --paginate --slurp repos/example/project/issues/10/sub_issues": response([
                [],
              ]),
              "gh api --paginate --slurp repos/example/project/issues/10/dependencies/blocked_by":
                response([[issue(10, "example/elsewhere")]]),
            }),
          ),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(String(result.cause)).toContain("example/elsewhere/issues/10");
    }),
  );
});
