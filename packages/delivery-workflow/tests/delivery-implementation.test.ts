import { describe, expect, test } from "@effect/vitest";
import {
  AgentProvider,
  type SandboxAgentResult,
  type SandboxExecResult,
  type SandboxHandle,
  SandboxProvider,
  WorkflowTest,
} from "@kojo/workflow";
import { Effect, Layer } from "effect";
import type {
  GitHubDeliveryFailure,
  GitHubDeliveryGraph,
  GitHubDeliveryService,
} from "../src/index";
import { Delivery, DeliveryTicket, GitHubDelivery } from "../src/index";

const sourceRevision = "a".repeat(40);
const rootUrl = "https://github.com/carere/kojo/issues/26";
const delivery = `## Delivery

- Target branch: \`feat/add-delivery-workflow-vertical\`
- Destination branch: \`main\`
- Source revision: \`${sourceRevision}\``;

const completedPullRequestBody = `Delivery route: feat/add-delivery-workflow-vertical -> main
Exact verified target commit: ${sourceRevision}
Verification: moon run :check, moon run :tsc, moon run :test

Closes #26`;

const ticket = (number: number, ordinal: number) => ({
  number,
  title: `Ticket ${number}`,
  body: `<!-- delivery-ticket-key: #26::${String(ordinal).padStart(2, "0")} -->\n\nBuild ticket ${number}.`,
  url: `https://github.com/carere/kojo/issues/${number}`,
  state: "OPEN" as const,
  assignees: [],
  labels: ["ready-for-agent"],
  parent: { number: 26 },
  blockedBy: { totalCount: 0, nodes: [] },
});

const graph = (tickets: GitHubDeliveryGraph["tickets"]): GitHubDeliveryGraph => ({
  root: {
    number: 26,
    title: "Delivery",
    body: delivery,
    url: rootUrl,
    state: "OPEN",
    assignees: [],
    labels: [],
    parent: null,
    children: { totalCount: tickets.length, nodes: tickets.map(({ number }) => ({ number })) },
  },
  tickets,
});

interface GitHubLayerOptions {
  readonly activeMerge?: "Clean" | "OwnedRecovered";
  readonly existingPullRequest?: {
    readonly body: string;
    readonly draft: boolean;
    readonly headCommit?: string;
    readonly owned: boolean;
    readonly title: string;
  };
  readonly failCloseTicket?: number;
  readonly initialRemoteTargetCommit?: string;
  readonly localTargetCommit?: string;
  readonly ownedRecoveryRefs?: ReadonlyArray<string>;
  readonly rootState?: "OPEN" | "CLOSED";
  readonly sandboxCleanup?: "Clean" | "OwnedCleaned";
  readonly unownedDirtyState?: boolean;
  readonly upsertState?: "Created" | "Updated" | "AlreadyApplied";
}

const githubLayer = (
  loaded: GitHubDeliveryGraph,
  reloaded = loaded,
  options: GitHubLayerOptions = {},
) => {
  let remoteTargetCommit = options.initialRemoteTargetCommit ?? sourceRevision;
  const closed = new Set<number>();
  let pullRequest:
    | {
        readonly body: string;
        readonly destinationBranch: string;
        readonly draft: boolean;
        readonly headCommit: string;
        readonly number: number;
        readonly owned: boolean;
        readonly targetBranch: string;
        readonly title: string;
        readonly url: string;
      }
    | undefined =
    options.existingPullRequest === undefined
      ? undefined
      : {
          body: options.existingPullRequest.body,
          destinationBranch: "main",
          draft: options.existingPullRequest.draft,
          headCommit: options.existingPullRequest.headCommit ?? remoteTargetCommit,
          number: 101,
          owned: options.existingPullRequest.owned,
          targetBranch: "feat/add-delivery-workflow-vertical",
          title: options.existingPullRequest.title,
          url: "https://github.com/carere/kojo/pull/101",
        };
  let loads = 0;
  return Layer.succeed(GitHubDelivery, {
    closeTicket: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "closeTicket" },
        Effect.suspend(() =>
          input.ticketNumber === options.failCloseTicket
            ? Effect.fail({
                _tag: "GitHubDeliveryFailure" as const,
                message: "close failed",
                operation: "closeTicket",
              })
            : Effect.sync(() => {
                closed.add(input.ticketNumber);
                return {
                  idempotencyKey: input.idempotencyKey,
                  state: "Applied" as const,
                  targetCommit: input.targetCommit,
                };
              }),
        ),
      ) as unknown as ReturnType<GitHubDeliveryService["closeTicket"]>,
    isSourceRevisionReachable: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "isSourceRevisionReachable" },
        Effect.succeed(true),
      ) as unknown as Effect.Effect<boolean, GitHubDeliveryFailure>,
    load: (url) =>
      WorkflowTest.call(
        { input: { url }, layer: "GitHub", operation: "loadDeliveryWorkstream" },
        Effect.sync(() => (loads++ === 0 ? loaded : reloaded)),
      ) as unknown as Effect.Effect<unknown, GitHubDeliveryFailure>,
    pushExact: (input) =>
      WorkflowTest.call(
        { input, layer: "Git", operation: "pushExact" },
        Effect.sync(() => {
          if (remoteTargetCommit !== input.expectedTargetCommit)
            throw new Error("unexpected target");
          remoteTargetCommit = input.targetCommit;
          return {
            idempotencyKey: input.idempotencyKey,
            state: "Applied" as const,
            targetCommit: input.targetCommit,
          };
        }),
      ) as unknown as ReturnType<GitHubDeliveryService["pushExact"]>,
    readPublication: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: `readPublication:${input.checkpoint}` },
        Effect.sync(() => ({
          remoteTargetCommit,
          ticketState: closed.has(input.ticketNumber) ? ("CLOSED" as const) : ("OPEN" as const),
        })),
      ) as unknown as ReturnType<GitHubDeliveryService["readPublication"]>,
    reconcileFinalization: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: `reconcileFinalization:${input.checkpoint}` },
        Effect.sync(() => ({
          activeMerge: options.activeMerge ?? ("Clean" as const),
          localTargetCommit: options.localTargetCommit ?? remoteTargetCommit,
          ownedRecoveryRefs: options.ownedRecoveryRefs ?? [],
          publicationProgress:
            pullRequest === undefined
              ? ("TicketsPublished" as const)
              : ("DraftPullRequestApplied" as const),
          pullRequests: pullRequest === undefined ? [] : [pullRequest],
          remoteTargetCommit,
          rootState: options.rootState ?? ("OPEN" as const),
          sandboxCleanup: options.sandboxCleanup ?? ("Clean" as const),
          ticketMutations: "Reconciled" as const,
          unownedDirtyState: options.unownedDirtyState ?? false,
        })),
      ) as unknown as ReturnType<GitHubDeliveryService["reconcileFinalization"]>,
    upsertDraftPullRequest: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "upsertDraftPullRequest" },
        Effect.sync(() => {
          pullRequest = {
            body: input.body,
            destinationBranch: input.destinationBranch,
            draft: true,
            headCommit: input.targetCommit,
            number: 101,
            owned: true,
            targetBranch: input.targetBranch,
            title: input.title,
            url: "https://github.com/carere/kojo/pull/101",
          };
          return {
            body: input.body,
            draft: true as const,
            idempotencyKey: input.idempotencyKey,
            number: pullRequest.number,
            state: options.upsertState ?? ("Created" as const),
            targetCommit: input.targetCommit,
            title: input.title,
            url: pullRequest.url,
          };
        }),
      ) as unknown as ReturnType<GitHubDeliveryService["upsertDraftPullRequest"]>,
  } satisfies GitHubDeliveryService);
};

interface Finding {
  readonly id: string;
  readonly priority: "P1" | "P2" | "P3";
  readonly summary: string;
  readonly detail: string;
}

interface ProviderOptions {
  readonly defectingReviewTicket?: number;
  readonly dirtyAfterChecksTicket?: number;
  readonly failingCheckTicket?: number;
  readonly mergeConflictTicket?: number;
  readonly pullRequestDraft?: unknown;
  readonly requireConcurrentImplementation?: boolean;
  readonly reviews?: Readonly<Record<number, ReadonlyArray<ReadonlyArray<Finding>>>>;
  readonly slowReviewTicket?: number;
}

const providers = (options: ProviderOptions = {}) => {
  const {
    defectingReviewTicket,
    dirtyAfterChecksTicket,
    failingCheckTicket,
    mergeConflictTicket,
    pullRequestDraft,
    requireConcurrentImplementation = false,
    reviews = {},
    slowReviewTicket,
  } = options;
  const acquisitions: Array<{ readonly baseBranch?: string; readonly branch: string }> = [];
  const agentPrompts: Array<{ readonly branch: string; readonly prompt: string }> = [];
  const reviewOrdinals = new Map<number, number>();
  const commits = new Map<number, string>();
  const heads = new Map<string, string>();
  const parents = new Map<string, string>();
  const completedChecks = new Set<number>();
  const concurrency = { active: 0, maximum: 0 };
  let releaseImplementers: (() => void) | undefined;
  const bothImplementersStarted = new Promise<void>((resolve) => {
    releaseImplementers = resolve;
  });

  const commandResult = (branch: string, command: string): SandboxExecResult => {
    const number = Number(branch.split("-").at(-1));
    const commit = commits.get(number) ?? String(number).padStart(40, "b").slice(-40);
    commits.set(number, commit);
    const head = heads.get(branch) ?? commit;
    if (command === "git rev-parse HEAD") return { exitCode: 0, stderr: "", stdout: `${head}\n` };
    if (command.startsWith("git merge --no-ff --no-edit ")) {
      if (number === mergeConflictTicket) {
        parents.set(branch, `${head} ${commit}`);
        return { exitCode: 1, stderr: "merge conflict", stdout: "" };
      }
      const integrated = `${number.toString(16).padStart(40, "c")}`.slice(-40);
      parents.set(branch, `${head} ${commit}`);
      heads.set(branch, integrated);
      return { exitCode: 0, stderr: "", stdout: "merged" };
    }
    if (command === "git show -s --format=%P HEAD") {
      return { exitCode: 0, stderr: "", stdout: `${parents.get(branch) ?? ""}\n` };
    }
    if (command.startsWith("git merge-base --is-ancestor ")) {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command.startsWith("git diff --quiet ")) {
      return { exitCode: 1, stderr: "", stdout: "" };
    }
    if (command === "git status --porcelain") {
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          number === dirtyAfterChecksTicket && completedChecks.has(number)
            ? " M generated.ts\n"
            : "",
      };
    }
    if (command.startsWith("git diff --binary ")) {
      return { exitCode: 0, stderr: "", stdout: `diff for ticket ${number}` };
    }
    if (["moon run :check", "moon run :tsc", "moon run :test"].includes(command)) {
      if (command === "moon run :check" && number === failingCheckTicket) {
        return { exitCode: 1, stderr: "check failed", stdout: "" };
      }
      if (command === "moon run :test") completedChecks.add(number);
      return { exitCode: 0, stderr: "", stdout: `${command} passed` };
    }
    return { exitCode: 127, stderr: `unexpected command: ${command}`, stdout: "" };
  };

  const handle = (branch: string): SandboxHandle => ({
    branch,
    close: async () => ({}),
    exec: async (command) => commandResult(branch, command),
    run: async ({ prompt }): Promise<SandboxAgentResult> => {
      const number = Number(branch.split("-").at(-1));
      agentPrompts.push({ branch, prompt });
      if (prompt.startsWith("Author the draft pull request")) {
        return {
          commits: [],
          stdout: "authored pull request",
          output: {
            _tag: "Success",
            value: pullRequestDraft ?? {
              body: prompt,
              title: "feat(delivery): complete verified workstream",
            },
          },
        };
      }
      if (prompt.startsWith("Repair the active merge conflict")) {
        heads.set(branch, `${number.toString(16).padStart(40, "c")}`.slice(-40));
      }
      if (prompt.includes("mechanically read-only reviewer")) {
        const ordinal = (reviewOrdinals.get(number) ?? 0) + 1;
        reviewOrdinals.set(number, ordinal);
        if (number === slowReviewTicket) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (number === defectingReviewTicket) {
          return {
            commits: [],
            stdout: "reviewed",
            output: { invalid: "review result" },
          };
        }
        return {
          commits: [],
          stdout: "reviewed",
          output: {
            _tag: "Success",
            value: { findings: reviews[number]?.[ordinal - 1] ?? [] },
          },
        };
      }
      if (
        requireConcurrentImplementation &&
        prompt.includes("There are no prior review findings.")
      ) {
        concurrency.active += 1;
        concurrency.maximum = Math.max(concurrency.maximum, concurrency.active);
        if (concurrency.active === 2) releaseImplementers?.();
        await bothImplementersStarted;
        concurrency.active -= 1;
      }
      const ids = [
        ...new Set([...prompt.matchAll(/^Finding ([^:]+):/gm)].map((match) => match[1])),
      ];
      return {
        commits: [{ sha: commits.get(number) ?? String(number).padStart(40, "b").slice(-40) }],
        stdout: "implemented",
        output: {
          _tag: "Success",
          value: {
            dispositions: ids.map((findingId) => ({
              findingId,
              disposition: "Addressed",
              summary: `Repaired ${findingId}`,
            })),
            summary: `Implemented ticket ${number}`,
          },
        },
      };
    },
  });

  const sandbox = Layer.succeed(SandboxProvider, {
    configuration: {
      adapterVersion: "test-1",
      configurationFingerprint: "sandbox-test",
      name: "controlled-sandbox",
      publicFields: {},
    },
    create: (options) =>
      Effect.sync(() => {
        acquisitions.push(options);
        if (options.baseBranch !== undefined) heads.set(options.branch, options.baseBranch);
        if (options.branch.startsWith("kojo-delivery-ticket-"))
          heads.set(
            options.branch,
            commits.get(Number(options.branch.split("-").at(-1))) ??
              String(Number(options.branch.split("-").at(-1)))
                .padStart(40, "b")
                .slice(-40),
          );
        return handle(options.branch);
      }),
  });
  const agent = Layer.succeed(AgentProvider, {
    agent: {},
    configuration: {
      adapterVersion: "test-1",
      configurationFingerprint: "agent-test",
      model: "controlled",
      name: "controlled-agent",
      publicFields: {},
    },
  });

  return { acquisitions, agentPrompts, concurrency, layer: Layer.merge(sandbox, agent) };
};

const run = (
  loaded: GitHubDeliveryGraph,
  controlled = providers(),
  reloaded: GitHubDeliveryGraph = loaded,
  githubOptions: GitHubLayerOptions = {},
) =>
  WorkflowTest.make(Delivery, {
    workflows: [DeliveryTicket],
    layer: Layer.merge(githubLayer(loaded, reloaded, githubOptions), controlled.layer),
  }).run({ workstream: rootUrl });

const fixture = (
  loaded: GitHubDeliveryGraph,
  controlled = providers(),
  reloaded: GitHubDeliveryGraph = loaded,
  githubOptions: GitHubLayerOptions = {},
) => ({
  controlled,
  workflow: WorkflowTest.make(Delivery, {
    workflows: [DeliveryTicket],
    layer: Layer.merge(githubLayer(loaded, reloaded, githubOptions), controlled.layer),
  }),
});

describe("Delivery ready frontier implementation", () => {
  test("finalizes an already handled workstream from one fresh exact-target Sandbox", async () => {
    const controlled = providers();
    const completedTicket = { ...ticket(43, 1), state: "CLOSED" as const };
    const result = await run(graph([completedTicket]), controlled);

    expect(result.state).toBe("Completed");
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "CompletedWorkstream",
        finalization: {
          pullRequestReceipt: {
            draft: true,
            state: "Created",
            targetCommit: sourceRevision,
          },
          pushReceipt: { state: "AlreadyApplied", targetCommit: sourceRevision },
          recovery: {
            activeMerge: "Clean",
            publicationProgress: "DraftPullRequestApplied",
            sandboxCleanup: "Clean",
            ticketMutations: "Reconciled",
          },
          verificationCommands: ["moon run :check", "moon run :tsc", "moon run :test"],
          verifiedCommit: sourceRevision,
        },
      },
    });
    expect(controlled.acquisitions).toContainEqual({
      baseBranch: sourceRevision,
      branch: "kojo-delivery-final-verify-26",
    });
    const mutation = result.calls.find(({ operation }) => operation === "upsertDraftPullRequest");
    expect(mutation?.input).toMatchObject({
      destinationBranch: "main",
      rootNumber: 26,
      targetBranch: "feat/add-delivery-workflow-vertical",
      targetCommit: sourceRevision,
      title: "feat(delivery): complete verified workstream",
    });
    expect((mutation?.input as { readonly body?: string } | undefined)?.body).toContain(
      "Closes #26",
    );
  });

  test("reports AlreadyComplete when final target and draft mutation were already applied", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const result = await run(completed, providers(), completed, {
      existingPullRequest: {
        body: completedPullRequestBody,
        draft: true,
        owned: true,
        title: "feat(delivery): complete verified workstream",
      },
    });

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "AlreadyComplete",
        finalization: {
          pullRequestReceipt: { state: "AlreadyApplied" },
          pushReceipt: { state: "AlreadyApplied" },
        },
      },
    });
    expect(result.calls.filter(({ layer }) => layer === "Agent")).toEqual([]);
    expect(result.calls.filter(({ operation }) => operation === "upsertDraftPullRequest")).toEqual(
      [],
    );
  });

  test("updates one owned draft pull request when its validated content is stale", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const result = await run(completed, providers(), completed, {
      existingPullRequest: {
        body: "Stale delivery evidence\n\nCloses #26",
        draft: true,
        owned: true,
        title: "feat(delivery): stale workstream",
      },
      upsertState: "Updated",
    });

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "CompletedWorkstream",
        finalization: { pullRequestReceipt: { number: 101, state: "Updated" } },
      },
    });
    expect(
      result.calls.filter(({ operation }) => operation === "upsertDraftPullRequest"),
    ).toHaveLength(1);
  });

  test("rejects malformed or mechanically invalid Agent-authored pull-request content", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const invalidDrafts = [
      {
        expectedCheck: "pull-request-title",
        value: { body: completedPullRequestBody, title: "Complete the workstream" },
      },
      {
        expectedCheck: "pull-request-evidence",
        value: {
          body: "Delivery is complete.\n\nCloses #26",
          title: "feat(delivery): complete verified workstream",
        },
      },
      {
        expectedCheck: undefined,
        value: { title: "feat(delivery): complete verified workstream" },
      },
      {
        expectedCheck: "pull-request-title",
        value: {
          body: completedPullRequestBody,
          title: "feat(delivery): complete verified workstream\nUnexpected second line",
        },
      },
      {
        expectedCheck: "pull-request-closure",
        value: {
          body: completedPullRequestBody.replace("Closes #26", "Fixes #26"),
          title: "feat(delivery): complete verified workstream",
        },
      },
    ];

    for (const { expectedCheck, value } of invalidDrafts) {
      const result = await run(completed, providers({ pullRequestDraft: value }));

      if (expectedCheck === undefined) {
        expect(result.outcome._tag).toBe("Defect");
      } else {
        expect(result.outcome._tag).toBe("Failure");
        expect(result.outcome).toMatchObject({
          failure: {
            _tag: "FinalizationFailed",
            failure: { _tag: "Delivery.TicketProofFailure", check: expectedCheck },
          },
        });
      }
      expect(
        result.calls.filter(({ operation }) => operation === "upsertDraftPullRequest"),
      ).toEqual([]);
    }
  });

  test("recovers without repeating an exact final push after interruption", async () => {
    const finalCommit = "d".repeat(40);
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const { workflow } = fixture(completed, providers(), completed, {
      localTargetCommit: finalCommit,
    });

    const interrupted = await workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "Git.pushExact", type: "ExternalCall.Completed" } },
    );
    const restarted = await workflow.restart();

    expect(interrupted.state).toBe("Interrupted");
    expect(restarted).toMatchObject({
      attempt: 2,
      outcome: {
        _tag: "Success",
        value: {
          _tag: "CompletedWorkstream",
          finalization: {
            pushReceipt: { targetCommit: finalCommit },
            verifiedCommit: finalCommit,
          },
        },
      },
      state: "Completed",
    });
    expect(
      restarted.calls.filter(
        ({ layer, operation }) => layer === "Git" && operation === "pushExact",
      ),
    ).toHaveLength(1);
  });

  test("recovers interruption before an exact final push and performs it once", async () => {
    const finalCommit = "d".repeat(40);
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const { workflow } = fixture(completed, providers(), completed, {
      localTargetCommit: finalCommit,
    });

    const interrupted = await workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "Git.pushExact", type: "ExternalCall.Started" } },
    );
    const restarted = await workflow.restart();

    expect(interrupted.state).toBe("Interrupted");
    expect(interrupted.calls.filter(({ operation }) => operation === "pushExact")).toEqual([]);
    expect(restarted).toMatchObject({
      attempt: 2,
      outcome: {
        _tag: "Success",
        value: {
          finalization: {
            pushReceipt: { state: "Applied", targetCommit: finalCommit },
            verifiedCommit: finalCommit,
          },
        },
      },
      state: "Completed",
    });
    expect(restarted.calls.filter(({ operation }) => operation === "pushExact")).toHaveLength(1);
  });

  test("recovers interruption before and after isolated final verification", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const beforeFixture = fixture(completed);
    const before = await beforeFixture.workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "final-verify-26", type: "Sandbox.Opened" } },
    );
    const afterBeforeRecovery = await beforeFixture.workflow.restart();

    expect(before.state).toBe("Interrupted");
    expect(afterBeforeRecovery.state).toBe("Completed");
    expect(afterBeforeRecovery.outcome).toMatchObject({
      _tag: "Success",
      value: { finalization: { verifiedCommit: sourceRevision } },
    });

    const afterFixture = fixture(completed);
    const after = await afterFixture.workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "final-verify-26", type: "Sandbox.Cleaned" } },
    );
    const afterVerificationRecovery = await afterFixture.workflow.restart();

    expect(after.state).toBe("Interrupted");
    expect(afterVerificationRecovery.state).toBe("Completed");
    expect(
      afterVerificationRecovery.calls.filter(
        ({ operation }) => operation === "upsertDraftPullRequest",
      ),
    ).toHaveLength(1);
  });

  test("recovers ticket closure and draft pull-request mutation without repeating either effect", async () => {
    const loaded = graph([ticket(43, 1)]);
    const ticketFixture = fixture(loaded);
    const interruptedClosure = await ticketFixture.workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "GitHub.closeTicket", type: "ExternalCall.Completed" } },
    );
    const completedAfterClosure = await ticketFixture.workflow.restart();

    expect(interruptedClosure.state).toBe("Interrupted");
    expect(completedAfterClosure.state).toBe("Completed");
    expect(
      completedAfterClosure.calls.filter(({ operation }) => operation === "closeTicket"),
    ).toHaveLength(1);

    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const pullRequestFixture = fixture(completed);
    const interruptedPullRequest = await pullRequestFixture.workflow.run(
      { workstream: rootUrl },
      {
        interruptAfter: {
          subject: "GitHub.upsertDraftPullRequest",
          type: "ExternalCall.Completed",
        },
      },
    );
    const completedAfterPullRequest = await pullRequestFixture.workflow.restart();

    expect(interruptedPullRequest.state).toBe("Interrupted");
    expect(completedAfterPullRequest).toMatchObject({
      outcome: {
        _tag: "Success",
        value: {
          finalization: {
            pullRequestReceipt: { draft: true, state: "Created" },
          },
        },
      },
      state: "Completed",
    });
    expect(
      completedAfterPullRequest.calls.filter(
        ({ operation }) => operation === "upsertDraftPullRequest",
      ),
    ).toHaveLength(1);
  });

  test("recovers before ticket closure and draft pull-request mutation", async () => {
    const loaded = graph([ticket(43, 1)]);
    const closureFixture = fixture(loaded);
    const beforeClosure = await closureFixture.workflow.run(
      { workstream: rootUrl },
      { interruptAfter: { subject: "GitHub.closeTicket", type: "ExternalCall.Started" } },
    );
    const completedAfterClosure = await closureFixture.workflow.restart();

    expect(beforeClosure.state).toBe("Interrupted");
    expect(beforeClosure.calls.filter(({ operation }) => operation === "closeTicket")).toEqual([]);
    expect(completedAfterClosure.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "CompletedWorkstream",
        ticketOutcomes: [
          {
            _tag: "Published",
            closeReceipt: { state: "Applied" },
            reviewAttempts: 1,
            ticket: { number: 43 },
          },
        ],
      },
    });
    expect(
      completedAfterClosure.calls.filter(({ operation }) => operation === "closeTicket"),
    ).toHaveLength(1);

    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const pullRequestFixture = fixture(completed);
    const beforePullRequest = await pullRequestFixture.workflow.run(
      { workstream: rootUrl },
      {
        interruptAfter: {
          subject: "GitHub.upsertDraftPullRequest",
          type: "ExternalCall.Started",
        },
      },
    );
    const completedAfterPullRequest = await pullRequestFixture.workflow.restart();

    expect(beforePullRequest.state).toBe("Interrupted");
    expect(
      beforePullRequest.calls.filter(({ operation }) => operation === "upsertDraftPullRequest"),
    ).toEqual([]);
    expect(completedAfterPullRequest.outcome).toMatchObject({
      _tag: "Success",
      value: {
        finalization: {
          pullRequestReceipt: { draft: true, state: "Created", targetCommit: sourceRevision },
          recovery: { publicationProgress: "DraftPullRequestApplied" },
        },
      },
    });
    expect(
      completedAfterPullRequest.calls.filter(
        ({ operation }) => operation === "upsertDraftPullRequest",
      ),
    ).toHaveLength(1);
  });

  test("preserves and escalates unowned dirty finalization state", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const result = await run(completed, providers(), completed, { unownedDirtyState: true });

    expect(result).toMatchObject({
      outcome: {
        _tag: "Failure",
        failure: {
          _tag: "FinalizationFailed",
          failure: {
            _tag: "Delivery.TicketProofFailure",
            check: "finalization-recovery-ownership",
          },
        },
      },
      state: "Failed",
    });
    expect(result.calls.filter(({ operation }) => operation === "pushExact")).toEqual([]);
    expect(result.calls.filter(({ operation }) => operation === "upsertDraftPullRequest")).toEqual(
      [],
    );
  });

  test("preserves a closed root and a non-draft route collision for human handling", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const closedRoot = await run(completed, providers(), completed, { rootState: "CLOSED" });
    const readyPullRequest = await run(completed, providers(), completed, {
      existingPullRequest: {
        body: completedPullRequestBody,
        draft: false,
        owned: true,
        title: "feat(delivery): complete verified workstream",
      },
    });

    expect(closedRoot.outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "FinalizationFailed",
        failure: { check: "finalization-root-state" },
      },
    });
    expect(readyPullRequest.outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "FinalizationFailed",
        failure: { check: "pull-request-ownership" },
      },
    });
    for (const result of [closedRoot, readyPullRequest]) {
      expect(result.calls.filter(({ operation }) => operation === "pushExact")).toEqual([]);
      expect(
        result.calls.filter(({ operation }) => operation === "upsertDraftPullRequest"),
      ).toEqual([]);
    }
  });

  test("retains receipts for demonstrably owned merge, recovery-ref, and Sandbox cleanup", async () => {
    const completed = graph([{ ...ticket(43, 1), state: "CLOSED" as const }]);
    const result = await run(completed, providers(), completed, {
      activeMerge: "OwnedRecovered",
      ownedRecoveryRefs: ["refs/kojo/delivery/26/recovery-1"],
      sandboxCleanup: "OwnedCleaned",
    });

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        finalization: {
          recovery: {
            activeMerge: "OwnedRecovered",
            ownedRecoveryRefs: ["refs/kojo/delivery/26/recovery-1"],
            sandboxCleanup: "OwnedCleaned",
          },
        },
      },
    });
  });

  test("selects two tickets in stable order and runs each as an isolated Child Workflow", async () => {
    const controlled = providers({ requireConcurrentImplementation: true });
    const result = await run(graph([ticket(45, 3), ticket(43, 1), ticket(44, 2)]), controlled);

    expect(result.state).toBe("Completed");
    expect(
      result.children.map(({ input, workflowName }) => ({ input, workflowName })),
    ).toMatchObject([
      { input: { ticket: { number: 43 } }, workflowName: "delivery-ticket" },
      { input: { ticket: { number: 44 } }, workflowName: "delivery-ticket" },
    ]);
    expect(controlled.acquisitions).toEqual([
      { baseBranch: sourceRevision, branch: "kojo-delivery-ticket-43" },
      { baseBranch: sourceRevision, branch: "kojo-delivery-ticket-44" },
      { baseBranch: sourceRevision, branch: "kojo-delivery-integration-43" },
      { baseBranch: "cccccccccccccccccccccccccccccccccccccc2b", branch: "kojo-delivery-verify-43" },
      {
        baseBranch: "cccccccccccccccccccccccccccccccccccccc2b",
        branch: "kojo-delivery-integration-44",
      },
      { baseBranch: "cccccccccccccccccccccccccccccccccccccc2c", branch: "kojo-delivery-verify-44" },
    ]);
    expect(controlled.concurrency.maximum).toBe(2);
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "OpenWork",
        evidence: { frontier: { tickets: [{ number: 43 }, { number: 44 }] } },
        ticketOutcomes: [
          { _tag: "Published", reviewAttempts: 1, ticket: { number: 43 } },
          { _tag: "Published", reviewAttempts: 1, ticket: { number: 44 } },
        ],
      },
    });
    expect(
      result.calls.filter(({ operation }) => operation === "pushExact").map(({ input }) => input),
    ).toEqual([
      {
        expectedTargetCommit: sourceRevision,
        idempotencyKey: "#26::01:push:cccccccccccccccccccccccccccccccccccccc2b",
        repository: "carere/kojo",
        targetBranch: "feat/add-delivery-workflow-vertical",
        targetCommit: "cccccccccccccccccccccccccccccccccccccc2b",
      },
      {
        expectedTargetCommit: "cccccccccccccccccccccccccccccccccccccc2b",
        idempotencyKey: "#26::02:push:cccccccccccccccccccccccccccccccccccccc2c",
        repository: "carere/kojo",
        targetBranch: "feat/add-delivery-workflow-vertical",
        targetCommit: "cccccccccccccccccccccccccccccccccccccc2c",
      },
    ]);
    for (const child of result.children) {
      const commands = child.evidence
        .filter(({ type }) => type === "Command.OutputArtifactsRecorded")
        .map(({ details }) => (details as { readonly command: string }).command);
      expect(commands).toEqual([
        "git rev-parse HEAD",
        `git merge-base --is-ancestor ${sourceRevision} HEAD`,
        `git diff --quiet ${sourceRevision} HEAD`,
        "git status --porcelain",
        "moon run :check",
        "moon run :tsc",
        "moon run :test",
        "git status --porcelain",
        `git diff --binary ${sourceRevision}...HEAD`,
        "git rev-parse HEAD",
        "git status --porcelain",
      ]);
    }
  });

  test("routes every structured finding and its history back to the implementer", async () => {
    const finding = {
      id: "review-1",
      priority: "P2" as const,
      summary: "Missing guard",
      detail: "The cumulative diff needs a guard.",
    };
    const controlled = providers({ reviews: { 43: [[finding], []] } });
    const result = await run(graph([ticket(43, 1)]), controlled);

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        ticketOutcomes: [
          {
            _tag: "Published",
            findingHistory: [
              {
                attempt: 1,
                dispositions: [{ disposition: "Addressed", findingId: "review-1" }],
                findings: [finding],
              },
              { attempt: 2, dispositions: [], findings: [] },
            ],
            reviewAttempts: 2,
          },
        ],
      },
    });
    const repair = controlled.agentPrompts.find(({ prompt }) =>
      prompt.includes("Finding review-1:"),
    );
    expect(repair?.prompt).toContain("P2 Missing guard");
    expect(repair?.prompt).toContain("The cumulative diff needs a guard.");
  });

  test("lets an already-started sibling settle when another ticket fails", async () => {
    const result = await run(
      graph([ticket(43, 1), ticket(44, 2)]),
      providers({ failingCheckTicket: 43 }),
    );

    expect(result.state).toBe("Completed");
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: { _tag: "Delivery.TicketProofFailure", check: "check" },
            ticket: { number: 43 },
          },
          { _tag: "Published", ticket: { number: 44 } },
        ],
      },
    });
    expect(result.children).toMatchObject([
      { state: "Failed" },
      { outcome: { _tag: "Success", value: { _tag: "Implemented" } }, state: "Completed" },
    ]);
  });

  test("rejects a worktree dirtied by a successful configured command", async () => {
    const result = await run(graph([ticket(43, 1)]), providers({ dirtyAfterChecksTicket: 43 }));

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: {
              _tag: "Delivery.TicketProofFailure",
              check: "post-check-clean-worktree",
            },
            ticket: { number: 43 },
          },
        ],
      },
    });
  });

  test("settles an already-started sibling when a ticket defects", async () => {
    const controlled = providers({
      defectingReviewTicket: 43,
      requireConcurrentImplementation: true,
      slowReviewTicket: 44,
    });
    const result = await run(graph([ticket(43, 1), ticket(44, 2)]), controlled);

    expect(result.state).toBe("Completed");
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: { _tag: "Delivery.TicketDefect" },
            ticket: { number: 43 },
          },
          { _tag: "Published", ticket: { number: 44 } },
        ],
      },
    });
    expect(result.children).toMatchObject([
      { outcome: { _tag: "Defect" }, state: "Failed" },
      { outcome: { _tag: "Success", value: { _tag: "Implemented" } }, state: "Completed" },
    ]);
  });

  test("returns ReviewLimitReached with retained history after three Reviewer Steps", async () => {
    const findings = [1, 2, 3].map((ordinal) => [
      {
        id: `review-${ordinal}`,
        priority: "P3" as const,
        summary: `Finding ${ordinal}`,
        detail: `Detail ${ordinal}`,
      },
    ]);
    const result = await run(graph([ticket(43, 1)]), providers({ reviews: { 43: findings } }));

    expect(result.state).toBe("Completed");
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        ticketOutcomes: [
          {
            _tag: "ReviewLimitReached",
            failure: {
              _tag: "Loop.MaximumLimitReached",
              maxIterations: 3,
              name: "review",
            },
            findingHistory: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
            reviewAttempts: 3,
          },
        ],
      },
    });
  });

  test("repairs a merge conflict without changing either parent, reviews it, and verifies freshly", async () => {
    const integrationFinding = {
      id: "integration-1",
      priority: "P1" as const,
      summary: "Repair needs adjustment",
      detail: "Keep the accepted merge parents while adjusting the resolution.",
    };
    const controlled = providers({
      mergeConflictTicket: 43,
      reviews: { 43: [[], [integrationFinding], []] },
    });
    const result = await run(graph([ticket(43, 1)]), controlled);

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "CompletedWorkstream",
        ticketOutcomes: [
          {
            _tag: "Published",
            mergeParents: [sourceRevision, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb43"],
            repairedConflict: true,
            repairReviewAttempts: 2,
            ticket: { number: 43 },
          },
        ],
      },
    });
    expect(controlled.acquisitions).toContainEqual({
      baseBranch: "cccccccccccccccccccccccccccccccccccccc2b",
      branch: "kojo-delivery-verify-43",
    });
    expect(controlled.acquisitions.at(-1)).toEqual({
      baseBranch: "cccccccccccccccccccccccccccccccccccccc2b",
      branch: "kojo-delivery-final-verify-26",
    });
    expect(
      controlled.agentPrompts.some(({ prompt }) =>
        prompt.includes(`accepted target base must remain ${sourceRevision}`),
      ),
    ).toBe(true);
  });

  test("refuses push and close when the ticket specification drifts after review", async () => {
    const loaded = graph([ticket(43, 1)]);
    const drifted = graph([
      { ...ticket(43, 1), body: `${ticket(43, 1).body}\n\nChanged after review.` },
    ]);
    const result = await run(loaded, providers(), drifted);

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "TicketsFailed",
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: { _tag: "Delivery.TicketProofFailure", check: "publication-drift" },
            ticket: { number: 43 },
          },
        ],
      },
    });
    expect(result.calls.filter(({ operation }) => operation === "pushExact")).toEqual([]);
    expect(result.calls.filter(({ operation }) => operation === "closeTicket")).toEqual([]);
  });

  test("refuses publication when a reviewed ticket's blocker state drifts", async () => {
    const blocker = {
      ...ticket(42, 1),
      state: "CLOSED" as const,
    };
    const dependent = {
      ...ticket(43, 2),
      blockedBy: { totalCount: 1, nodes: [{ number: 42, state: "CLOSED" as const }] },
    };
    const loaded = graph([blocker, dependent]);
    const reloaded = graph([
      { ...blocker, state: "OPEN" as const },
      {
        ...dependent,
        blockedBy: { totalCount: 1, nodes: [{ number: 42, state: "OPEN" as const }] },
      },
    ]);
    const result = await run(loaded, providers(), reloaded);

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "TicketsFailed",
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: { _tag: "Delivery.TicketProofFailure", check: "publication-drift" },
            ticket: { number: 43 },
          },
        ],
      },
    });
    expect(result.calls.filter(({ operation }) => operation === "pushExact")).toEqual([]);
    expect(result.calls.filter(({ operation }) => operation === "closeTicket")).toEqual([]);
  });

  test("continues serial publication from a reconciled push when ticket closure fails", async () => {
    const loaded = graph([ticket(43, 1), ticket(44, 2)]);
    const result = await run(loaded, providers(), loaded, { failCloseTicket: 43 });

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "TicketsFailed",
        ticketOutcomes: [
          {
            _tag: "TicketFailed",
            failure: { _tag: "GitHubDeliveryFailure", operation: "closeTicket" },
            progress: {
              integratedCommit: "cccccccccccccccccccccccccccccccccccccc2b",
              publication: {
                remoteTargetCommit: "cccccccccccccccccccccccccccccccccccccc2b",
                ticketState: "OPEN",
              },
              verifiedCommit: "cccccccccccccccccccccccccccccccccccccc2b",
            },
            ticket: { number: 43 },
          },
          { _tag: "Published", ticket: { number: 44 } },
        ],
      },
    });
    expect(
      result.calls.filter(({ operation }) => operation === "pushExact").map(({ input }) => input),
    ).toMatchObject([
      { expectedTargetCommit: sourceRevision },
      { expectedTargetCommit: "cccccccccccccccccccccccccccccccccccccc2b" },
    ]);
  });
});
