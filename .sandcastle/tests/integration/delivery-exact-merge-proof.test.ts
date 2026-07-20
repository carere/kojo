import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Schema } from "effect";
import {
  DeliveryMetadata,
  DeliveryWorkstream,
  PreparedTarget,
  TrackerIssue,
} from "../../src/types/delivery";
import { VerificationCheckError, WorkflowError } from "../../src/types/errors";
import {
  finalizeCompletedWorkstream,
  integrateIssue,
  recoverIntegratedIssue,
} from "../../src/workflows/delivery/integration";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { reviewedIssueFixture } from "../helpers/delivery";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

describe("delivery exact merge proof", () => {
  test("does not recover or finalize an issue merged as a later octopus parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-historical-merge-"));
    temporaryDirectories.push(root);
    const remote = join(root, "remote.git");
    const repository = join(root, "repository");
    await runGit(root, "init", "--bare", remote);
    await runGit(root, "init", "--initial-branch=main", repository);
    await runGit(repository, "config", "user.email", "sandcastle@example.test");
    await runGit(repository, "config", "user.name", "Sandcastle Test");
    await Bun.write(join(repository, "base.txt"), "base\n");
    await runGit(repository, "add", "base.txt");
    await runGit(repository, "commit", "-m", "test: base");
    const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "remote", "add", "origin", remote);
    await runGit(repository, "push", "-u", "origin", "main");

    const issueBranch = "sandcastle/workstream-10/issue-42";
    await runGit(repository, "switch", "-c", issueBranch);
    await Bun.write(join(repository, "issue.txt"), "issue\n");
    await runGit(repository, "add", "issue.txt");
    await runGit(repository, "commit", "-m", "feat: issue");

    await runGit(repository, "switch", "-c", "test/unrelated", sourceRevision);
    await Bun.write(join(repository, "unrelated.txt"), "unrelated\n");
    await runGit(repository, "add", "unrelated.txt");
    await runGit(repository, "commit", "-m", "test: unrelated");

    await runGit(repository, "switch", "-c", "feat/delivery", sourceRevision);
    await runGit(repository, "merge", "--no-ff", "--no-edit", "test/unrelated", issueBranch);

    const rootIssue = decodeIssue({
      number: 10,
      title: "Delivery: historical merge proof",
      body: "",
      state: "OPEN",
      labels: [],
      assignees: [],
      comments: [],
      parent: null,
      blockedBy: [],
      subIssues: [{ number: 42, state: "OPEN" }],
    });
    const openIssue = decodeIssue({
      number: 42,
      title: "Issue 42",
      body: "",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      assignees: [],
      comments: [],
      parent: { number: 10, state: "OPEN" },
      blockedBy: [],
      subIssues: [],
    });
    const openWorkstream = new DeliveryWorkstream({
      delivery: new DeliveryMetadata({
        destinationBranch: "main",
        sourceRevision,
        targetBranch: "feat/delivery",
      }),
      kind: "root",
      root: rootIssue,
      tickets: [openIssue],
    });
    const completedIssue = new TrackerIssue({
      ...openIssue,
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    const completedWorkstream = new DeliveryWorkstream({
      ...openWorkstream,
      tickets: [completedIssue],
    });
    const deliveryRepository: DeliveryRepository = {
      defaultBranch: "main",
      githubName: "delimoov/delimoov",
      rootPath: repository,
    };
    let issueClosed = false;
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueClosed = true;
        }),
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(openWorkstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const recovered = await runEffect(
      recoverIntegratedIssue(deliveryRepository, target, openWorkstream, openIssue).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
      ),
    );
    const finalized = await runEffect(
      finalizeCompletedWorkstream(deliveryRepository, target, completedWorkstream).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(recovered).toBe(false);
    expect(Exit.isFailure(finalized)).toBe(true);
    expect(issueClosed).toBe(false);
    expect(pullRequestCreated).toBe(false);
  });

  test("rejects an octopus merge that only includes the issue as a later parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-exact-merge-"));
    temporaryDirectories.push(root);
    const remote = join(root, "remote.git");
    const repository = join(root, "repository");
    await runGit(root, "init", "--bare", remote);
    await runGit(root, "init", "--initial-branch=main", repository);
    await runGit(repository, "config", "user.email", "sandcastle@example.test");
    await runGit(repository, "config", "user.name", "Sandcastle Test");
    await Bun.write(join(repository, "base.txt"), "base\n");
    await runGit(repository, "add", "base.txt");
    await runGit(repository, "commit", "-m", "test: base");
    const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "remote", "add", "origin", remote);
    await runGit(repository, "push", "-u", "origin", "main");

    const issueBranch = "sandcastle/workstream-10/issue-42";
    await runGit(repository, "switch", "-c", issueBranch);
    await Bun.write(join(repository, "issue.txt"), "issue\n");
    await runGit(repository, "add", "issue.txt");
    await runGit(repository, "commit", "-m", "feat: issue");

    await runGit(repository, "switch", "-c", "test/unrelated", sourceRevision);
    await Bun.write(join(repository, "unrelated.txt"), "unrelated\n");
    await runGit(repository, "add", "unrelated.txt");
    await runGit(repository, "commit", "-m", "test: unrelated");

    await runGit(repository, "switch", "-c", "feat/delivery", sourceRevision);
    await Bun.write(join(repository, "target.txt"), "target\n");
    await runGit(repository, "add", "target.txt");
    await runGit(repository, "commit", "-m", "feat: target");
    const expectedTargetHead = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "push", "-u", "origin", "feat/delivery");

    const graphRoot = decodeIssue({
      number: 10,
      title: "Delivery: exact merge proof",
      body: "",
      state: "OPEN",
      labels: [],
      assignees: [],
      comments: [],
      parent: null,
      blockedBy: [],
      subIssues: [
        { number: 42, state: "OPEN" },
        { number: 43, state: "OPEN" },
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
      parent: { number: 10, state: "OPEN" },
      blockedBy: [],
      subIssues: [],
    });
    const pending = decodeIssue({
      number: 43,
      title: "Issue 43",
      body: "",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      assignees: [],
      comments: [],
      parent: { number: 10, state: "OPEN" },
      blockedBy: [{ number: 42, state: "OPEN" }],
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
      tickets: [issue, pending],
    });
    const deliveryRepository: DeliveryRepository = {
      defaultBranch: "main",
      githubName: "delimoov/delimoov",
      rootPath: repository,
    };
    let verificationAttempt = 0;
    let issueClosed = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueClosed = true;
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
      repair: () =>
        Effect.promise(async () => {
          await runGit(repository, "reset", "--hard", expectedTargetHead);
          await runGit(repository, "merge", "--no-ff", "--no-edit", "test/unrelated", issueBranch);
        }),
      verify: () => {
        verificationAttempt += 1;
        return verificationAttempt === 1
          ? new VerificationCheckError({
              command: "moon run :check",
              message: "checks failed: checks failed",
              output: "checks failed",
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
        deliveryRepository,
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
    expect(issueClosed).toBe(false);
    expect(
      (await runGit(repository, "ls-remote", "origin", "refs/heads/feat/delivery")).split(/\s+/)[0],
    ).toBe(expectedTargetHead);
  });
});
