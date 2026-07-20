import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Schema } from "effect";
import { TestConsole } from "effect/testing";
import {
  DeliveryMetadata,
  DeliveryOptions,
  DeliveryWorkstream,
  PreparedTarget,
  TrackerIssue,
} from "../../src/types/delivery";
import { VerificationCheckError, WorkflowError } from "../../src/types/errors";
import { processWorkstreams } from "../../src/workflows/delivery/index";
import {
  finalizeCompletedWorkstream,
  integrateIssue,
} from "../../src/workflows/delivery/integration";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { addDeliveryEvidenceToHead, reviewedIssueFixture } from "../helpers/delivery";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const deliveryRepository = (rootPath: string): DeliveryRepository => ({
  defaultBranch: "main",
  githubName: "delimoov/delimoov",
  rootPath,
});

const createRepositoryWithIssueBranch = async (integrateLocally = true) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-delivery-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  await runGit(root, "init", "--bare", remote);
  await runGit(root, "init", "--initial-branch=main", repository);
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "delivery.txt"), "base\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "test: base");
  const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "remote", "add", "origin", remote);
  await runGit(repository, "push", "-u", "origin", "main");
  await runGit(repository, "switch", "-c", "feat/delivery");
  await runGit(repository, "push", "-u", "origin", "feat/delivery");
  await runGit(repository, "switch", "-c", "sandcastle/workstream-10/issue-42");
  await Bun.write(join(repository, "delivery.txt"), "base\nissue 42\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "feat: issue 42");
  await runGit(repository, "switch", "feat/delivery");
  if (integrateLocally) {
    await runGit(repository, "merge", "--no-ff", "--no-edit", "sandcastle/workstream-10/issue-42");
  }
  return { remote, repository, sourceRevision };
};

const createRepositoryWithTargetBranches = async (branches: ReadonlyArray<string>) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-delivery-concurrency-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  await runGit(root, "init", "--bare", remote);
  await runGit(root, "init", "--initial-branch=main", repository);
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "delivery.txt"), "base\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "test: base");
  const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "remote", "add", "origin", remote);
  await runGit(repository, "push", "-u", "origin", "main");
  for (const [index, branch] of branches.entries()) {
    await runGit(repository, "branch", branch, sourceRevision);
    await runGit(repository, "push", "-u", "origin", branch);
    await runGit(repository, "worktree", "add", join(root, `target-${index}`), branch);
  }
  return { repository, sourceRevision };
};

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

const deliveryFixture = (sourceRevision: string) => {
  const root = decodeIssue({
    number: 10,
    title: "Delivery: lifecycle",
    body: `## Delivery\n\n- Target branch: \`feat/delivery\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, title: "Issue 42", state: "OPEN" }],
  });
  const openTicket = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "<!-- delivery-ticket-key: #10::01 -->",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: root.title, state: "OPEN" },
    blockedBy: [],
    subIssues: [],
  });
  const delivery = new DeliveryMetadata({
    destinationBranch: "main",
    sourceRevision,
    targetBranch: "feat/delivery",
  });
  const makeWorkstream = (ticket: TrackerIssue) =>
    new DeliveryWorkstream({ delivery, kind: "root", root, tickets: [ticket] });
  return { makeWorkstream, openTicket };
};

const standaloneFixture = (
  number: number,
  targetBranch: string,
  sourceRevision: string,
  destinationBranch = "main",
) => {
  const issue = decodeIssue({
    number,
    title: `Standalone ${number}`,
    body: `## Delivery\n\n- Target branch: \`${targetBranch}\`\n- Destination branch: \`${destinationBranch}\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [],
  });
  return new DeliveryWorkstream({
    delivery: new DeliveryMetadata({ destinationBranch, sourceRevision, targetBranch }),
    kind: "standalone",
    root: issue,
    tickets: [issue],
  });
};

describe("delivery scheduling", () => {
  test("rejects a non-default destination before starting an agent", async () => {
    const { repository, sourceRevision } = await createRepositoryWithTargetBranches([
      "feat/non-default",
      "release",
    ]);
    const workstream = standaloneFixture(1, "feat/non-default", sourceRevision, "release");
    let agentStarted = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: () => {
        agentStarted = true;
        return unexpectedAgent();
      },
      plan: (_, current) => Effect.succeed([String(current.root.number)]),
      repair: unexpectedAgent,
      verify: unexpectedAgent,
    });
    const repositoryContext = deliveryRepository(repository);

    await runEffect(
      processWorkstreams(
        repositoryContext,
        [workstream],
        new DeliveryOptions({ concurrency: 1, maxIterations: 1 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(agentStarted).toBe(false);
  });

  test("runs separate workstreams concurrently under one global agent limit", async () => {
    const targets = ["feat/one", "feat/two", "feat/three"];
    const { repository, sourceRevision } = await createRepositoryWithTargetBranches(targets);
    const workstreams = targets.map((target, index) =>
      standaloneFixture(index + 1, target, sourceRevision),
    );
    const byRoot = new Map(workstreams.map((workstream) => [workstream.root.number, workstream]));
    let activeAgents = 0;
    let maximumActiveAgents = 0;
    let startedAgents = 0;
    const firstTwoStarted = Promise.withResolvers<void>();
    const releaseAgents = Promise.withResolvers<void>();
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: (_, rootNumber) => {
        const workstream = byRoot.get(rootNumber);
        return workstream
          ? Effect.succeed(workstream)
          : new WorkflowError({ message: `missing workstream #${rootNumber}`, operation: "test" });
      },
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            startedAgents += 1;
            activeAgents += 1;
            maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
            if (startedAgents === 2) firstTwoStarted.resolve();
          }),
          () =>
            Effect.promise(() => releaseAgents.promise).pipe(
              Effect.andThen(
                Effect.fail(
                  new WorkflowError({ message: "expected worker stop", operation: "test" }),
                ),
              ),
            ),
          () =>
            Effect.sync(() => {
              activeAgents -= 1;
            }),
        ),
      plan: (_, workstream) => Effect.succeed([String(workstream.root.number)]),
      repair: unexpectedAgent,
      verify: unexpectedAgent,
    });

    const running = runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        workstreams,
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );
    await firstTwoStarted.promise;
    const startedBeforeRelease = startedAgents;
    releaseAgents.resolve();
    const result = await running;

    expect(Exit.isFailure(result)).toBe(true);
    expect(startedBeforeRelease).toBe(2);
    expect(maximumActiveAgents).toBe(2);
    expect(startedAgents).toBe(3);
  });
});

describe("delivery lifecycle recovery", () => {
  test("does not complete an issue until its recovered merge reaches the remote target", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    await addDeliveryEvidenceToHead(
      repository,
      makeWorkstream(openTicket),
      openTicket,
      "sandcastle/workstream-10/issue-42",
    );
    let issueCompleted = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueCompleted = true;
        }),
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(makeWorkstream(openTicket)),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });
    await runGit(repository, "remote", "set-url", "origin", join(repository, "missing.git"));

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        [makeWorkstream(openTicket)],
        new DeliveryOptions({ concurrency: 1, maxIterations: 2 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(issueCompleted).toBe(false);
  });

  test("finishes integrated child bookkeeping when a managed pull request already exists", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    await addDeliveryEvidenceToHead(
      repository,
      makeWorkstream(openTicket),
      openTicket,
      "sandcastle/workstream-10/issue-42",
    );
    await Bun.write(join(repository, "post-merge-repair.txt"), "verified repair\n");
    await runGit(repository, "add", "post-merge-repair.txt");
    await runGit(repository, "commit", "-m", "fix: repair integrated delivery");
    await runGit(repository, "push", "origin", "HEAD:refs/heads/feat/delivery");
    let currentTicket = openTicket;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          currentTicket = new TrackerIssue({
            ...openTicket,
            state: "CLOSED",
            stateReason: "COMPLETED",
          });
        }),
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(makeWorkstream(currentTicket)),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });

    await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        [makeWorkstream(openTicket)],
        new DeliveryOptions({ concurrency: 1, maxIterations: 2 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(currentTicket.state).toBe("CLOSED");
    expect(currentTicket.stateReason).toBe("COMPLETED");
  });

  test("refuses publication when failed-check repair discards the reviewed issue", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch(false);
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    const workstream = makeWorkstream(openTicket);
    let issueCompleted = false;
    let verificationAttempt = 0;
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
      repair: () =>
        Effect.promise(() => runGit(repository, "reset", "--hard", sourceRevision)).pipe(
          Effect.asVoid,
        ),
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
          openTicket,
          "sandcastle/workstream-10/issue-42",
          await runGit(repository, "rev-parse", "sandcastle/workstream-10/issue-42"),
        ),
        sourceRevision,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(issueCompleted).toBe(false);
  });

  test("does not finalize a workstream containing a child closed as not planned", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    const notPlannedTicket = new TrackerIssue({
      ...openTicket,
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
    });
    const workstream = makeWorkstream(notPlannedTicket);
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
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

    const result = await runEffect(
      finalizeCompletedWorkstream(deliveryRepository(repository), target, workstream).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });

  test("does not create a root-closing pull request while another child lacks completion evidence", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    const notPlannedTicket = decodeIssue({
      ...openTicket,
      number: 43,
      title: "Issue 43",
      body: "<!-- delivery-ticket-key: #10::02 -->",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
    });
    const workstream = new DeliveryWorkstream({
      ...makeWorkstream(openTicket),
      tickets: [openTicket, notPlannedTicket],
    });
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
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
    const targetCommit = await runGit(repository, "rev-parse", "HEAD");

    const result = await runEffect(
      integrateIssue(
        deliveryRepository(repository),
        target,
        workstream,
        reviewedIssueFixture(
          workstream,
          openTicket,
          "sandcastle/workstream-10/issue-42",
          await runGit(repository, "rev-parse", "sandcastle/workstream-10/issue-42"),
        ),
        targetCommit,
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });

  test("does not finalize when a completed child branch is absent from the target", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    const integratedTicket = new TrackerIssue({
      ...openTicket,
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    const missingTicket = decodeIssue({
      ...openTicket,
      number: 43,
      title: "Issue 43",
      body: "<!-- delivery-ticket-key: #10::02 -->",
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    const baseWorkstream = makeWorkstream(integratedTicket);
    await addDeliveryEvidenceToHead(
      repository,
      baseWorkstream,
      integratedTicket,
      "sandcastle/workstream-10/issue-42",
    );
    const workstream = new DeliveryWorkstream({
      ...baseWorkstream,
      tickets: [integratedTicket, missingTicket],
    });
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
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

    const result = await runEffect(
      finalizeCompletedWorkstream(deliveryRepository(repository), target, workstream).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });

  test("does not publish a target commit created after verification starts", async () => {
    const { repository, sourceRevision } = await createRepositoryWithIssueBranch();
    const { makeWorkstream, openTicket } = deliveryFixture(sourceRevision);
    const completedTicket = new TrackerIssue({
      ...openTicket,
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    const workstream = makeWorkstream(completedTicket);
    await addDeliveryEvidenceToHead(
      repository,
      workstream,
      completedTicket,
      "sandcastle/workstream-10/issue-42",
    );
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () =>
        Effect.promise(async () => {
          await Bun.write(join(repository, "unverified.txt"), "not verified\n");
          await runGit(repository, "add", "unverified.txt");
          await runGit(repository, "commit", "-m", "test: unverified target movement");
        }),
    });
    const target = new PreparedTarget({
      baseSha: sourceRevision,
      branch: "feat/delivery",
      path: repository,
    });

    const result = await runEffect(
      finalizeCompletedWorkstream(deliveryRepository(repository), target, workstream).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });
});
