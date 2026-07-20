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
  TrackerIssue,
} from "../../src/types/delivery";
import { WorkflowError } from "../../src/types/errors";
import { processWorkstreams } from "../../src/workflows/delivery/index";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { addDeliveryEvidenceToHead } from "../helpers/delivery";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-completion-safety-"));
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
  return { repository, sourceRevision };
};

const deliveryRepository = (rootPath: string): DeliveryRepository => ({
  defaultBranch: "main",
  githubName: "delimoov/delimoov",
  rootPath,
});

const graphFixture = (sourceRevision: string) => {
  const root = decodeIssue({
    number: 10,
    title: "Delivery: completion safety",
    body: `## Delivery\n\n- Target branch: \`feat/delivery\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, title: "Issue 42", state: "OPEN" }],
  });
  const ticket = decodeIssue({
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
  return new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision,
      targetBranch: "feat/delivery",
    }),
    kind: "root",
    root,
    tickets: [ticket],
  });
};

const standaloneFixture = (sourceRevision: string) => {
  const issue = decodeIssue({
    number: 42,
    title: "Standalone completion safety",
    body: `## Delivery\n\n- Target branch: \`feat/delivery\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [],
  });
  return new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision,
      targetBranch: "feat/delivery",
    }),
    kind: "standalone",
    root: issue,
    tickets: [issue],
  });
};

describe("delivery completion safety", () => {
  test("does not recover a base-only issue branch as completed", async () => {
    const { repository, sourceRevision } = await createRepository();
    const workstream = graphFixture(sourceRevision);
    await runGit(repository, "branch", "sandcastle/workstream-10/issue-42", sourceRevision);
    let implementationStarted = false;
    let issueCompleted = false;
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueCompleted = true;
        }),
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
      implementAndReview: () => {
        implementationStarted = true;
        return new WorkflowError({
          message: "stop after proving implementation",
          operation: "test",
        });
      },
      plan: () => Effect.succeed(["42"]),
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
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

    expect(Exit.isFailure(result)).toBe(true);
    expect(implementationStarted).toBe(true);
    expect(issueCompleted).toBe(false);
    expect(pullRequestCreated).toBe(false);
  });

  test("does not finalize a closed ticket backed only by a base-only branch", async () => {
    const { repository, sourceRevision } = await createRepository();
    const initialWorkstream = graphFixture(sourceRevision);
    const completedTicket = new TrackerIssue({
      ...initialWorkstream.tickets[0],
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    const completedWorkstream = new DeliveryWorkstream({
      ...initialWorkstream,
      tickets: [completedTicket],
    });
    await runGit(repository, "branch", "sandcastle/workstream-10/issue-42", sourceRevision);
    await Bun.write(join(repository, "unrelated.txt"), "unrelated target change\n");
    await runGit(repository, "add", "unrelated.txt");
    await runGit(repository, "commit", "-m", "test: unrelated target change");
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () =>
        Effect.sync(() => {
          pullRequestCreated = true;
          return "https://example.test/pull/1";
        }),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(completedWorkstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        [completedWorkstream],
        new DeliveryOptions({ concurrency: 1, maxIterations: 1 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });

  test("does not create a root-closing pull request before the final child closes", async () => {
    const { repository, sourceRevision } = await createRepository();
    const workstream = graphFixture(sourceRevision);
    await runGit(repository, "switch", "-c", "sandcastle/workstream-10/issue-42");
    await Bun.write(join(repository, "delivery.txt"), "base\nissue 42\n");
    await runGit(repository, "add", "delivery.txt");
    await runGit(repository, "commit", "-m", "feat: issue 42");
    await runGit(repository, "switch", "feat/delivery");
    await runGit(repository, "merge", "--no-ff", "--no-edit", "sandcastle/workstream-10/issue-42");
    await addDeliveryEvidenceToHead(
      repository,
      workstream,
      workstream.tickets[0],
      "sandcastle/workstream-10/issue-42",
    );
    let issueClosureAttempted = false;
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => {
        issueClosureAttempted = true;
        return new WorkflowError({ message: "GitHub rejected issue closure", operation: "test" });
      },
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

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
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

    expect(Exit.isFailure(result)).toBe(true);
    expect(issueClosureAttempted).toBe(true);
    expect(pullRequestCreated).toBe(false);
  });

  test("creates the root-closing pull request on rerun after child closure succeeded", async () => {
    const { repository, sourceRevision } = await createRepository();
    const initialWorkstream = graphFixture(sourceRevision);
    await runGit(repository, "switch", "-c", "sandcastle/workstream-10/issue-42");
    await Bun.write(join(repository, "delivery.txt"), "base\nissue 42\n");
    await runGit(repository, "add", "delivery.txt");
    await runGit(repository, "commit", "-m", "feat: issue 42");
    await runGit(repository, "switch", "feat/delivery");
    await runGit(repository, "merge", "--no-ff", "--no-edit", "sandcastle/workstream-10/issue-42");
    await addDeliveryEvidenceToHead(
      repository,
      initialWorkstream,
      initialWorkstream.tickets[0],
      "sandcastle/workstream-10/issue-42",
    );
    let currentWorkstream = initialWorkstream;
    let pullRequestAttempts = 0;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          const completedTicket = new TrackerIssue({
            ...initialWorkstream.tickets[0],
            state: "CLOSED",
            stateReason: "COMPLETED",
          });
          currentWorkstream = new DeliveryWorkstream({
            ...initialWorkstream,
            tickets: [completedTicket],
          });
        }),
      ensurePullRequest: () => {
        pullRequestAttempts += 1;
        return pullRequestAttempts === 1
          ? new WorkflowError({ message: "GitHub rejected PR creation", operation: "test" })
          : Effect.succeed("https://example.test/pull/1");
      },
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(currentWorkstream),
    });
    const unexpectedAgent = () =>
      new WorkflowError({ message: "unexpected agent execution", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });
    const runWorkflow = () =>
      runEffect(
        processWorkstreams(
          deliveryRepository(repository),
          [initialWorkstream],
          new DeliveryOptions({ concurrency: 1, maxIterations: 1 }),
        ).pipe(
          Effect.provideService(DeliveryTracker, tracker),
          Effect.provideService(DeliveryAgents, agents),
          Effect.provide(TestConsole.layer),
          Effect.provide(BunServices.layer),
          Effect.exit,
        ),
      );

    const firstRun = await runWorkflow();
    const secondRun = await runWorkflow();

    expect(Exit.isFailure(firstRun)).toBe(true);
    expect(currentWorkstream.tickets[0]?.state).toBe("CLOSED");
    expect(Exit.isSuccess(secondRun)).toBe(true);
    expect(pullRequestAttempts).toBe(2);
  });

  test("leaves a standalone issue open for its pull request to close", async () => {
    const { repository, sourceRevision } = await createRepository();
    const workstream = standaloneFixture(sourceRevision);
    await runGit(repository, "switch", "-c", "sandcastle/workstream-42/issue-42");
    await Bun.write(join(repository, "delivery.txt"), "base\nstandalone 42\n");
    await runGit(repository, "add", "delivery.txt");
    await runGit(repository, "commit", "-m", "feat: standalone issue 42");
    await runGit(repository, "switch", "feat/delivery");
    await runGit(repository, "merge", "--no-ff", "--no-edit", "sandcastle/workstream-42/issue-42");
    await addDeliveryEvidenceToHead(
      repository,
      workstream,
      workstream.tickets[0],
      "sandcastle/workstream-42/issue-42",
    );
    let issueClosureAttempted = false;
    let pullRequestCreated = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          issueClosureAttempted = true;
        }),
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

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
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

    expect(Exit.isSuccess(result)).toBe(true);
    expect(issueClosureAttempted).toBe(false);
    expect(pullRequestCreated).toBe(true);
  });
});
