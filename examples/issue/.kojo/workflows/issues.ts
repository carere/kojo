import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  layer as agents,
  codex,
} from "@carere/kojo-runtime/contexts/agent/adapters/SandcastleAgentInvoker";
import { docker } from "@carere/kojo-runtime/contexts/sandbox/adapters/providers";
import { Workspace } from "@carere/kojo-runtime/contexts/sandbox/ports/Workspace";
import { ArtifactPublisher } from "@carere/kojo-runtime/contexts/trace/ports/ArtifactPublisher";
import { withPermissions } from "@carere/kojo-runtime/contexts/workflow/guards/Permissions";
import { Acceptance, Judgement } from "@carere/kojo-runtime/contexts/workflow/models/Acceptance";
import { EnvelopeBase } from "@carere/kojo-runtime/contexts/workflow/models/Envelope";
import { factoryOwnPaths } from "@carere/kojo-runtime/contexts/workflow/models/PermissionPolicy";
import { CurrentRun } from "@carere/kojo-runtime/contexts/workflow/services/CurrentRun";
import { agent } from "@carere/kojo-runtime/contexts/workflow/services/phase/agent";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { commit } from "@carere/kojo-runtime/contexts/workflow/services/phase/commit";
import { merge } from "@carere/kojo-runtime/contexts/workflow/services/phase/merge";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";
import { Effect, Schema } from "effect";
import { IssuePlan, IssueRequest, readIssues } from "../issues/readIssues.ts";
import { reviewIssue } from "../issues/reviewIssue.ts";
import { runIssueGraph } from "../issues/runIssueGraph.ts";

// Project policy. Edit these commands and the two agent calls for another Project.
const concurrency = 2;
const repairs = 2;
const checks = ["bun tsc --noEmit", "bun biome check .", "moon run zaidan:build"];
const startUi = "moon run zaidan:dev -- --host 0.0.0.0 --port 4173";
const uiUrl = "http://127.0.0.1:4173";

class Failed extends Schema.TaggedError<Failed>()("IssueWorkflowFailed", {
  message: Schema.String,
}) {}
const failure = (cause: unknown) => new Failed({ message: String(cause) });
class Implemented extends EnvelopeBase.extend<Implemented>("Implemented")({
  _tag: Schema.tag("Implemented"),
  summary: Schema.String,
  message: Schema.String,
}) {}
class Reviewed extends EnvelopeBase.extend<Reviewed>("Reviewed")({
  _tag: Schema.tag("Reviewed"),
  passed: Schema.Boolean,
  details: Schema.String,
}) {}
const Finding = Schema.Struct({ passed: Schema.Boolean, details: Schema.String });
const command = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const result = yield* workspace.exec(argv);
    if (!result.succeeded)
      return yield* new Failed({
        message: `${argv[0]} failed (${result.exitCode}): ${result.stderr.slice(-16_384)}`,
      });
    return result.stdout;
  });
const record = <S extends Schema.Top, E, R>(
  name: string,
  description: string,
  success: S,
  body: Effect.Effect<S["Type"], E, R>,
) => code({ name, description, success, error: Failed }, body.pipe(Effect.mapError(failure)));
const suite = (name: string) =>
  record(
    name,
    "Check the complete change",
    Finding,
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const results = yield* Effect.forEach(checks, (check) => workspace.exec(["sh", "-c", check]));
      return {
        passed: results.every((result) => result.succeeded),
        details: results
          .map(
            (result, index) =>
              `${checks[index]}: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
          )
          .join("\n")
          .slice(-32_768),
      };
    }),
  );
const accepted = () =>
  new Acceptance({
    mechanical: new Judgement({ by: "checks", accepted: true, reason: "Project checks passed" }),
    review: new Judgement({
      by: "ui-reviewer",
      accepted: true,
      reason: "Independent UI review passed",
    }),
  });

/** @public Discovered as a Project Workflow by its file path. */
export const issues = workflow(
  {
    name: "issues",
    payload: IssueRequest,
    success: Schema.String,
    error: Failed,
    idempotencyKey: (request) =>
      `${request.repository}/${request.issue}/${request.branch}/${request.base}`,
    assets: [
      new URL("../sandbox/Dockerfile", import.meta.url),
      new URL("../sandbox/ui-process.py", import.meta.url),
      new URL("../sandbox/skills/implement/SKILL.md", import.meta.url),
      new URL("../sandbox/skills/tdd/SKILL.md", import.meta.url),
      new URL("../sandbox/skills/tdd/tests.md", import.meta.url),
      new URL("../sandbox/skills/tdd/mocking.md", import.meta.url),
      new URL("../sandbox/skills/code-review/SKILL.md", import.meta.url),
    ],
  },
  (request) =>
    Effect.gen(function* () {
      const run = yield* CurrentRun;
      const plan = yield* record(
        "request",
        "Read the issue and its dependency graph",
        IssuePlan,
        readIssues(request),
      );
      const imageName = `kojo-issue:${run.runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
      const auth = join(homedir(), ".codex", "auth.json");
      const prepared = yield* record(
        "prepare",
        "Check prerequisites and build the Docker image",
        Schema.String,
        Effect.gen(function* () {
          if (!existsSync(auth))
            return yield* new Failed({
              message: "Run codex login on this Host before starting the issue Workflow.",
            });
          yield* command(["docker", "info"]);
          yield* command(["gh", "auth", "status"]);
          const repository = (yield* command([
            "gh",
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
          ])).trim();
          if (repository.toLowerCase() !== request.repository.toLowerCase())
            return yield* new Failed({
              message: "The selected GitHub repository does not match this Project's origin.",
            });
          for (const branch of [request.branch, request.base]) {
            const checked = (yield* command([
              "git",
              "check-ref-format",
              "--branch",
              branch,
            ])).trim();
            if (checked !== branch)
              return yield* new Failed({ message: "Select literal local branch names." });
          }
          if (request.branch === request.base)
            return yield* new Failed({
              message: "Select a PR branch different from its base branch.",
            });
          const workspace = yield* Workspace;
          const branches = [
            request.branch,
            ...(plan.mode === "graph"
              ? plan.issues.map((issue) => `${request.branch}-issue-${issue.number}`)
              : []),
          ];
          for (const branch of branches) {
            if ((yield* workspace.git(["show-ref", "--verify", `refs/heads/${branch}`])).succeeded)
              return yield* new Failed({
                message: `Select new branches. ${branch} already exists.`,
              });
          }
          const revision = (yield* command([
            "git",
            "rev-parse",
            `refs/heads/${request.base}^{commit}`,
          ])).trim();
          const dockerfile = fileURLToPath(new URL("../sandbox/Dockerfile", import.meta.url));
          yield* command([
            "docker",
            "build",
            "--build-arg",
            `AGENT_UID=${process.getuid?.() ?? 1000}`,
            "--build-arg",
            `AGENT_GID=${process.getgid?.() ?? 1000}`,
            "-t",
            imageName,
            "-f",
            dockerfile,
            dirname(dockerfile),
          ]);
          return revision;
        }),
      );
      const provider = () =>
        docker({
          imageName,
          mounts: [{ hostPath: auth, sandboxPath: "/home/agent/.codex/auth.json", readonly: true }],
        });
      const target = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
        sandboxed(
          { name, branch: request.branch, baseBranch: prepared, provider: provider() },
          body,
        );

      const completed = yield* runIssueGraph({
        issues: plan.issues,
        mode: plan.mode,
        concurrency,
        baseRevision: prepared,
        delivery: {
          implement: (item, revision) => {
            const issue = item;
            const branch =
              plan.mode === "single" ? request.branch : `${request.branch}-issue-${issue.number}`;
            return sandboxed(
              { name: `issue-${issue.number}`, branch, baseBranch: revision, provider: provider() },
              Effect.gen(function* () {
                yield* record(
                  `source-${issue.number}`,
                  "Verify the integrated source revision",
                  Schema.String,
                  Effect.gen(function* () {
                    const head = (yield* command(["git", "rev-parse", "HEAD"])).trim();
                    if (head !== revision)
                      return yield* new Failed({
                        message: `Issue #${issue.number} requires source ${revision}, but ${branch} is at ${head}.`,
                      });
                    return head;
                  }),
                );
                yield* record(
                  `install-${issue.number}`,
                  "Install Project dependencies",
                  Schema.String,
                  command(["bun", "install", "--frozen-lockfile"]),
                );
                let message = `feat: implement issue #${issue.number}`;
                const acceptedIssue = yield* reviewIssue({
                  issue: issue.number,
                  branch,
                  repairs,
                  delivery: {
                    implement: (round, reason) =>
                      withPermissions(
                        {
                          agent: "implementer",
                          writes: { _tag: "Unrestricted" },
                          protectedPaths: factoryOwnPaths,
                          alwaysWritable: [],
                        },
                        agent({
                          name: `implement-${issue.number}-${round}`,
                          description: `Implement or repair issue #${issue.number}`,
                          agent: "implementer",
                          provider: codex,
                          model: "gpt-5.4",
                          system: readFileSync(
                            new URL("../prompts/implement/system.md", import.meta.url),
                            "utf8",
                          ),
                          prompt: `${readFileSync(new URL("../prompts/implement/user.md", import.meta.url), "utf8")}\n${JSON.stringify({ issue, baseRevision: revision, reason })}`,
                          envelope: Implemented,
                          corrections: 1,
                        }),
                      ).pipe(
                        Effect.map((answer) => {
                          message = answer.value.message;
                          return undefined;
                        }),
                        Effect.mapError(failure),
                      ),
                    check: (round) => suite(`checks-${issue.number}-${round}`),
                    review: (round) =>
                      Effect.gen(function* () {
                        yield* record(
                          `start-ui-${issue.number}-${round}`,
                          "Start the application for UI review",
                          Schema.String,
                          command([
                            "python3",
                            "/usr/local/lib/kojo-ui-process.py",
                            "start",
                            startUi,
                            uiUrl,
                          ]),
                        );
                        const reviewed = yield* withPermissions(
                          {
                            agent: "ui-reviewer",
                            writes: { _tag: "LimitedTo", patterns: [] },
                            protectedPaths: factoryOwnPaths,
                            alwaysWritable: [],
                          },
                          agent({
                            name: `review-${issue.number}-${round}`,
                            description: `Review the running UI for issue #${issue.number}`,
                            agent: "ui-reviewer",
                            provider: codex,
                            model: "gpt-5.4",
                            system: readFileSync(
                              new URL("../prompts/review/system.md", import.meta.url),
                              "utf8",
                            ),
                            prompt: `${readFileSync(new URL("../prompts/review/user.md", import.meta.url), "utf8")}\n${JSON.stringify({ issue, url: uiUrl })}`,
                            envelope: Reviewed,
                            corrections: 1,
                          }),
                        );
                        return reviewed.value;
                      }).pipe(
                        Effect.catch((cause) =>
                          Effect.succeed({ passed: false, details: String(cause) }),
                        ),
                        // Interruption closes the containing sandbox. Between rounds, require
                        // successful cleanup before either acceptance or another repair.
                        Effect.tap(() =>
                          command([
                            "python3",
                            "/usr/local/lib/kojo-ui-process.py",
                            "stop",
                            uiUrl,
                          ]).pipe(Effect.mapError(failure)),
                        ),
                      ),
                    commit: () =>
                      Effect.gen(function* () {
                        const committed = yield* commit({
                          name: `commit-${issue.number}`,
                          description: `Commit accepted issue #${issue.number}`,
                          branch,
                          message,
                        });
                        return committed.sha;
                      }).pipe(Effect.mapError(failure)),
                  },
                });
                yield* record(
                  `diff-${issue.number}`,
                  "Retain the accepted change",
                  Schema.String,
                  Effect.gen(function* () {
                    const publisher = yield* ArtifactPublisher;
                    const diff = yield* command([
                      "git",
                      "show",
                      "--format=",
                      "--binary",
                      acceptedIssue.sha,
                    ]);
                    const artifact = yield* publisher.publishText({
                      name: `issue-${issue.number}.diff`,
                      mediaType: "text/x-diff",
                      content:
                        diff.length <= 1_000_000
                          ? diff
                          : `${diff.slice(0, 1_000_000)}\n[Diff truncated; inspect commit ${acceptedIssue.sha} for the complete change.]\n`,
                    });
                    return artifact.artifactId;
                  }),
                );
                return acceptedIssue;
              }).pipe(Effect.provide(agents)),
            ).pipe(Effect.mapError(failure));
          },
          integrate: (result) =>
            target(
              `integrate-${result.issue}`,
              merge({
                name: `merge-${result.issue}`,
                branch: result.branch,
                into: request.branch,
                acceptance: accepted(),
                message: `feat: integrate issue #${result.issue}`,
              }),
            ).pipe(
              Effect.map((landing) => landing.sha),
              Effect.mapError(failure),
            ),
        },
      });

      yield* target(
        "delivery",
        Effect.gen(function* () {
          yield* record(
            "install-integration",
            "Install combined Project dependencies",
            Schema.String,
            command(["bun", "install", "--frozen-lockfile"]),
          );
          const checked = yield* suite("integration-checks");
          if (!checked.passed)
            return yield* new Failed({
              message: `Integration checks failed. ${request.branch} is preserved.\n${checked.details}`,
            });
          yield* record(
            "checked-revision",
            "Verify the exact commit for delivery",
            Schema.String,
            Effect.gen(function* () {
              const head = (yield* command(["git", "rev-parse", "HEAD"])).trim();
              const dirty = (yield* command(["git", "status", "--porcelain"])).trim();
              if (head !== completed.revision || dirty !== "")
                return yield* new Failed({
                  message: `The checked source changed on ${request.branch}. Preserve and inspect this branch before delivery.\n${dirty}`,
                });
              return head;
            }),
          );
        }),
      );
      yield* record(
        "push",
        "Push the accepted PR branch",
        Schema.String,
        command(["git", "push", "origin", `${completed.revision}:refs/heads/${request.branch}`]),
      );
      return yield* record(
        "pull-request",
        "Open the PR for repository review",
        Schema.String,
        command([
          "gh",
          "pr",
          "create",
          "--repo",
          request.repository,
          "--base",
          request.base,
          "--head",
          request.branch,
          "--title",
          `feat: ${plan.title}`,
          "--body",
          `Implements ${plan.url}.\n\nProject checks and independent UI review passed.\n\nRun: ${run.runId}`,
        ]),
      );
    }).pipe(Effect.mapError(failure)),
);
