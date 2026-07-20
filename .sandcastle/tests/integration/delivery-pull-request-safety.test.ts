import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Schema } from "effect";
import { TestConsole } from "effect/testing";
import {
  DeliveryMetadata,
  DeliveryOptions,
  DeliveryWorkstream,
  PullRequest,
  TrackerIssue,
} from "../../src/types/delivery";
import { WorkflowError } from "../../src/types/errors";
import { processWorkstreams } from "../../src/workflows/delivery/index";
import {
  ensureDeliveryPullRequest,
  holdDeliveryPullRequest,
  holdDeliveryPullRequestsBeforeDiscovery,
} from "../../src/workflows/delivery/pull-request";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { addDeliveryEvidenceToHead, reviewedIssueFixture } from "../helpers/delivery";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];
const originalPath = process.env.PATH;
const originalFakeGhLog = process.env.SANDCASTLE_FAKE_GH_LOG;
const originalFakeGhPullRequest = process.env.SANDCASTLE_FAKE_GH_PULL_REQUEST;
const originalFakeGhState = process.env.SANDCASTLE_FAKE_GH_STATE;
const originalFakeGhUndoFailure = process.env.SANDCASTLE_FAKE_GH_UNDO_FAILURE;
const originalFakeGhPostReadyDrift = process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT;
const originalFakeGhPostReadyReloadFailure =
  process.env.SANDCASTLE_FAKE_GH_POST_READY_RELOAD_FAILURE;
const originalFakeGhReadyFailureAfterMutation =
  process.env.SANDCASTLE_FAKE_GH_READY_FAILURE_AFTER_MUTATION;

afterEach(async () => {
  process.env.PATH = originalPath;
  process.env.SANDCASTLE_FAKE_GH_LOG = originalFakeGhLog;
  process.env.SANDCASTLE_FAKE_GH_PULL_REQUEST = originalFakeGhPullRequest;
  process.env.SANDCASTLE_FAKE_GH_STATE = originalFakeGhState;
  process.env.SANDCASTLE_FAKE_GH_UNDO_FAILURE = originalFakeGhUndoFailure;
  process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT = originalFakeGhPostReadyDrift;
  process.env.SANDCASTLE_FAKE_GH_POST_READY_RELOAD_FAILURE = originalFakeGhPostReadyReloadFailure;
  process.env.SANDCASTLE_FAKE_GH_READY_FAILURE_AFTER_MUTATION =
    originalFakeGhReadyFailureAfterMutation;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-safety-"));
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

const integrateIssueBranch = async (repository: string, workstream: DeliveryWorkstream) => {
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
  await runGit(repository, "push", "origin", "feat/delivery");
};

const createReviewedIssueBranch = async (repository: string) => {
  await runGit(repository, "switch", "-c", "sandcastle/workstream-10/issue-42");
  await Bun.write(join(repository, "delivery.txt"), "base\nissue 42\n");
  await runGit(repository, "add", "delivery.txt");
  await runGit(repository, "commit", "-m", "feat: issue 42");
  const reviewedCommit = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "switch", "feat/delivery");
  return reviewedCommit;
};

const workstreamFixture = (sourceRevision: string, state = "OPEN") => {
  const root = decodeIssue({
    number: 10,
    title: "Delivery: pull request safety",
    body: `## Delivery\n\n- Target branch: \`feat/delivery\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, title: "Issue 42", state }],
  });
  const ticket = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "<!-- delivery-ticket-key: #10::01 -->",
    state,
    stateReason: state === "CLOSED" ? "COMPLETED" : null,
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
    repository: "delimoov/delimoov",
    deliveryActor: "sandcastle-test",
    root,
    tickets: [ticket],
  });
};

const closingIssue = (number: number, githubName = "delimoov/delimoov") => {
  const [owner = "", name = ""] = githubName.split("/");
  return {
    number,
    repository: { name, owner: { login: owner } },
    url: `https://github.com/${githubName}/issues/${number}`,
  };
};

const managedPullRequest = (overrides: Partial<typeof PullRequest.Type> = {}) =>
  new PullRequest({
    baseRefName: "main",
    body: "<!-- sandcastle-delivery-root: #10 -->\n\nCloses #10",
    closingIssuesReferences: [closingIssue(10)],
    headRefName: "feat/delivery",
    isDraft: false,
    latestReviews: [],
    number: 7,
    reviewRequests: [],
    title: "feat: pull request safety",
    url: "https://example.test/pull/7",
    ...overrides,
  });

const managedPullRequestAtCurrentRoute = async (
  repository: string,
  overrides: Partial<typeof PullRequest.Type> = {},
) =>
  managedPullRequest({
    baseRefOid: await runGit(repository, "rev-parse", "main"),
    headRefOid: await runGit(repository, "rev-parse", "feat/delivery"),
    ...overrides,
  });

const readFakePullRequests = async () => {
  const state = process.env.SANDCASTLE_FAKE_GH_STATE;
  if (!state) throw new Error("Fake GitHub state is not configured");
  return JSON.parse(await Bun.file(state).text()) as Array<typeof PullRequest.Type>;
};

const unexpectedAgent = () =>
  new WorkflowError({ message: "unexpected agent execution", operation: "test" });

const installFakeGh = async (root: string, pullRequests: ReadonlyArray<PullRequest>) => {
  const executable = join(root, "gh");
  const log = join(root, "gh.log");
  const state = join(root, "gh-state.json");
  await Bun.write(state, JSON.stringify(pullRequests));
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.SANDCASTLE_FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const readState = () => JSON.parse(readFileSync(process.env.SANDCASTLE_FAKE_GH_STATE, "utf8"));
const writeState = (pullRequests) =>
  writeFileSync(process.env.SANDCASTLE_FAKE_GH_STATE, JSON.stringify(pullRequests));
const argument = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const closingNumbers = (body) =>
  Array.from(
    body.matchAll(/\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\\s*:\\s*|\\s+)(?:https?:\\/\\/github\\.com\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/issues\\/|(?:[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)?#)(\\d+)\\b/gi),
    (match) => Number(match[1]),
  );
const closingIssue = (number) => ({
  number,
  repository: { name: "delimoov", owner: { login: "delimoov" } },
  url: "https://github.com/delimoov/delimoov/issues/" + number,
});
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const identifier = args[2];
  const pullRequest = readState().find(
    ({ number, url }) => String(number) === identifier || url === identifier,
  );
  if (!pullRequest) process.exit(1);
  if (process.env.SANDCASTLE_FAKE_GH_POST_READY_RELOAD_FAILURE && !pullRequest.isDraft) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pullRequest));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "ready") {
  if (args.includes("--undo") && args[2] === process.env.SANDCASTLE_FAKE_GH_UNDO_FAILURE) {
    process.exit(1);
  }
  const pullRequests = readState();
  const pullRequest = pullRequests.find(({ number }) => String(number) === args[2]);
  if (!pullRequest) process.exit(1);
  pullRequest.isDraft = args.includes("--undo");
  if (!args.includes("--undo")) {
    if (process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT === "head") {
      pullRequest.headRefOid = "b".repeat(40);
    }
    if (process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT === "base") {
      pullRequest.baseRefOid = "b".repeat(40);
    }
    if (process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT === "closure") {
      pullRequest.body += "\\n\\nCloses #42";
      pullRequest.closingIssuesReferences.push(closingIssue(42));
    }
    if (process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT === "body") {
      pullRequest.body = "Closes #42";
      pullRequest.closingIssuesReferences = [closingIssue(42)];
    }
  }
  writeState(pullRequests);
  if (!args.includes("--undo") && process.env.SANDCASTLE_FAKE_GH_READY_FAILURE_AFTER_MUTATION) {
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  const pullRequests = readState();
  const pullRequest = pullRequests.find(({ number }) => String(number) === args[2]);
  if (!pullRequest) process.exit(1);
  const body = argument("--body");
  if (body !== undefined) {
    const oldBodyNumbers = new Set(closingNumbers(pullRequest.body));
    const manualLinks = pullRequest.closingIssuesReferences.filter(
      ({ number }) => !oldBodyNumbers.has(number),
    );
    const linkedNumbers = new Set(manualLinks.map(({ number }) => number));
    pullRequest.closingIssuesReferences = [...manualLinks];
    for (const number of closingNumbers(body)) {
      if (!linkedNumbers.has(number)) pullRequest.closingIssuesReferences.push(closingIssue(number));
      linkedNumbers.add(number);
    }
    pullRequest.body = body;
  }
  const title = argument("--title");
  if (title !== undefined) pullRequest.title = title;
  if (args.includes("--add-reviewer")) {
    pullRequest.reviewRequests = [{ login: argument("--add-reviewer") }];
  }
  writeState(pullRequests);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const pullRequests = readState();
  const number = Math.max(0, ...pullRequests.map(({ number }) => number)) + 1;
  const body = argument("--body") ?? "";
  const branchOid = (branch) =>
    new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", branch]).stdout).trim();
  const pullRequest = {
    baseRefName: argument("--base"),
    baseRefOid: branchOid(argument("--base")),
    body,
    closingIssuesReferences: closingNumbers(body).map(closingIssue),
    headRefName: argument("--head"),
    headRefOid: branchOid(argument("--head")),
    isDraft: args.includes("--draft"),
    latestReviews: [],
    number,
    reviewRequests: [{ login: argument("--reviewer") }],
    title: argument("--title"),
    url: "https://example.test/pull/" + number,
  };
  pullRequests.push(pullRequest);
  writeState(pullRequests);
  process.stdout.write(pullRequest.url);
  process.exit(0);
}
console.error("Unexpected fake gh invocation: " + args.join(" "));
process.exit(1);
`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  process.env.SANDCASTLE_FAKE_GH_LOG = log;
  process.env.SANDCASTLE_FAKE_GH_PULL_REQUEST = JSON.stringify(pullRequests);
  process.env.SANDCASTLE_FAKE_GH_STATE = state;
  return log;
};

describe("delivery pull request safety", () => {
  test("holds a managed pull request before target preparation can fail", async () => {
    const { repository } = await createRepository();
    const workstream = workstreamFixture("a".repeat(40));
    const events: Array<string> = [];
    let pullRequestReady = true;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/7"),
      holdPullRequest: () =>
        Effect.sync(() => {
          events.push("hold");
          pullRequestReady = false;
        }),
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: unexpectedAgent,
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
    expect(events).toEqual(["hold"]);
    expect(pullRequestReady).toBe(false);
  });

  test("holds managed pull requests before rejecting a non-default destination", async () => {
    const { repository, sourceRevision } = await createRepository();
    const initial = workstreamFixture(sourceRevision);
    const workstream = new DeliveryWorkstream({
      ...initial,
      delivery: new DeliveryMetadata({
        ...initial.delivery,
        destinationBranch: "release",
      }),
    });
    const events: Array<string> = [];
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/7"),
      holdPullRequest: () =>
        Effect.sync(() => {
          events.push("hold");
        }),
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: unexpectedAgent,
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
    expect(events).toEqual(["hold"]);
  });

  test("resumes an unfinished managed pull request and readies it only after integration", async () => {
    const { repository, sourceRevision } = await createRepository();
    const reviewedCommit = await createReviewedIssueBranch(repository);
    let workstream = workstreamFixture(sourceRevision);
    const events: Array<string> = [];
    let ensuredTargetOid: string | undefined;
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          events.push("close");
          workstream = workstreamFixture(sourceRevision, "CLOSED");
        }),
      ensurePullRequest: (_, __, verifiedTargetOid) =>
        Effect.sync(() => {
          events.push("ensure");
          ensuredTargetOid = verifiedTargetOid;
          return "https://example.test/pull/7";
        }),
      holdPullRequest: () =>
        Effect.sync(() => {
          events.push("hold");
        }),
      loadWorkstream: () => Effect.succeed(workstream),
    });
    const agents = DeliveryAgents.of({
      implementAndReview: (_, __, ___, issue) =>
        Effect.sync(() => {
          events.push("implement");
          return reviewedIssueFixture(
            workstream,
            issue,
            "sandcastle/workstream-10/issue-42",
            reviewedCommit,
          );
        }),
      plan: () =>
        Effect.sync(() => {
          events.push("plan");
          return ["42"];
        }),
      repair: unexpectedAgent,
      verify: () =>
        Effect.sync(() => {
          events.push("verify");
        }),
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
    expect(workstream.tickets[0]?.state).toBe("CLOSED");
    expect(events).toEqual(["hold", "plan", "implement", "verify", "close", "verify", "ensure"]);
    expect(ensuredTargetOid).toBe(await runGit(repository, "rev-parse", "feat/delivery"));
  });

  test("readies a recovered pull request only after reloading completed bookkeeping", async () => {
    const { repository, sourceRevision } = await createRepository();
    let currentWorkstream = workstreamFixture(sourceRevision);
    await integrateIssueBranch(repository, currentWorkstream);
    const events: Array<string> = [];
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () =>
        Effect.sync(() => {
          events.push("close");
          currentWorkstream = workstreamFixture(sourceRevision, "CLOSED");
        }),
      ensurePullRequest: () =>
        Effect.sync(() => {
          events.push("ensure");
          return "https://example.test/pull/7";
        }),
      holdPullRequest: () =>
        Effect.sync(() => {
          events.push("hold");
        }),
      loadWorkstream: () => Effect.succeed(currentWorkstream),
    });
    const agents = DeliveryAgents.of({
      implementAndReview: unexpectedAgent,
      plan: unexpectedAgent,
      repair: unexpectedAgent,
      verify: () => Effect.void,
    });

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        [currentWorkstream],
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
    expect(events).toEqual(["hold", "close", "ensure"]);
  });

  test("repairs a completed draft pull request before marking it ready", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        body: "<!-- sandcastle-delivery-root: #10 -->",
        isDraft: true,
        title: "feat: stale title",
      }),
    ]);

    await runEffect(
      ensureDeliveryPullRequest(
        deliveryRepository(repository),
        workstream,
        await runGit(repository, "rev-parse", "feat/delivery"),
      ).pipe(Effect.provide(BunServices.layer), Effect.provide(TestConsole.layer)),
    );

    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
    const edit = commands[1] ?? [];
    const body = edit[edit.indexOf("--body") + 1];

    expect(edit.slice(0, 3)).toEqual(["pr", "edit", "7"]);
    expect(edit).toContain("--title");
    expect(edit).toContain("feat: pull request safety");
    expect(edit).toContain("--add-reviewer");
    expect(edit).toContain("carere");
    expect(body).toContain("Closes #10");
    expect(commands.at(-2)).toEqual(["pr", "ready", "7", "--repo", "delimoov/delimoov"]);
    expect(commands.at(-1)?.slice(0, 3)).toEqual(["pr", "view", "7"]);
  });

  test("keeps only the root closing reference when readying a stale managed pull request", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        body: `<!-- sandcastle-delivery-root: #10 -->
## Summary

This fixes formatting details without linking an issue.
This change fixes #42 while preserving this explanation.

Closes #42
Fixes: delimoov/delimoov#43
Resolves https://github.com/delimoov/delimoov/issues/44
Closes #10

## Preview

\`\`\`sh
moon run sandcastle:preview -- start --branch 'feat/delivery'
moon run sandcastle:preview -- stop --branch 'feat/delivery'
\`\`\``,
        isDraft: true,
      }),
    ]);

    await runEffect(
      ensureDeliveryPullRequest(
        deliveryRepository(repository),
        workstream,
        await runGit(repository, "rev-parse", "feat/delivery"),
      ).pipe(Effect.provide(BunServices.layer), Effect.provide(TestConsole.layer)),
    );

    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
    const edit = commands[1] ?? [];
    const body = edit[edit.indexOf("--body") + 1] ?? "";
    const closingReferences = body.match(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+)\b/gi,
    );

    expect(body).toContain("This fixes formatting details without linking an issue.");
    expect(body).toContain("while preserving this explanation.");
    expect(body).toContain("sandcastle:preview -- start --branch 'feat/delivery'");
    expect(body).toContain("sandcastle:preview -- stop --branch 'feat/delivery'");
    expect(closingReferences).toEqual(["Closes #10"]);
    expect(commands.at(-2)).toEqual(["pr", "ready", "7", "--repo", "delimoov/delimoov"]);
    expect(commands.at(-1)?.slice(0, 3)).toEqual(["pr", "view", "7"]);
  });

  test("makes a managed pull request draft before removing all closing references", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const workstream = workstreamFixture("a".repeat(40));
    const log = await installFakeGh(root, [
      managedPullRequest({
        body: `<!-- sandcastle-delivery-root: #10 -->

Closes #10
Fixes delimoov/delimoov#42
Resolves: https://github.com/delimoov/delimoov/issues/43`,
      }),
    ]);

    await runEffect(
      holdDeliveryPullRequest(deliveryRepository(root), workstream).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
      ),
    );

    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
    const edit = commands[2] ?? [];
    const body = edit[edit.indexOf("--body") + 1];

    expect(commands[1]).toEqual(["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"]);
    expect(edit.slice(0, 3)).toEqual(["pr", "edit", "7"]);
    expect(body).toContain("<!-- sandcastle-delivery-root: #10 -->");
    expect(
      body.match(
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+)\b/gi,
      ),
    ).toBeNull();
  });

  test("does not mutate an unmanaged pull request", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const workstream = workstreamFixture("a".repeat(40));
    const log = await installFakeGh(root, [
      managedPullRequest({ body: "Closes #10", isDraft: false }),
    ]);

    const result = await runEffect(
      holdDeliveryPullRequest(deliveryRepository(root), workstream).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const commands = (await Bun.file(log).text()).trim().split("\n");

    expect(Exit.isSuccess(result)).toBe(true);
    expect(commands).toHaveLength(1);
  });

  test("holds every managed pull request for the root across stale target and base routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const workstream = workstreamFixture("a".repeat(40));
    const log = await installFakeGh(root, [
      managedPullRequest({ baseRefName: "release", headRefName: "feat/old-delivery" }),
      managedPullRequest({ number: 8 }),
    ]);

    await runEffect(
      holdDeliveryPullRequest(deliveryRepository(root), workstream).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
      ),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(commands[0]).toContain("--limit");
    expect(commands[0]?.[commands[0].indexOf("--limit") + 1]).toBe("2147483647");
    expect(commands[0]).not.toContain("--head");
    expect(commands[0]).not.toContain("--base");
    expect(commands.filter(([area, action]) => area === "pr" && action === "ready")).toEqual([
      ["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"],
      ["pr", "ready", "8", "--repo", "delimoov/delimoov", "--undo"],
    ]);
  });

  test("holds every managed pull request before automatic discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const log = await installFakeGh(root, [
      managedPullRequest(),
      managedPullRequest({
        body: `<!-- sandcastle-delivery-root: #11 -->
<!-- sandcastle-delivery-root: #10 -->

Closes #11`,
        closingIssuesReferences: [closingIssue(11)],
        number: 8,
      }),
      managedPullRequest({ body: "Closes #12", number: 9 }),
    ]);

    await runEffect(
      holdDeliveryPullRequestsBeforeDiscovery(deliveryRepository(root)).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
      ),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(commands.filter(([area, action]) => area === "pr" && action === "ready")).toEqual([
      ["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"],
      ["pr", "ready", "8", "--repo", "delimoov/delimoov", "--undo"],
    ]);
    const heldBodies = commands
      .filter(([area, action]) => area === "pr" && action === "edit")
      .map((command) => command[command.indexOf("--body") + 1] ?? "");
    expect(heldBodies).toHaveLength(2);
    expect(heldBodies.every((body) => !body.match(/\bCloses #\d+\b/i))).toBe(true);
  });

  test("holds only the explicitly selected root before discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const log = await installFakeGh(root, [
      managedPullRequest(),
      managedPullRequest({
        body: `<!-- sandcastle-delivery-root: #11 -->
<!-- sandcastle-delivery-root: #10 -->

Closes #11`,
        closingIssuesReferences: [closingIssue(11)],
        number: 8,
      }),
    ]);

    await runEffect(
      holdDeliveryPullRequestsBeforeDiscovery(deliveryRepository(root), 10).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
      ),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(commands.filter(([area, action]) => area === "pr" && action === "ready")).toEqual([
      ["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"],
      ["pr", "ready", "8", "--repo", "delimoov/delimoov", "--undo"],
    ]);
  });

  test("attempts to hold every managed pull request before propagating a mutation failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(root);
    const workstream = workstreamFixture("a".repeat(40));
    const log = await installFakeGh(root, [
      managedPullRequest(),
      managedPullRequest({ number: 8 }),
    ]);
    process.env.SANDCASTLE_FAKE_GH_UNDO_FAILURE = "7";

    const result = await runEffect(
      holdDeliveryPullRequest(deliveryRepository(root), workstream).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(Exit.isFailure(result)).toBe(true);
    expect(commands.filter(([area, action]) => area === "pr" && action === "ready")).toEqual([
      ["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"],
      ["pr", "ready", "8", "--repo", "delimoov/delimoov", "--undo"],
    ]);
  });

  test("refuses an ambiguous current pull request route", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true, number: 8 }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(
        deliveryRepository(repository),
        workstream,
        await runGit(repository, "rev-parse", "feat/delivery"),
      ).pipe(Effect.provide(BunServices.layer), Effect.provide(TestConsole.layer), Effect.exit),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(Exit.isFailure(result)).toBe(true);
    expect(commands).toHaveLength(1);
  });

  test("never readies or repurposes a current-route pull request with multiple root markers", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const root10 = workstreamFixture(sourceRevision, "CLOSED");
    const root20 = new DeliveryWorkstream({
      ...root10,
      root: decodeIssue({ ...root10.root, number: 20, title: "Delivery root 20" }),
    });
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        body: `<!-- sandcastle-delivery-root: #10 -->
<!-- sandcastle-delivery-root: #20 -->

Closes #10`,
        closingIssuesReferences: [closingIssue(10)],
        isDraft: true,
      }),
    ]);

    const root10Result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), root10, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const root20Result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), root20, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(Exit.isFailure(root10Result)).toBe(true);
    expect(Exit.isFailure(root20Result)).toBe(true);
    expect(commands.some(([area, action]) => area === "pr" && action === "ready")).toBe(false);
    expect((await readFakePullRequests())[0]?.isDraft).toBe(true);
  });

  test("refuses to ready a pull request manually linked to another issue", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        closingIssuesReferences: [closingIssue(10), closingIssue(42)],
        isDraft: true,
      }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(
        deliveryRepository(repository),
        workstream,
        await runGit(repository, "rev-parse", "feat/delivery"),
      ).pipe(Effect.provide(BunServices.layer), Effect.provide(TestConsole.layer), Effect.exit),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(Exit.isFailure(result)).toBe(true);
    expect(commands.some(([area, action]) => area === "pr" && action === "ready")).toBe(false);
  });

  test("refuses to ready a target commit that closes another issue", async () => {
    const { repository, sourceRevision } = await createRepository();
    await Bun.write(join(repository, "unsafe.txt"), "unsafe\n");
    await runGit(repository, "add", "unsafe.txt");
    await runGit(repository, "commit", "-m", "feat: unsafe closure", "-m", "Closes: #42");
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test("refuses a qualified closing reference to another repository issue", async () => {
    const { repository, sourceRevision } = await createRepository();
    await Bun.write(join(repository, "unsafe.txt"), "unsafe\n");
    await runGit(repository, "add", "unsafe.txt");
    await runGit(
      repository,
      "commit",
      "-m",
      "feat: unsafe qualified closure",
      "-m",
      "Fixes delimoov/other#10",
    );
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test("refuses a full GitHub URL closing reference to another issue", async () => {
    const { repository, sourceRevision } = await createRepository();
    await Bun.write(join(repository, "unsafe.txt"), "unsafe\n");
    await runGit(repository, "add", "unsafe.txt");
    await runGit(
      repository,
      "commit",
      "-m",
      "feat: unsafe URL closure",
      "-m",
      "Resolves https://github.com/delimoov/delimoov/issues/42",
    );
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test("scans closing references from the verified commit instead of a moved local branch", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    const pullRequest = await managedPullRequestAtCurrentRoute(repository, { isDraft: true });
    await Bun.write(join(repository, "unsafe-later.txt"), "not verified\n");
    await runGit(repository, "add", "unsafe-later.txt");
    await runGit(repository, "commit", "-m", "feat: unverified later commit", "-m", "Closes #42");
    await installFakeGh(executableRoot, [pullRequest]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    expect((await readFakePullRequests())[0]?.isDraft).toBe(false);
  });

  test("creates a draft, validates safe root commit references, then marks it ready", async () => {
    const { repository, sourceRevision } = await createRepository();
    await Bun.write(join(repository, "safe.txt"), "safe\n");
    await runGit(repository, "add", "safe.txt");
    await runGit(
      repository,
      "commit",
      "-m",
      "feat: safe root closures",
      "-m",
      `Closes: #10
Fixes delimoov/delimoov#10
Resolves https://github.com/delimoov/delimoov/issues/10`,
    );
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const log = await installFakeGh(executableRoot, []);

    const result = await runEffect(
      ensureDeliveryPullRequest(
        deliveryRepository(repository),
        workstream,
        await runGit(repository, "rev-parse", "feat/delivery"),
      ).pipe(Effect.provide(BunServices.layer), Effect.provide(TestConsole.layer), Effect.exit),
    );
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
    const createIndex = commands.findIndex(
      ([area, action]) => area === "pr" && action === "create",
    );
    const viewIndex = commands.findIndex(([area, action]) => area === "pr" && action === "view");
    const readyIndex = commands.findIndex(([area, action]) => area === "pr" && action === "ready");

    expect(Exit.isSuccess(result)).toBe(true);
    expect(commands[createIndex]).toContain("--draft");
    expect(createIndex).toBeLessThan(viewIndex);
    expect(viewIndex).toBeLessThan(readyIndex);
  });

  test("keeps a draft when the published target OID differs from the verified commit", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        headRefOid: "b".repeat(40),
        isDraft: true,
      }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect((await readFakePullRequests())[0]?.isDraft).toBe(true);
  });

  test("keeps a draft when the destination OID changed", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        baseRefOid: "b".repeat(40),
        isDraft: true,
      }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect((await readFakePullRequests())[0]?.isDraft).toBe(true);
  });

  test("keeps a draft when GitHub reports a malformed route OID", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, {
        headRefOid: "not-an-object-id",
        isDraft: true,
      }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect((await readFakePullRequests())[0]?.isDraft).toBe(true);
  });

  test("re-holds a pull request when its route changes immediately after readying", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT = "head";
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const pullRequest = (await readFakePullRequests())[0];

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequest?.isDraft).toBe(true);
    expect(pullRequest?.body).not.toContain("Closes #10");
  });

  test("re-holds the exact pull request when post-ready body drift removes its marker", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    process.env.SANDCASTLE_FAKE_GH_POST_READY_DRIFT = "body";
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const pullRequest = (await readFakePullRequests())[0];

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequest?.isDraft).toBe(true);
    expect(pullRequest?.body).not.toMatch(/\bCloses #\d+\b/i);
  });

  test("forces the exact pull request back to draft when the post-ready reload fails", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    process.env.SANDCASTLE_FAKE_GH_POST_READY_RELOAD_FAILURE = "1";
    const log = await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const pullRequest = (await readFakePullRequests())[0];
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequest?.isDraft).toBe(true);
    expect(pullRequest?.body).not.toMatch(/\bCloses #\d+\b/i);
    expect(commands.filter((command) => command[0] === "pr" && command[1] === "ready")).toEqual([
      ["pr", "ready", "7", "--repo", "delimoov/delimoov"],
      ["pr", "ready", "7", "--repo", "delimoov/delimoov", "--undo"],
    ]);
  });

  test("forces the exact pull request back to draft after an ambiguous ready failure", async () => {
    const { repository, sourceRevision } = await createRepository();
    const executableRoot = await mkdtemp(join(tmpdir(), "sandcastle-pr-tracker-"));
    temporaryDirectories.push(executableRoot);
    const workstream = workstreamFixture(sourceRevision, "CLOSED");
    const verifiedTargetSha = await runGit(repository, "rev-parse", "feat/delivery");
    process.env.SANDCASTLE_FAKE_GH_READY_FAILURE_AFTER_MUTATION = "1";
    await installFakeGh(executableRoot, [
      await managedPullRequestAtCurrentRoute(repository, { isDraft: true }),
    ]);

    const result = await runEffect(
      ensureDeliveryPullRequest(deliveryRepository(repository), workstream, verifiedTargetSha).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(TestConsole.layer),
        Effect.exit,
      ),
    );
    const pullRequest = (await readFakePullRequests())[0];

    expect(Exit.isFailure(result)).toBe(true);
    expect(pullRequest?.isDraft).toBe(true);
    expect(pullRequest?.body).not.toMatch(/\bCloses #\d+\b/i);
  });
});
