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
  TrackerIssue,
} from "../../src/types/delivery";
import { WorkflowError } from "../../src/types/errors";
import { processWorkstreams, runDeliveryInRepository } from "../../src/workflows/delivery/index";
import { discoverWorkstreams } from "../../src/workflows/delivery/issues";
import type { DeliveryRepository } from "../../src/workflows/delivery/repository";
import { DeliveryAgents, DeliveryTracker } from "../../src/workflows/delivery/services";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const deliveryRepository = (rootPath: string): DeliveryRepository => ({
  defaultBranch: "main",
  githubName: "delimoov/delimoov",
  rootPath,
});

const createRepositoryWithTargetBranches = async (branches: ReadonlyArray<string>) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-delivery-scheduling-"));
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

const standaloneWorkstream = (number: number, targetBranch: string, sourceRevision: string) => {
  const issue = decodeIssue({
    number,
    title: `Standalone ${number}`,
    body: `## Delivery\n\n- Target branch: \`${targetBranch}\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``,
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [],
  });
  return new DeliveryWorkstream({
    delivery: new DeliveryMetadata({ destinationBranch: "main", sourceRevision, targetBranch }),
    kind: "standalone",
    root: issue,
    tickets: [issue],
  });
};

const sourceRevision = "a".repeat(40);

const githubIssue = (number: number, body: string, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  assignees: [],
  comments: [],
  parent: null,
  blockedBy: [],
  subIssues: [],
  ...overrides,
});

const validDeliveryBody = (targetBranch: string) =>
  `## Delivery\n\n- Target branch: \`${targetBranch}\`\n- Destination branch: \`main\`\n- Source revision: \`${sourceRevision}\``;

const installFakeGithub = async (
  readyIssues: ReadonlyArray<ReturnType<typeof githubIssue>>,
  viewedIssues: Readonly<Record<string, unknown>>,
  pullRequests: ReadonlyArray<Record<string, unknown>> = [],
) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-fake-github-"));
  temporaryDirectories.push(root);
  const executable = join(root, "gh");
  const log = join(root, "gh.log");
  const fixture = JSON.stringify({ pullRequests, readyIssues, viewedIssues });
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const fixture = ${fixture};
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(fixture.pullRequests));
  process.exit(0);
}
if (args[0] === "pr" && (args[1] === "ready" || args[1] === "edit")) process.exit(0);
if (args[0] === "issue" && args[1] === "list") {
  const listed = args.includes("--label")
    ? fixture.readyIssues.filter((issue) =>
        issue.labels.some((label) => label.name === args[args.indexOf("--label") + 1]),
      )
    : fixture.readyIssues;
  process.stdout.write(JSON.stringify(listed));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const issue = fixture.viewedIssues[args[2]];
  if (issue) {
    process.stdout.write(JSON.stringify(issue));
    process.exit(0);
  }
}
console.error(\`Unexpected fake gh invocation: \${args.join(" ")}\`);
process.exit(1);
`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  return log;
};

describe("delivery workstream scheduling", () => {
  test("starts every independent workstream even when one agent permit is available", async () => {
    const targets = ["feat/one", "feat/two"];
    const { repository, sourceRevision } = await createRepositoryWithTargetBranches(targets);
    const workstreams = targets.map((target, index) =>
      standaloneWorkstream(index + 1, target, sourceRevision),
    );
    const byRoot = new Map(workstreams.map((workstream) => [workstream.root.number, workstream]));
    const startedRoots = new Set<number>();
    const allWorkstreamsStarted = Promise.withResolvers<void>();
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: (_, workstream) =>
        Effect.sync(() => {
          startedRoots.add(workstream.root.number);
          if (startedRoots.size === workstreams.length) allWorkstreamsStarted.resolve();
        }),
      loadWorkstream: (_, rootNumber) => {
        const workstream = byRoot.get(rootNumber);
        return workstream
          ? Effect.succeed(workstream)
          : new WorkflowError({ message: `missing workstream #${rootNumber}`, operation: "test" });
      },
    });
    const expectedStop = () =>
      new WorkflowError({ message: "expected agent stop", operation: "test" });
    const agents = DeliveryAgents.of({
      implementAndReview: expectedStop,
      plan: (_, workstream) =>
        Effect.promise(() => allWorkstreamsStarted.promise).pipe(
          Effect.as([String(workstream.root.number)]),
        ),
      repair: expectedStop,
      verify: expectedStop,
    });

    const result = await runEffect(
      processWorkstreams(
        deliveryRepository(repository),
        workstreams,
        new DeliveryOptions({ concurrency: 1, maxIterations: 1 }),
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(startedRoots).toEqual(new Set([1, 2]));
  });
});

describe("delivery workstream discovery", () => {
  test("holds stale pull requests before an invalid child graph is skipped", async () => {
    const root = githubIssue(10, validDeliveryBody("feat/invalid"), {
      labels: [],
      subIssues: [{ number: 42, state: "OPEN", title: "Issue 42" }],
      title: "Invalid delivery root",
    });
    const child = githubIssue(42, "<!-- delivery-ticket-key: #10::01 -->", {
      labels: [],
      parent: { number: 10, state: "OPEN", title: root.title },
    });
    const log = await installFakeGithub([root], { 10: root, 42: child }, [
      {
        baseRefName: "main",
        body: "<!-- sandcastle-delivery-root: #10 -->\n\nCloses #10",
        closingIssuesReferences: [],
        headRefName: "feat/invalid",
        isDraft: false,
        latestReviews: [],
        number: 7,
        reviewRequests: [],
        title: "feat: stale delivery",
        url: "https://example.test/pull/7",
      },
    ]);
    const tracker = DeliveryTracker.of({
      closeIssueAsCompleted: () => Effect.void,
      ensurePullRequest: () => Effect.succeed("https://example.test/pull/1"),
      holdPullRequest: () => Effect.void,
      loadWorkstream: () =>
        new WorkflowError({ message: "unexpected tracker load", operation: "test" }),
    });
    const agents = DeliveryAgents.of({
      implementAndReview: () =>
        new WorkflowError({ message: "unexpected agent", operation: "test" }),
      plan: () => new WorkflowError({ message: "unexpected agent", operation: "test" }),
      repair: () => new WorkflowError({ message: "unexpected agent", operation: "test" }),
      verify: () => new WorkflowError({ message: "unexpected agent", operation: "test" }),
    });

    const result = await runEffect(
      runDeliveryInRepository(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(
        Effect.provideService(DeliveryTracker, tracker),
        Effect.provideService(DeliveryAgents, agents),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
    const holdIndex = commands.findIndex(
      (command) => command[0] === "pr" && command[1] === "ready" && command.includes("--undo"),
    );
    const sanitize = commands.find((command) => command[0] === "pr" && command[1] === "edit");
    const discoveryIndex = commands.findIndex(
      (command) => command[0] === "issue" && command[1] === "list",
    );
    expect(holdIndex).toBeGreaterThan(-1);
    expect(holdIndex).toBeLessThan(discoveryIndex);
    expect(sanitize?.[sanitize.indexOf("--body") + 1]).not.toContain("Closes #10");
  });

  test("ignores an ordinary unlabelled issue graph without delivery metadata", async () => {
    const root = githubIssue(10, "## Context\n\nThis graph is not managed by Sandcastle.", {
      labels: [],
      subIssues: [{ number: 42, state: "OPEN", title: "Issue 42" }],
    });
    await installFakeGithub([root], {});

    const workstreams = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
    );

    expect(workstreams).toEqual([]);
  });

  test("rediscovers an open graph root after its final child was closed", async () => {
    const root = githubIssue(10, validDeliveryBody("feat/recover"), {
      labels: [],
      subIssues: [{ number: 42, state: "CLOSED", title: "Issue 42" }],
      title: "Delivery root",
    });
    const child = githubIssue(42, "<!-- delivery-ticket-key: #10::01 -->", {
      labels: [],
      parent: { number: 10, state: "OPEN", title: "Delivery root" },
      state: "CLOSED",
      stateReason: "COMPLETED",
    });
    await installFakeGithub([root], { 10: root, 42: child });

    const workstreams = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
    );

    expect(workstreams.map(({ root: discoveredRoot }) => discoveredRoot.number)).toEqual([10]);
    expect(workstreams[0]?.tickets.map(({ state }) => state)).toEqual(["CLOSED"]);
  });

  test("continues automatic discovery when one independent root is invalid", async () => {
    const invalid = githubIssue(1, "Missing delivery metadata");
    const valid = githubIssue(2, validDeliveryBody("feat/two"));
    await installFakeGithub([invalid, valid], { 1: invalid, 2: valid });

    const result = await runEffect(
      Effect.gen(function* () {
        const workstreams = yield* discoverWorkstreams(
          deliveryRepository(process.cwd()),
          new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
        );
        const errors = yield* TestConsole.errorLines;
        return { errors, workstreams };
      }).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
    );

    expect(result.workstreams.map(({ root }) => root.number)).toEqual([2]);
    expect(result.errors.some((line) => String(line).includes("Skipping workstream #1"))).toBe(
      true,
    );
  });

  test("propagates a ready candidate process failure even when another root is valid", async () => {
    const unavailable = githubIssue(1, validDeliveryBody("feat/one"));
    const valid = githubIssue(2, validDeliveryBody("feat/two"));
    await installFakeGithub([unavailable, valid], { 2: valid });

    const failure = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(failure._tag).toBe("ProcessError");
  });

  test("propagates a ready candidate decode failure even when another root is valid", async () => {
    const malformed = githubIssue(1, validDeliveryBody("feat/one"));
    const valid = githubIssue(2, validDeliveryBody("feat/two"));
    await installFakeGithub([malformed, valid], {
      1: { ...malformed, number: "not-an-issue-number" },
      2: valid,
    });

    const failure = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(failure._tag).toBe("DecodeError");
  });

  test("fails automatic discovery when every discovered root is invalid", async () => {
    const invalid = githubIssue(1, "Missing delivery metadata");
    await installFakeGithub([invalid], { 1: invalid });

    const result = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("fails when the explicitly selected root is invalid", async () => {
    const invalid = githubIssue(1, "Missing delivery metadata");
    await installFakeGithub([], { 1: invalid });

    const result = await runEffect(
      discoverWorkstreams(
        deliveryRepository(process.cwd()),
        new DeliveryOptions({ concurrency: 2, maxIterations: 1, root: 1 }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });
});
