import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as InMemoryWorkspace from "../../../../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import { runChecks } from "../../../../../src/contexts/workflow/guards/Check.ts";
import { artifactsExist } from "../../../../../src/contexts/workflow/guards/checks/artifactsExist.ts";
import { diffMatchesClaims } from "../../../../../src/contexts/workflow/guards/checks/diffMatchesClaims.ts";

/** What an agent claims it left behind. Two fields, because the two shipped checks read one each. */
interface Built {
  readonly artifacts: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
}

const wrote = artifactsExist<Built>({ claim: "artifacts", paths: (built) => built.artifacts });

const listed = diffMatchesClaims<Built>({
  claim: "changedFiles",
  files: (built) => built.changedFiles,
});

/** The two git commands the change-set fingerprint is built from, and nothing else. */
const tree = (options: { readonly numstat: string; readonly untracked: string }) => ({
  "git diff HEAD --numstat": { stdout: options.numstat },
  "git ls-files --others --exclude-standard": { stdout: options.untracked },
});

const clean = tree({ numstat: "", untracked: "" });

const oneOfEach = tree({ numstat: "3\t1\tsrc/parser.ts", untracked: "docs/notes.md" });

describe("artifactsExist", () => {
  it.effect("holds when every claimed path is really in the workspace", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([wrote], {
        artifacts: ["reports/scout.md"],
        changedFiles: [],
      });

      expect(report.held).toBe(true);
      expect(report.results.map((result) => result.check)).toEqual(["artifactsExist"]);
    }).pipe(Effect.provide(InMemoryWorkspace.layer({ "reports/scout.md": "# what I found" }))),
  );

  it.effect("names the field and the index of every path that is not there", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([wrote], {
        artifacts: ["reports/scout.md", "reports/plan.md"],
        changedFiles: [],
      });

      expect(report.held).toBe(false);
      // The index is what sends the agent to the entry it invented, rather than to the field.
      expect(report.failed[0]?.faults.map((fault) => fault.claim.join("."))).toEqual([
        "artifacts.1",
      ]);
      expect(report.failed[0]?.faults[0]?.subject).toBe("reports/plan.md");
    }).pipe(Effect.provide(InMemoryWorkspace.layer({ "reports/scout.md": "# what I found" }))),
  );
});

describe("diffMatchesClaims", () => {
  it.effect("holds when the claim is exactly the change-set", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([listed], {
        artifacts: [],
        changedFiles: ["src/parser.ts", "docs/notes.md"],
      });

      expect(report.held).toBe(true);
    }).pipe(Effect.provide(InMemoryWorkspace.layer({}, { commands: oneOfEach }))),
  );

  it.effect("refuses work the agent reported and did not do", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([listed], {
        artifacts: [],
        changedFiles: ["src/parser.ts"],
      });

      expect(report.failed[0]?.faults).toHaveLength(1);
      expect(report.failed[0]?.faults[0]).toMatchObject({
        claim: ["changedFiles", "0"],
        subject: "src/parser.ts",
      });
    }).pipe(Effect.provide(InMemoryWorkspace.layer({}, { commands: clean }))),
  );

  it.effect("refuses work the agent did and did not report", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([listed], { artifacts: [], changedFiles: [] });

      // A permitted change the envelope hides is what makes a human approve a diff they have not
      // read, so it fails the same way a change that never happened does.
      expect(report.failed[0]?.faults.map((fault) => fault.subject)).toEqual([
        "docs/notes.md",
        "src/parser.ts",
      ]);
    }).pipe(Effect.provide(InMemoryWorkspace.layer({}, { commands: oneOfEach }))),
  );

  it.effect("fails rather than reporting a clean tree it could not read", () =>
    Effect.gen(function* () {
      const outcome = yield* runChecks([listed], { artifacts: [], changedFiles: [] }).pipe(
        Effect.result,
      );

      // The whole failure mode a verification layer must not have: an empty answer from a failed
      // `git diff` reads exactly like "nothing changed".
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("WorkspaceError");
    }).pipe(
      Effect.provide(
        InMemoryWorkspace.layer(
          {},
          {
            commands: {
              "git diff HEAD --numstat": { exitCode: 128, stderr: "not a git repository" },
              "git ls-files --others --exclude-standard": { stdout: "" },
            },
          },
        ),
      ),
    ),
  );
});

describe("a report over several checks", () => {
  it.effect("runs every check, never up to the first failure", () =>
    Effect.gen(function* () {
      const report = yield* runChecks([wrote, listed], {
        artifacts: ["reports/plan.md"],
        changedFiles: ["src/parser.ts"],
      });

      // One fault per correction turn spends one agent call per fault, and the loop is bounded.
      expect(report.results).toHaveLength(2);
      expect(report.failed.map((result) => result.check)).toEqual([
        "artifactsExist",
        "diffMatchesClaims",
      ]);
    }).pipe(Effect.provide(InMemoryWorkspace.layer({}, { commands: clean }))),
  );
});
