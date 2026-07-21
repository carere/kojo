import { describe, expect, test } from "@effect/vitest";
import { AgentProvider, SandboxProvider, WorkflowTest } from "@kojo/workflow";
import { Effect, Layer } from "effect";
import type {
  GitHubDeliveryFailure,
  GitHubDeliveryGraph,
  GitHubDeliveryService,
} from "../src/index";
import { Delivery, DeliveryTicket, GitHubDelivery } from "../src/index";

const revision = "a".repeat(40);
const rootUrl = "https://github.com/carere/kojo/issues/26";
const delivery = `## Delivery

- Target branch: \`feat/add-delivery-workflow-vertical\`
- Destination branch: \`main\`
- Source revision: \`${revision}\`

## Problem Statement

Build the vertical.`;

const ticket = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Load and validate a GitHub Delivery Workstream",
  body: "<!-- delivery-ticket-key: #26::16 -->\n\nBuild it.",
  url: "https://github.com/carere/kojo/issues/42",
  state: "OPEN" as const,
  assignees: [],
  labels: ["ready-for-agent"],
  parent: { number: 26 },
  blockedBy: { totalCount: 0, nodes: [] },
  ...overrides,
});

const graph = (overrides: Partial<GitHubDeliveryGraph> = {}): GitHubDeliveryGraph => ({
  root: {
    number: 26,
    title: "Delivery: Kojo vertical",
    body: delivery,
    url: rootUrl,
    state: "OPEN",
    assignees: [],
    labels: [],
    parent: null,
    children: { totalCount: 1, nodes: [{ number: 42 }] },
  },
  tickets: [ticket()],
  ...overrides,
});

const githubLayer = (loaded: GitHubDeliveryGraph, reachable = true) =>
  Layer.succeed(GitHubDelivery, {
    closeTicket: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "closeTicket" },
        Effect.succeed({
          idempotencyKey: input.idempotencyKey,
          state: "Applied" as const,
          targetCommit: input.targetCommit,
        }),
      ) as unknown as ReturnType<GitHubDeliveryService["closeTicket"]>,
    isSourceRevisionReachable: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "isSourceRevisionReachable" },
        Effect.succeed(reachable),
      ) as unknown as Effect.Effect<boolean, GitHubDeliveryFailure>,
    load: (url) =>
      WorkflowTest.call(
        { input: { url }, layer: "GitHub", operation: "loadDeliveryWorkstream" },
        Effect.succeed(loaded),
      ) as unknown as Effect.Effect<unknown, GitHubDeliveryFailure>,
    pushExact: (input) =>
      WorkflowTest.call(
        { input, layer: "Git", operation: "pushExact" },
        Effect.succeed({
          idempotencyKey: input.idempotencyKey,
          state: "Applied" as const,
          targetCommit: input.targetCommit,
        }),
      ) as unknown as ReturnType<GitHubDeliveryService["pushExact"]>,
    readPublication: (input) =>
      WorkflowTest.call(
        { input, layer: "GitHub", operation: "readPublication" },
        Effect.succeed({ remoteTargetCommit: revision, ticketState: "OPEN" as const }),
      ) as unknown as ReturnType<GitHubDeliveryService["readPublication"]>,
  } satisfies GitHubDeliveryService);

const unavailableExecutionLayer = Layer.merge(
  Layer.succeed(SandboxProvider, {
    configuration: {
      adapterVersion: "test-1",
      configurationFingerprint: "unavailable",
      name: "unavailable-sandbox",
      publicFields: {},
    },
    create: () =>
      Effect.fail({
        _tag: "Sandbox.ProviderFailure" as const,
        message: "Execution is outside these loading tests",
      }),
  }),
  Layer.succeed(AgentProvider, {
    agent: {},
    configuration: {
      adapterVersion: "test-1",
      configurationFingerprint: "unavailable",
      model: "unavailable",
      name: "unavailable-agent",
      publicFields: {},
    },
  }),
);

const testLayer = (loaded: GitHubDeliveryGraph, reachable = true) =>
  Layer.merge(githubLayer(loaded, reachable), unavailableExecutionLayer);

const run = (loaded: GitHubDeliveryGraph, reachable = true) =>
  WorkflowTest.make(Delivery, {
    workflows: [DeliveryTicket],
    layer: testLayer(loaded, reachable),
  }).run({
    workstream: rootUrl,
  });

const runAt = (loaded: GitHubDeliveryGraph, workstream: string) =>
  WorkflowTest.make(Delivery, { workflows: [DeliveryTicket], layer: testLayer(loaded) }).run({
    workstream,
  });

const expectNoExecution = (result: Awaited<ReturnType<typeof run>>) => {
  expect(result.children).toEqual([]);
  expect(result.calls.filter(({ layer }) => layer === "Agent" || layer === "Sandbox")).toEqual([]);
  expect(() =>
    WorkflowTest.assertCalls(result, {
      forbidden: [
        { layer: "Agent", operation: "run" },
        { layer: "Sandbox", operation: "use" },
      ],
    }),
  ).not.toThrow();
};

describe("Delivery workstream loading", () => {
  test("rejects a non-canonical issue number before loading GitHub", async () => {
    const result = await runAt(graph(), "https://github.com/carere/kojo/issues/1e2");

    expect(result.outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidDeliveryWorkstream" },
    });
    expect(result.calls).toEqual([]);
    expectNoExecution(result);
  });

  test("loads and retains the complete graph and routing in publication-key order", async () => {
    const later = ticket({
      number: 43,
      title: "Later ticket",
      body: "<!-- delivery-ticket-key: #26::20 -->",
      url: "https://github.com/carere/kojo/issues/43",
    });
    const earlier = ticket({
      number: 44,
      title: "Earlier ticket",
      body: "<!-- delivery-ticket-key: #26::02 -->",
      url: "https://github.com/carere/kojo/issues/44",
      labels: ["enhancement", "ready-for-agent"],
    });
    const loaded = graph({
      root: {
        ...graph().root,
        children: { totalCount: 2, nodes: [{ number: 43 }, { number: 44 }] },
      },
      tickets: [later, earlier],
    });

    const result = await run(loaded);

    expect(result.state).toBe("Completed");
    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "TicketsFailed",
        evidence: {
          inputGraph: { root: { number: 26 }, tickets: [{ number: 44 }, { number: 43 }] },
          routing: {
            destinationBranch: "main",
            targetBranch: "feat/add-delivery-workflow-vertical",
          },
          sourceRevision: revision,
          normalizedSpecifications: [
            { number: 44, publicationKey: "#26::02" },
            { number: 43, publicationKey: "#26::20" },
          ],
          eligibleWork: [{ number: 44 }, { number: 43 }],
          exclusions: [],
          frontier: { decision: "Ready", tickets: [{ number: 44 }, { number: 43 }] },
        },
      },
    });
    expect(() =>
      WorkflowTest.assertCalls(result, {
        required: [
          {
            input: { url: rootUrl },
            layer: "GitHub",
            operation: "loadDeliveryWorkstream",
          },
          {
            input: {
              repository: "carere/kojo",
              revision,
              targetBranch: "feat/add-delivery-workflow-vertical",
            },
            layer: "GitHub",
            operation: "isSourceRevisionReachable",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects truncated child and blocker relationships", async () => {
    const truncatedChildren = await run(
      graph({
        root: {
          ...graph().root,
          children: { totalCount: 2, nodes: [{ number: 42 }] },
        },
      }),
    );
    const truncatedBlockers = await run(
      graph({ tickets: [ticket({ blockedBy: { totalCount: 1, nodes: [] } })] }),
    );

    for (const result of [truncatedChildren, truncatedBlockers]) {
      expect(result.state).toBe("Failed");
      expect(result.outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidDeliveryWorkstream" },
      });
      expectNoExecution(result);
    }
  });

  test("rejects duplicate identities and publication keys", async () => {
    const duplicateNumber = await run(
      graph({
        root: {
          ...graph().root,
          children: { totalCount: 2, nodes: [{ number: 42 }, { number: 42 }] },
        },
        tickets: [ticket(), ticket()],
      }),
    );
    const duplicateKey = await run(
      graph({
        root: {
          ...graph().root,
          children: { totalCount: 2, nodes: [{ number: 42 }, { number: 43 }] },
        },
        tickets: [
          ticket(),
          ticket({ number: 43, url: "https://github.com/carere/kojo/issues/43" }),
        ],
      }),
    );

    for (const result of [duplicateNumber, duplicateKey]) {
      expect(result.outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidDeliveryWorkstream" },
      });
      expectNoExecution(result);
    }
  });

  test("rejects cycles and blockers outside the workstream", async () => {
    const cyclic = await run(
      graph({
        root: {
          ...graph().root,
          children: { totalCount: 2, nodes: [{ number: 42 }, { number: 43 }] },
        },
        tickets: [
          ticket({ blockedBy: { totalCount: 1, nodes: [{ number: 43, state: "OPEN" }] } }),
          ticket({
            number: 43,
            body: "<!-- delivery-ticket-key: #26::17 -->",
            url: "https://github.com/carere/kojo/issues/43",
            blockedBy: { totalCount: 1, nodes: [{ number: 42, state: "OPEN" }] },
          }),
        ],
      }),
    );
    const outside = await run(
      graph({
        tickets: [
          ticket({ blockedBy: { totalCount: 1, nodes: [{ number: 99, state: "CLOSED" }] } }),
        ],
      }),
    );
    for (const result of [cyclic, outside]) {
      expect(result.outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidDeliveryWorkstream" },
      });
      expectNoExecution(result);
    }
  });

  test("rejects routing drift and an unreachable source revision", async () => {
    const drifted = await run(
      graph({ root: { ...graph().root, url: "https://github.com/other/repo/issues/26" } }),
    );
    const unreachable = await run(graph(), false);

    for (const result of [drifted, unreachable]) {
      expect(result.outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidDeliveryWorkstream" },
      });
      expectNoExecution(result);
    }
  });

  test("accepts a reachable full SHA-256 source revision", async () => {
    const sha256Revision = "b".repeat(64);
    const loaded = graph({
      root: { ...graph().root, body: delivery.replace(revision, sha256Revision) },
    });

    const result = await run(loaded);

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: { evidence: { sourceRevision: sha256Revision } },
    });
    expect(() =>
      WorkflowTest.assertCalls(result, {
        required: [
          {
            input: {
              repository: "carere/kojo",
              revision: sha256Revision,
              targetBranch: "feat/add-delivery-workflow-vertical",
            },
            layer: "GitHub",
            operation: "isSourceRevisionReachable",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects invalid root, Delivery routing, and executable ticket state", async () => {
    const invalidRoot = await run(
      graph({ root: { ...graph().root, assignees: ["delivery-agent"], labels: ["planning"] } }),
    );
    const invalidRouting = await run(
      graph({
        root: {
          ...graph().root,
          body: delivery.replace(
            "- Destination branch: `main`",
            "- Destination branch: `feat/add-delivery-workflow-vertical`",
          ),
        },
      }),
    );
    const invalidTicket = await run(
      graph({
        tickets: [
          ticket({
            assignees: ["delivery-agent"],
            labels: ["ready-for-agent", "ready-for-human"],
            parent: null,
          }),
        ],
      }),
    );

    for (const result of [invalidRoot, invalidRouting, invalidTicket]) {
      expect(result.outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidDeliveryWorkstream" },
      });
      expectNoExecution(result);
    }
  });
});

describe("Delivery frontier decisions", () => {
  test("returns NothingToDo for an empty native graph", async () => {
    const result = await run(
      graph({
        root: { ...graph().root, children: { totalCount: 0, nodes: [] } },
        tickets: [],
      }),
    );

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "NothingToDo",
        evidence: { frontier: { decision: "NothingToDo", tickets: [] } },
      },
    });
    expectNoExecution(result);
  });

  test("returns AlreadyComplete when every ticket is closed", async () => {
    const result = await run(
      graph({ tickets: [ticket({ state: "CLOSED", assignees: ["delivery-agent"], labels: [] })] }),
    );

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "AlreadyComplete",
        evidence: {
          exclusions: [{ number: 42, reason: "Closed" }],
          frontier: { decision: "AlreadyComplete", tickets: [] },
        },
      },
    });
    expectNoExecution(result);
  });

  test("returns OpenWorkNoReadyTicket for blocked open work", async () => {
    const blocked = ticket({
      number: 43,
      body: "<!-- delivery-ticket-key: #26::17 -->",
      url: "https://github.com/carere/kojo/issues/43",
      blockedBy: { totalCount: 1, nodes: [{ number: 42, state: "OPEN" }] },
    });
    const result = await run(
      graph({
        root: {
          ...graph().root,
          children: { totalCount: 2, nodes: [{ number: 42 }, { number: 43 }] },
        },
        tickets: [ticket({ state: "CLOSED", labels: [] }), blocked],
      }),
    );

    expect(result.outcome).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "OpenWorkNoReadyTicket",
        evidence: {
          eligibleWork: [{ number: 43 }],
          exclusions: [
            { number: 42, reason: "Closed" },
            { blockerNumbers: [42], number: 43, reason: "Blocked" },
          ],
          frontier: { decision: "OpenWorkNoReadyTicket", tickets: [] },
        },
      },
    });
    expectNoExecution(result);
  });
});
