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
import { WorkflowError } from "../../src/types/errors";
import { deliveryCompletionComment } from "../../src/workflows/delivery/evidence";
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
const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const setupDelivery = async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "sandcastle-durable-evidence-"));
  temporaryDirectories.push(rootPath);
  const remote = join(rootPath, "remote.git");
  const repositoryPath = join(rootPath, "repository");
  await runGit(rootPath, "init", "--bare", remote);
  await runGit(rootPath, "init", "--initial-branch=main", repositoryPath);
  await runGit(repositoryPath, "config", "user.email", "sandcastle@example.test");
  await runGit(repositoryPath, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repositoryPath, "base.txt"), "base\n");
  await runGit(repositoryPath, "add", "base.txt");
  await runGit(repositoryPath, "commit", "-m", "test: base");
  const sourceRevision = await runGit(repositoryPath, "rev-parse", "HEAD");
  await runGit(repositoryPath, "remote", "add", "origin", remote);
  await runGit(repositoryPath, "push", "-u", "origin", "main");
  const issueBranch = "sandcastle/workstream-10/issue-42";
  await runGit(repositoryPath, "switch", "-c", issueBranch);
  await Bun.write(join(repositoryPath, "issue.txt"), "reviewed implementation\n");
  await runGit(repositoryPath, "add", "issue.txt");
  await runGit(repositoryPath, "commit", "-m", "feat: issue 42");
  const reviewedCommit = await runGit(repositoryPath, "rev-parse", "HEAD");
  await runGit(repositoryPath, "switch", "-c", "feat/delivery", sourceRevision);
  await runGit(repositoryPath, "push", "-u", "origin", "feat/delivery");

  const root = decodeIssue({
    number: 10,
    title: "Delivery: durable evidence",
    body: `## Delivery\n\n- Target branch: \`feat/delivery\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, state: "OPEN" }],
  });
  const ticket = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "<!-- delivery-ticket-key: #10::01 -->",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, state: "OPEN" },
    blockedBy: [],
    subIssues: [],
  });
  const workstream = new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision,
      targetBranch: "feat/delivery",
    }),
    deliveryActor: "sandcastle-bot",
    kind: "root",
    repository: "delimoov/delimoov",
    root,
    tickets: [ticket],
  });
  const repository: DeliveryRepository = {
    defaultBranch: "main",
    githubLogin: "sandcastle-bot",
    githubName: "delimoov/delimoov",
    rootPath: repositoryPath,
  };
  const target = new PreparedTarget({
    baseSha: sourceRevision,
    branch: "feat/delivery",
    path: repositoryPath,
  });
  return {
    issueBranch,
    repository,
    repositoryPath,
    reviewed: reviewedIssueFixture(workstream, ticket, issueBranch, reviewedCommit),
    reviewedCommit,
    sourceRevision,
    target,
    ticket,
    workstream,
  };
};

const agents = DeliveryAgents.of({
  implementAndReview: () =>
    new WorkflowError({ message: "unexpected implementation", operation: "test" }),
  plan: () => new WorkflowError({ message: "unexpected planning", operation: "test" }),
  repair: () => new WorkflowError({ message: "unexpected repair", operation: "test" }),
  verify: () => Effect.void,
});

const runWithServices = <A, E>(
  effect: Effect.Effect<A, E, DeliveryAgents | DeliveryTracker | BunServices.BunServices>,
  tracker: ReturnType<typeof DeliveryTracker.of>,
) =>
  runEffect(
    effect.pipe(
      Effect.provideService(DeliveryTracker, tracker),
      Effect.provideService(DeliveryAgents, agents),
      Effect.provide(BunServices.layer),
    ),
  );

describe("durable delivery evidence", () => {
  test("merges the immutable reviewed commit when its diagnostic branch moves", async () => {
    const setup = await setupDelivery();
    await runGit(setup.repositoryPath, "branch", "-f", setup.issueBranch, setup.sourceRevision);
    let closed = false;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          closed = true;
        }),
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(setup.workstream),
    });

    await runWithServices(
      integrateIssue(
        setup.repository,
        setup.target,
        setup.workstream,
        setup.reviewed,
        setup.sourceRevision,
      ),
      tracker,
    );

    const parents = (await runGit(setup.repositoryPath, "show", "-s", "--format=%P", "HEAD")).split(
      " ",
    );
    expect(parents).toEqual([setup.sourceRevision, setup.reviewedCommit]);
    expect(await Bun.file(join(setup.repositoryPath, "issue.txt")).text()).toBe(
      "reviewed implementation\n",
    );
    expect(closed).toBe(true);
  });

  for (const mutation of [
    "ticket body",
    "ticket comment",
    "root body",
    "root comment",
    "delivery metadata",
  ] as const) {
    test(`refuses recovery after publication when ${mutation} changes`, async () => {
      const setup = await setupDelivery();
      const changedTicket = new TrackerIssue({
        ...setup.ticket,
        body: mutation === "ticket body" ? `${setup.ticket.body}\nchanged` : setup.ticket.body,
        comments:
          mutation === "ticket comment"
            ? [{ author: { login: "human-user" }, body: "changed ticket requirements" }]
            : setup.ticket.comments,
      });
      const changedRoot = new TrackerIssue({
        ...setup.workstream.root,
        body:
          mutation === "root body"
            ? `${setup.workstream.root.body}\nchanged`
            : setup.workstream.root.body,
        comments:
          mutation === "root comment"
            ? [{ author: { login: "human-user" }, body: "changed root requirements" }]
            : setup.workstream.root.comments,
      });
      const changedDelivery =
        mutation === "delivery metadata"
          ? new DeliveryMetadata({ ...setup.workstream.delivery, destinationBranch: "release" })
          : setup.workstream.delivery;
      const changed = new DeliveryWorkstream({
        ...setup.workstream,
        delivery: changedDelivery,
        root: changedRoot,
        tickets: [changedTicket],
      });
      let closeAttempted = false;
      const tracker = DeliveryTracker.of({
        closeIssueAsCompleted: () =>
          Effect.sync(() => {
            closeAttempted = true;
          }),
        ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
        holdPullRequest: () => Effect.void,
        loadWorkstream: () => Effect.succeed(changed),
      });

      const first = await runWithServices(
        integrateIssue(
          setup.repository,
          setup.target,
          setup.workstream,
          setup.reviewed,
          setup.sourceRevision,
        ).pipe(Effect.exit),
        tracker,
      );
      const published = (
        await runGit(setup.repositoryPath, "ls-remote", "origin", "refs/heads/feat/delivery")
      ).split(/\s+/)[0];
      const recovery = await runWithServices(
        recoverIntegratedIssue(setup.repository, setup.target, changed, changedTicket).pipe(
          Effect.exit,
        ),
        tracker,
      );

      expect(Exit.isFailure(first)).toBe(true);
      expect(published).not.toBe(setup.sourceRevision);
      expect(Exit.isFailure(recovery)).toBe(true);
      expect(closeAttempted).toBe(false);
    });
  }

  test("recovers valid published evidence after the worker branch is deleted", async () => {
    const setup = await setupDelivery();
    let closeAttempts = 0;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => {
        closeAttempts += 1;
        return closeAttempts === 1
          ? new WorkflowError({ message: "bookkeeping failed", operation: "test" })
          : Effect.void;
      },
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () => Effect.succeed(setup.workstream),
    });
    await runWithServices(
      integrateIssue(
        setup.repository,
        setup.target,
        setup.workstream,
        setup.reviewed,
        setup.sourceRevision,
      ).pipe(Effect.exit),
      tracker,
    );
    await runGit(setup.repositoryPath, "branch", "-D", setup.issueBranch);

    const recovered = await runWithServices(
      recoverIntegratedIssue(setup.repository, setup.target, setup.workstream, setup.ticket),
      tracker,
    );

    expect(recovered).toBe(true);
    expect(closeAttempts).toBe(2);
  });

  for (const tamper of ["missing", "mismatched"] as const) {
    test(`rejects ${tamper} persisted specification fingerprints`, async () => {
      const setup = await setupDelivery();
      const tracker = DeliveryTracker.of({
        closeIssueAsCompleted: () =>
          new WorkflowError({ message: "bookkeeping failed", operation: "test" }),
        ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
        holdPullRequest: () => Effect.void,
        loadWorkstream: () => Effect.succeed(setup.workstream),
      });
      await runWithServices(
        integrateIssue(
          setup.repository,
          setup.target,
          setup.workstream,
          setup.reviewed,
          setup.sourceRevision,
        ).pipe(Effect.exit),
        tracker,
      );
      const message = await runGit(setup.repositoryPath, "show", "-s", "--format=%B", "HEAD");
      const changedMessage = message
        .split("\n")
        .flatMap((line) => {
          if (!line.startsWith("Sandcastle-Specification-Fingerprint: ")) return [line];
          return tamper === "missing"
            ? []
            : [
                "Sandcastle-Specification-Fingerprint: 0000000000000000000000000000000000000000000000000000000000000000",
              ];
        })
        .join("\n");
      await runGit(setup.repositoryPath, "commit", "--amend", "-m", changedMessage);

      const recovery = await runWithServices(
        recoverIntegratedIssue(setup.repository, setup.target, setup.workstream, setup.ticket).pipe(
          Effect.exit,
        ),
        tracker,
      );

      expect(Exit.isFailure(recovery)).toBe(true);
    });
  }

  for (const author of ["sandcastle-bot", "human-user"] as const) {
    test(`${author === "sandcastle-bot" ? "accepts" : "rejects"} a completion marker authored by ${author}`, async () => {
      const setup = await setupDelivery();
      const failingTracker = DeliveryTracker.of({
        closeIssueAsCompleted: () =>
          new WorkflowError({ message: "bookkeeping failed", operation: "test" }),
        ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
        holdPullRequest: () => Effect.void,
        loadWorkstream: () => Effect.succeed(setup.workstream),
      });
      await runWithServices(
        integrateIssue(
          setup.repository,
          setup.target,
          setup.workstream,
          setup.reviewed,
          setup.sourceRevision,
        ).pipe(Effect.exit),
        failingTracker,
      );
      const mergeCommit = await runGit(setup.repositoryPath, "rev-parse", "HEAD");
      const completed = new TrackerIssue({
        ...setup.ticket,
        comments: [
          {
            author: { login: author },
            body: deliveryCompletionComment(setup.ticket.number, "feat/delivery", mergeCommit),
          },
        ],
        state: "CLOSED",
        stateReason: "COMPLETED",
      });
      const completedWorkstream = new DeliveryWorkstream({
        ...setup.workstream,
        deliveryActor: "another-authorized-user",
        tickets: [completed],
      });
      let pullRequestCreated = false;
      const finalizingTracker = DeliveryTracker.of({
        closeIssueAsCompleted: () => Effect.void,
        ensurePullRequest: () =>
          Effect.sync(() => {
            pullRequestCreated = true;
            return "https://example.test/pull/1";
          }),
        holdPullRequest: () => Effect.void,
        loadWorkstream: () => Effect.succeed(completedWorkstream),
      });

      const result = await runWithServices(
        finalizeCompletedWorkstream(setup.repository, setup.target, completedWorkstream).pipe(
          Effect.exit,
        ),
        finalizingTracker,
      );

      expect(Exit.isSuccess(result)).toBe(author === "sandcastle-bot");
      expect(pullRequestCreated).toBe(author === "sandcastle-bot");
    });
  }
});
