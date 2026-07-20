import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Schema } from "effect";
import {
  DeliveryMetadata,
  DeliveryWorkstream,
  PreparedTarget,
  TrackerIssue,
} from "../../src/types/delivery";
import { VerificationCheckError, WorkflowError } from "../../src/types/errors";
import { implementAndReview } from "../../src/workflows/delivery/agents/implementation";
import {
  runMergeRepair,
  runVerificationSandbox,
} from "../../src/workflows/delivery/agents/verification";
import { integrateIssue } from "../../src/workflows/delivery/integration";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { reviewedIssueFixture } from "../helpers/delivery";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  (sandcastle.createSandbox as unknown as { mockRestore?: () => void }).mockRestore?.();
  (sandcastle.run as unknown as { mockRestore?: () => void }).mockRestore?.();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

const deliveryFixture = () => {
  const root = decodeIssue({
    number: 10,
    title: "Delivery: review proof",
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, title: "Issue 42", state: "OPEN" }],
  });
  const issue = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: root.title, state: "OPEN" },
    blockedBy: [],
    subIssues: [],
  });
  const workstream = new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision: "immutable-base",
      targetBranch: "feat/delivery",
    }),
    kind: "root",
    root,
    tickets: [issue],
  });
  const target = new PreparedTarget({
    baseSha: "immutable-base",
    branch: "feat/delivery",
    path: "/unused/target",
  });
  return { issue, target, workstream };
};

const createRepositoryWithPendingGraphChild = async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "sandcastle-review-proof-"));
  temporaryDirectories.push(rootPath);
  const remote = join(rootPath, "remote.git");
  const repository = join(rootPath, "repository");
  await runGit(rootPath, "init", "--bare", remote);
  await runGit(rootPath, "init", "--initial-branch=main", repository);
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "base.txt"), "base\n");
  await runGit(repository, "add", "base.txt");
  await runGit(repository, "commit", "-m", "test: base");
  const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "remote", "add", "origin", remote);
  await runGit(repository, "push", "-u", "origin", "main");
  await runGit(repository, "switch", "-c", "sandcastle/workstream-10/issue-42");
  await Bun.write(join(repository, "issue.txt"), "issue 42\n");
  await runGit(repository, "add", "issue.txt");
  await runGit(repository, "commit", "-m", "feat: issue 42");
  await runGit(repository, "switch", "-c", "feat/delivery", sourceRevision);
  await Bun.write(join(repository, "target.txt"), "target work\n");
  await runGit(repository, "add", "target.txt");
  await runGit(repository, "commit", "-m", "feat: target work");
  const expectedTargetHead = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "push", "-u", "origin", "feat/delivery");

  const graphRoot = decodeIssue({
    number: 10,
    title: "Delivery: review proof",
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [
      { number: 42, title: "Issue 42", state: "OPEN" },
      { number: 43, title: "Issue 43", state: "OPEN" },
    ],
  });
  const issue = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: graphRoot.title, state: "OPEN" },
    blockedBy: [],
    subIssues: [],
  });
  const pendingIssue = decodeIssue({
    number: 43,
    title: "Issue 43",
    body: "",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: graphRoot.title, state: "OPEN" },
    blockedBy: [{ number: 42, title: issue.title, state: "OPEN" }],
    subIssues: [],
  });
  const workstream = new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision,
      targetBranch: "feat/delivery",
    }),
    kind: "root",
    root: graphRoot,
    tickets: [issue, pendingIssue],
  });
  return { expectedTargetHead, issue, repository, sourceRevision, workstream };
};

const deliveryRepository = (rootPath: string): DeliveryRepository => ({
  defaultBranch: "main",
  githubName: "delimoov/delimoov",
  rootPath,
});

const createCleanRepairTarget = async () => {
  const repository = await mkdtemp(join(tmpdir(), "sandcastle-repair-review-"));
  temporaryDirectories.push(repository);
  await runGit(repository, "init", "--initial-branch=feat/delivery");
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "delivery.txt"), "before integration\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "test: target before integration");
  const fixedPoint = await runGit(repository, "rev-parse", "HEAD");
  await Bun.write(join(repository, "delivery.txt"), "repaired integration\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "fix: repair integration");
  return {
    fixedPoint,
    target: new PreparedTarget({
      baseSha: fixedPoint,
      branch: "feat/delivery",
      path: repository,
    }),
  };
};

const createVerificationRepository = async () => {
  const repository = await mkdtemp(join(tmpdir(), "sandcastle-verification-"));
  temporaryDirectories.push(repository);
  await runGit(repository, "init", "--initial-branch=main");
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "delivery.txt"), "requested target\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "test: requested verification target");
  const targetCommit = await runGit(repository, "rev-parse", "HEAD");
  await Bun.write(join(repository, "delivery.txt"), "stale verification branch\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "test: stale verification branch");
  const staleCommit = await runGit(repository, "rev-parse", "HEAD");
  return { repository, staleCommit, targetCommit };
};

describe("delivery review proof", () => {
  test("verifies the requested commit on a unique branch even when the old deterministic branch is stale", async () => {
    const { repository, staleCommit, targetCommit } = await createVerificationRepository();
    const { workstream } = deliveryFixture();
    const staleBranch = `sandcastle/verify-${workstream.root.number}-${targetCommit}`;
    await runGit(repository, "branch", staleBranch, staleCommit);
    const commands: Array<string> = [];
    let verificationBranch = "";
    spyOn(sandcastle, "createSandbox").mockImplementation(async (options) => {
      verificationBranch = options.branch;
      await runGit(repository, "branch", options.branch, targetCommit);
      return {
        branch: options.branch,
        close: async () => ({}),
        exec: async (command: string) => {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command === "git rev-parse HEAD" ? `${targetCommit}\n` : "",
          };
        },
        worktreePath: "/unused/verification",
      } as unknown as sandcastle.Sandbox;
    });

    await runEffect(
      runVerificationSandbox(repository, workstream, targetCommit).pipe(
        Effect.provide(BunServices.layer),
      ),
    );

    expect(verificationBranch).toStartWith(`${staleBranch}-`);
    expect(verificationBranch).not.toBe(staleBranch);
    expect(commands).toEqual([
      "git rev-parse HEAD",
      "moon run :test",
      "moon run :check",
      "moon run :tsc",
      'test -z "$(git status --porcelain)"',
    ]);
    expect(await runGit(repository, "rev-parse", staleBranch)).toBe(staleCommit);
    expect(await runGit(repository, "branch", "--list", verificationBranch)).toBe("");
  });

  test("classifies a nonzero verification command as a repairable check failure", async () => {
    const { repository, targetCommit } = await createVerificationRepository();
    const { workstream } = deliveryFixture();
    spyOn(sandcastle, "createSandbox").mockImplementation(async (options) => {
      await runGit(repository, "branch", options.branch, targetCommit);
      return {
        branch: options.branch,
        close: async () => ({}),
        exec: async (command: string) => ({
          exitCode: command === "moon run :test" ? 1 : 0,
          stderr: command === "moon run :test" ? "one test failed" : "",
          stdout: command === "git rev-parse HEAD" ? `${targetCommit}\n` : "",
        }),
        worktreePath: "/unused/verification",
      } as unknown as sandcastle.Sandbox;
    });

    const failure = await runEffect(
      runVerificationSandbox(repository, workstream, targetCommit).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );

    expect(failure).toBeInstanceOf(VerificationCheckError);
    expect(failure._tag).toBe("VerificationCheckError");
    expect(failure.message).toContain("tests failed: one test failed");
  });

  test("returns the immutable final commit approved by the reviewer", async () => {
    const { issue, target, workstream } = deliveryFixture();
    let agentRun = 0;
    let headRead = 0;
    const sandbox = {
      branch: "sandcastle/workstream-10/issue-42",
      close: async () => ({}),
      exec: async (command: string) => ({
        exitCode: 0,
        stderr: "",
        stdout: command.startsWith("git rev-list --count")
          ? "1\n"
          : command === "git rev-parse HEAD"
            ? `${headRead++ === 0 ? "implementation-commit" : "reviewed-final-commit"}\n`
            : "",
      }),
      run: async () => {
        agentRun += 1;
        return agentRun === 1
          ? {
              commits: [{ sha: "implementation-commit" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: "<promise>COMPLETE</promise>",
            }
          : {
              commits: [{ sha: "reviewed-final-commit" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: '<review>{"readyToMerge":true,"summary":"reviewed","findings":[]}</review>',
            };
      },
      worktreePath: "/unused/worker",
    };
    spyOn(sandcastle, "createSandbox").mockResolvedValue(sandbox as unknown as sandcastle.Sandbox);

    const result = await runEffect(
      implementAndReview("/unused/repository", target, workstream, issue),
    );

    expect(result.reviewedCommit).toBe("reviewed-final-commit");
    expect(result.specificationFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects an early positive review result when the reviewer does not complete", async () => {
    const { issue, target, workstream } = deliveryFixture();
    let agentRun = 0;
    const sandbox = {
      branch: "sandcastle/workstream-10/issue-42",
      close: async () => ({}),
      exec: async (command: string) => {
        const stdout = command.startsWith("git rev-list --count")
          ? "1\n"
          : command === "git rev-parse HEAD"
            ? "implementation\n"
            : "";
        return { exitCode: 0, stderr: "", stdout };
      },
      run: async () => {
        agentRun += 1;
        return agentRun === 1
          ? {
              commits: [{ sha: "implementation" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: "<promise>COMPLETE</promise>",
            }
          : {
              commits: [],
              completionSignal: undefined,
              iterations: [],
              stdout:
                '<review>{"readyToMerge":true,"summary":"early result","findings":[]}</review>',
            };
      },
      worktreePath: "/unused/worker",
    };
    spyOn(sandcastle, "createSandbox").mockResolvedValue(sandbox as unknown as sandcastle.Sandbox);

    const result = await runEffect(
      implementAndReview("/unused/repository", target, workstream, issue).pipe(Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("rejects a reviewer replacement commit that erases the implementation", async () => {
    const { issue, target, workstream } = deliveryFixture();
    let agentRun = 0;
    let headRead = 0;
    const sandbox = {
      branch: "sandcastle/workstream-10/issue-42",
      close: async () => ({}),
      exec: async (command: string) => {
        const isErasedImplementationCheck =
          command === "git merge-base --is-ancestor 'implementation' HEAD";
        const stdout = command.startsWith("git rev-list --count")
          ? "1\n"
          : command === "git rev-parse HEAD"
            ? `${headRead++ === 0 ? "implementation" : "replacement"}\n`
            : "";
        return {
          exitCode: isErasedImplementationCheck ? 1 : 0,
          stderr: isErasedImplementationCheck ? "not an ancestor" : "",
          stdout,
        };
      },
      run: async () => {
        agentRun += 1;
        return agentRun === 1
          ? {
              commits: [{ sha: "implementation" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: "<promise>COMPLETE</promise>",
            }
          : {
              commits: [{ sha: "replacement" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: '<review>{"readyToMerge":true,"summary":"reviewed","findings":[]}</review>',
            };
      },
      worktreePath: "/unused/worker",
    };
    spyOn(sandcastle, "createSandbox").mockResolvedValue(sandbox as unknown as sandcastle.Sandbox);

    const result = await runEffect(
      implementAndReview("/unused/repository", target, workstream, issue).pipe(Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("rejects an implementation branch that the reviewer resets to its immutable base", async () => {
    const { issue, target, workstream } = deliveryFixture();
    let agentRun = 0;
    let aheadCheck = 0;
    const sandbox = {
      branch: "sandcastle/workstream-10/issue-42",
      close: async () => ({}),
      exec: async (command: string) => {
        const stdout = command.startsWith("git rev-list --count")
          ? aheadCheck++ === 0
            ? "1\n"
            : "0\n"
          : command === "git rev-parse HEAD"
            ? "immutable-base\n"
            : "";
        return { exitCode: 0, stderr: "", stdout };
      },
      run: async () => {
        agentRun += 1;
        return agentRun === 1
          ? {
              commits: [{ sha: "implementation" }],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: "<promise>COMPLETE</promise>",
            }
          : {
              commits: [],
              completionSignal: "<promise>COMPLETE</promise>",
              iterations: [],
              stdout: '<review>{"readyToMerge":true,"summary":"reviewed","findings":[]}</review>',
            };
      },
      worktreePath: "/unused/worker",
    };
    spyOn(sandcastle, "createSandbox").mockResolvedValue(sandbox as unknown as sandcastle.Sandbox);

    const result = await runEffect(
      implementAndReview("/unused/repository", target, workstream, issue).pipe(Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(aheadCheck).toBe(2);
  });

  test("repairs and reverifies exactly once after a deterministic verification-check failure", async () => {
    const { expectedTargetHead, issue, repository, sourceRevision, workstream } =
      await createRepositoryWithPendingGraphChild();
    const issueBranch = "sandcastle/workstream-10/issue-42";
    let repairCalls = 0;
    let verificationAttempts = 0;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: () =>
        Effect.sync(() => {
          repairCalls += 1;
        }),
      verify: () => {
        verificationAttempts += 1;
        return verificationAttempts === 1
          ? new VerificationCheckError({
              command: "moon run :test",
              message: "tests failed: one test failed",
              output: "one test failed",
            })
          : Effect.void;
      },
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          issueBranch,
          await runGit(repository, "rev-parse", issueBranch),
        ),
        expectedTargetHead,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(result).toMatch(/^[0-9a-f]{40}$/);
    expect(repairCalls).toBe(1);
    expect(verificationAttempts).toBe(2);
  });

  test("does not invoke code repair when verification sandbox creation fails", async () => {
    const { expectedTargetHead, issue, repository, sourceRevision, workstream } =
      await createRepositoryWithPendingGraphChild();
    const issueBranch = "sandcastle/workstream-10/issue-42";
    let repairCalls = 0;
    spyOn(sandcastle, "createSandbox").mockRejectedValue(
      new Error("verification container unavailable"),
    );
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: () =>
        Effect.sync(() => {
          repairCalls += 1;
        }),
      verify: runVerificationSandbox,
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          issueBranch,
          await runGit(repository, "rev-parse", issueBranch),
        ),
        expectedTargetHead,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(repairCalls).toBe(0);
  });

  test("does not invoke code repair or checks when verification opens the wrong commit", async () => {
    const { expectedTargetHead, issue, repository, sourceRevision, workstream } =
      await createRepositoryWithPendingGraphChild();
    const issueBranch = "sandcastle/workstream-10/issue-42";
    const commands: Array<string> = [];
    let repairCalls = 0;
    spyOn(sandcastle, "createSandbox").mockImplementation(async (options) => {
      await runGit(repository, "branch", options.branch, options.baseBranch ?? "HEAD");
      return {
        branch: options.branch,
        close: async () => ({}),
        exec: async (command: string) => {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command === "git rev-parse HEAD" ? `${sourceRevision}\n` : "",
          };
        },
        worktreePath: "/unused/verification",
      } as unknown as sandcastle.Sandbox;
    });
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: () =>
        Effect.sync(() => {
          repairCalls += 1;
        }),
      verify: runVerificationSandbox,
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          issueBranch,
          await runGit(repository, "rev-parse", issueBranch),
        ),
        expectedTargetHead,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(repairCalls).toBe(0);
    expect(commands).toEqual(["git rev-parse HEAD"]);
  });

  test("does not invoke code repair when verification cleanup fails after a check failure", async () => {
    const { expectedTargetHead, issue, repository, sourceRevision, workstream } =
      await createRepositoryWithPendingGraphChild();
    const issueBranch = "sandcastle/workstream-10/issue-42";
    let repairCalls = 0;
    spyOn(sandcastle, "createSandbox").mockImplementation(
      async (options) =>
        ({
          branch: options.branch,
          close: async () => ({}),
          exec: async (command: string) => ({
            exitCode: command === "moon run :test" ? 1 : 0,
            stderr: command === "moon run :test" ? "one test failed" : "",
            stdout: command === "git rev-parse HEAD" ? `${options.baseBranch}\n` : "",
          }),
          worktreePath: "/unused/verification",
        }) as unknown as sandcastle.Sandbox,
    );
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: () =>
        Effect.sync(() => {
          repairCalls += 1;
        }),
      verify: runVerificationSandbox,
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          issueBranch,
          await runGit(repository, "rev-parse", issueBranch),
        ),
        expectedTargetHead,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(repairCalls).toBe(0);
  });

  test("rejects a non-final child whose issue tip is not a secondary merge parent", async () => {
    const { expectedTargetHead, issue, repository, sourceRevision, workstream } =
      await createRepositoryWithPendingGraphChild();
    const issueBranch = "sandcastle/workstream-10/issue-42";
    let verificationAttempt = 0;
    let issueCompleted = false;
    let repairBaseSha: string | undefined;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueCompleted = true;
        }),
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: (repairTarget) => {
        repairBaseSha = repairTarget.baseSha;
        return Effect.promise(async () => {
          await runGit(repository, "reset", "--hard", issueBranch);
          await runGit(repository, "merge", "--no-ff", "--no-edit", expectedTargetHead);
        });
      },
      verify: () => {
        verificationAttempt += 1;
        return verificationAttempt === 1
          ? new VerificationCheckError({
              command: "moon run :test",
              message: "tests failed: verification failed",
              output: "verification failed",
            })
          : Effect.void;
      },
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          issueBranch,
          await runGit(repository, "rev-parse", issueBranch),
        ),
        expectedTargetHead,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    const remoteTarget = await runGit(
      repository,
      "ls-remote",
      "origin",
      "refs/heads/feat/delivery",
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(issueCompleted).toBe(false);
    expect(repairBaseSha).toBe(expectedTargetHead);
    expect(remoteTarget.split(/\s+/)[0]).toBe(expectedTargetHead);
  });

  test("independently reviews an integration repair from the pre-integration target head", async () => {
    const { issue, workstream } = deliveryFixture();
    const { fixedPoint, target } = await createCleanRepairTarget();
    const calls: Array<sandcastle.RunOptions> = [];
    const fakeRun = async (options: sandcastle.RunOptions): Promise<sandcastle.RunResult> => {
      calls.push(options);
      return {
        branch: target.branch,
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        iterations: [],
        stdout:
          calls.length === 1
            ? "<promise>COMPLETE</promise>"
            : '<review>{"readyToMerge":true,"summary":"repair reviewed","findings":[]}</review><promise>COMPLETE</promise>',
      };
    };
    spyOn(sandcastle, "run").mockImplementation(fakeRun as unknown as typeof sandcastle.run);

    await runEffect(
      runMergeRepair(
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          "sandcastle/workstream-10/issue-42",
          "0000000000000000000000000000000000000000",
        ),
        "failed-checks",
        "tests failed",
      ).pipe(Effect.provide(BunServices.layer)),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.promptFile).toEndWith("/review.md");
    expect(calls[1]?.promptArgs?.BASE_SHA).toBe(fixedPoint);
  });

  test("rejects an integration repair when its independent reviewer does not complete", async () => {
    const { issue, workstream } = deliveryFixture();
    const { target } = await createCleanRepairTarget();
    let callCount = 0;
    const fakeRun = async (): Promise<sandcastle.RunResult> => {
      callCount += 1;
      return {
        branch: target.branch,
        commits: [],
        completionSignal: callCount === 1 ? "<promise>COMPLETE</promise>" : undefined,
        iterations: [],
        stdout:
          callCount === 1
            ? "<promise>COMPLETE</promise>"
            : '<review>{"readyToMerge":true,"summary":"reviewed","findings":[]}</review>',
      };
    };
    spyOn(sandcastle, "run").mockImplementation(fakeRun as unknown as typeof sandcastle.run);

    const result = await runEffect(
      runMergeRepair(
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          "sandcastle/workstream-10/issue-42",
          "0000000000000000000000000000000000000000",
        ),
        "failed-checks",
        "tests failed",
      ).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("rejects an integration repair that its independent reviewer finds unsafe", async () => {
    const { issue, workstream } = deliveryFixture();
    const { target } = await createCleanRepairTarget();
    let callCount = 0;
    const fakeRun = async (): Promise<sandcastle.RunResult> => {
      callCount += 1;
      return {
        branch: target.branch,
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        iterations: [],
        stdout:
          callCount === 1
            ? "<promise>COMPLETE</promise>"
            : '<review>{"readyToMerge":false,"summary":"repair is unsafe","findings":["regression"]}</review><promise>COMPLETE</promise>',
      };
    };
    spyOn(sandcastle, "run").mockImplementation(fakeRun as unknown as typeof sandcastle.run);

    const result = await runEffect(
      runMergeRepair(
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          issue,
          "sandcastle/workstream-10/issue-42",
          "0000000000000000000000000000000000000000",
        ),
        "failed-checks",
        "tests failed",
      ).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });
});
