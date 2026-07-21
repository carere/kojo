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

const graph = (tickets: ReadonlyArray<ReturnType<typeof ticket>>): GitHubDeliveryGraph => ({
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

const githubLayer = (loaded: GitHubDeliveryGraph) =>
  Layer.succeed(GitHubDelivery, {
    isSourceRevisionReachable: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "isSourceRevisionReachable" },
        Effect.succeed(true),
      ) as unknown as Effect.Effect<boolean, GitHubDeliveryFailure>,
    load: (url) =>
      WorkflowTest.call(
        { input: { url }, layer: "GitHub", operation: "loadDeliveryWorkstream" },
        Effect.succeed(loaded),
      ) as unknown as Effect.Effect<unknown, GitHubDeliveryFailure>,
  } satisfies GitHubDeliveryService);

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
  readonly requireConcurrentImplementation?: boolean;
  readonly reviews?: Readonly<Record<number, ReadonlyArray<ReadonlyArray<Finding>>>>;
  readonly slowReviewTicket?: number;
}

const providers = (options: ProviderOptions = {}) => {
  const {
    defectingReviewTicket,
    dirtyAfterChecksTicket,
    failingCheckTicket,
    requireConcurrentImplementation = false,
    reviews = {},
    slowReviewTicket,
  } = options;
  const acquisitions: Array<{ readonly baseBranch?: string; readonly branch: string }> = [];
  const agentPrompts: Array<{ readonly branch: string; readonly prompt: string }> = [];
  const reviewOrdinals = new Map<number, number>();
  const commits = new Map<number, string>();
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
    if (command === "git rev-parse HEAD") return { exitCode: 0, stderr: "", stdout: `${commit}\n` };
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

const run = (loaded: GitHubDeliveryGraph, controlled = providers()) =>
  WorkflowTest.make(Delivery, {
    workflows: [DeliveryTicket],
    layer: Layer.merge(githubLayer(loaded), controlled.layer),
  }).run({ workstream: rootUrl });

describe("Delivery ready frontier implementation", () => {
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
    ]);
    expect(controlled.concurrency.maximum).toBe(2);
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "OpenWork",
        evidence: { frontier: { tickets: [{ number: 43 }, { number: 44 }] } },
        ticketOutcomes: [
          { _tag: "Implemented", reviewAttempts: 1, ticket: { number: 43 } },
          { _tag: "Implemented", reviewAttempts: 1, ticket: { number: 44 } },
        ],
      },
    });
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
            _tag: "Implemented",
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
          { _tag: "Implemented", ticket: { number: 44 } },
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
          { _tag: "Implemented", ticket: { number: 44 } },
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
});
