import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { quoteShellArgument } from "../../src/shared/process";
import {
  DeliveryOptions,
  DeliveryWorkstream,
  PlannerSelection,
  TrackerIssue,
} from "../../src/types/delivery";
import { WorkflowError } from "../../src/types/errors";
import { validatePlannerSelection } from "../../src/workflows/delivery/agents/planner";
import { parseReviewDecision } from "../../src/workflows/delivery/agents/review-decision";
import { issueBranchName } from "../../src/workflows/delivery/issue";
import { parseDeliveryMetadata } from "../../src/workflows/delivery/metadata";
import { deliveryPullRequestContent } from "../../src/workflows/delivery/pull-request";
import {
  buildDeliveryWorkstream,
  selectReadyFrontier,
} from "../../src/workflows/delivery/workstream";
import { runEffect, runFailure } from "../helpers/effect";

const decodeDeliveryOptions = Schema.decodeUnknownSync(DeliveryOptions);
const decodePlannerSelection = Schema.decodeUnknownSync(PlannerSelection);
const decodeTrackerIssue = Schema.decodeUnknownSync(TrackerIssue);

const revision = "a".repeat(40);
const delivery = `## Delivery

- Target branch: \`feat/quotes\`
- Destination branch: \`main\`
- Source revision: \`${revision}\`

## Problem Statement

Quote work.`;

const issue = (overrides: Record<string, unknown> = {}) =>
  decodeTrackerIssue({
    number: 42,
    title: "Quote slice",
    body: "<!-- delivery-ticket-key: #10::01 -->",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: "Delivery: quotes", state: "OPEN" },
    blockedBy: [],
    subIssues: [],
    ...overrides,
  });

describe("delivery options", () => {
  test("decodes defaults and scoped overrides", () => {
    expect(decodeDeliveryOptions({})).toMatchObject({ concurrency: 4, maxIterations: 10 });
    expect(
      decodeDeliveryOptions({
        root: 10,
        target: "feat/quotes",
        concurrency: 2,
        maxIterations: 3,
      }),
    ).toMatchObject({ root: 10, target: "feat/quotes", concurrency: 2, maxIterations: 3 });
  });

  test("rejects non-positive limits through the schema error channel", async () => {
    const error = await runFailure(
      Schema.decodeUnknownEffect(DeliveryOptions)({ concurrency: 0, maxIterations: 10 }),
    );

    expect(error).toMatchObject({ _tag: "SchemaError" });
    expect(error.message).toContain("greater than 0");
  });
});

describe("delivery metadata", () => {
  test("parses the exact delivery section", async () => {
    expect(await runEffect(parseDeliveryMetadata(delivery))).toMatchObject({
      targetBranch: "feat/quotes",
      destinationBranch: "main",
      sourceRevision: revision,
    });
  });

  test("rejects duplicate sections and abbreviated revisions", async () => {
    const duplicateSection = await runFailure(parseDeliveryMetadata(`${delivery}\n${delivery}`));
    const abbreviatedRevision = await runFailure(
      parseDeliveryMetadata(delivery.replace(revision, "abc123")),
    );

    expect(duplicateSection).toBeInstanceOf(WorkflowError);
    expect(duplicateSection.message).toContain("exactly one");
    expect(abbreviatedRevision).toBeInstanceOf(WorkflowError);
    expect(abbreviatedRevision.message).toContain("full Git commit object ID");
  });
});

describe("workstream validation", () => {
  const root = (overrides: Record<string, unknown> = {}) =>
    issue({
      number: 10,
      title: "Delivery: quotes",
      body: delivery,
      labels: [],
      parent: null,
      subIssues: [{ number: 42, title: "Quote slice", state: "OPEN" }],
      ...overrides,
    });

  test("builds a native child workstream", async () => {
    const workstream = await runEffect(buildDeliveryWorkstream(root(), [issue()]));

    expect(workstream.kind).toBe("root");
    expect(workstream.delivery.targetBranch).toBe("feat/quotes");
    expect(workstream.tickets.map(({ number }) => number)).toEqual([42]);
  });

  test("rejects executable roots and invalid child keys", async () => {
    const executableRoot = await runFailure(
      buildDeliveryWorkstream(root({ labels: [{ name: "ready-for-agent" }] }), [issue()]),
    );
    const invalidChildKey = await runFailure(
      buildDeliveryWorkstream(root(), [issue({ body: "no key" })]),
    );

    expect(executableRoot).toBeInstanceOf(WorkflowError);
    expect(executableRoot.message).toContain("state label");
    expect(invalidChildKey).toBeInstanceOf(WorkflowError);
    expect(invalidChildKey.message).toContain("invalid delivery-ticket-key");
  });

  test("supports a standalone routed ticket", async () => {
    const standalone = issue({ number: 7, body: delivery, parent: null });
    const workstream = await runEffect(buildDeliveryWorkstream(standalone, [standalone]));

    expect(workstream.kind).toBe("standalone");
  });

  test("rejects truncated and cyclic native graphs", async () => {
    const truncatedGraph = await runFailure(
      buildDeliveryWorkstream(
        root({
          subIssues: {
            totalCount: 2,
            nodes: [{ number: 42, title: "Quote slice", state: "OPEN" }],
          },
        }),
        [issue()],
      ),
    );

    const first = issue({
      blockedBy: [{ number: 43, title: "Second slice", state: "OPEN" }],
    });
    const second = issue({
      number: 43,
      title: "Second slice",
      body: "<!-- delivery-ticket-key: #10::02 -->",
      blockedBy: [{ number: 42, title: "Quote slice", state: "OPEN" }],
    });
    const cyclicGraph = await runFailure(
      buildDeliveryWorkstream(
        root({
          subIssues: [
            { number: 42, title: "Quote slice", state: "OPEN" },
            { number: 43, title: "Second slice", state: "OPEN" },
          ],
        }),
        [first, second],
      ),
    );

    expect(truncatedGraph).toBeInstanceOf(WorkflowError);
    expect(truncatedGraph.message).toContain("truncated child graph");
    expect(cyclicGraph).toBeInstanceOf(WorkflowError);
    expect(cyclicGraph.message).toContain("blocker graph is cyclic");
  });
});

describe("frontier and agent output", () => {
  test("uses only tickets whose native blockers are closed", () => {
    const ready = issue({ number: 42 });
    const blocked = issue({
      number: 43,
      body: "<!-- delivery-ticket-key: #10::02 -->",
      blockedBy: [{ number: 42, title: "Quote slice", state: "OPEN" }],
    });

    expect(selectReadyFrontier([ready, blocked]).map(({ number }) => number)).toEqual([42]);
  });

  test("validates schema-decoded planner scope and review decisions", async () => {
    const selection = decodePlannerSelection({ issueIds: [42] });

    expect(await runEffect(validatePlannerSelection(selection, ["42", "43"], 2))).toEqual(["42"]);

    const outOfScope = await runFailure(
      validatePlannerSelection(decodePlannerSelection({ issueIds: [99] }), ["42"], 1),
    );
    expect(outOfScope).toBeInstanceOf(WorkflowError);
    expect(outOfScope.message).toContain("out-of-scope");

    expect(
      await runEffect(
        parseReviewDecision(
          '<review>{"readyToMerge":true,"summary":"clean","findings":[]}</review>',
        ),
      ),
    ).toMatchObject({ readyToMerge: true, summary: "clean", findings: [] });
  });
});

describe("delivery completion", () => {
  test("builds a conventional PR title and closes only the root", async () => {
    const rootIssue = issue({
      number: 10,
      title: "Delivery: quote simulator",
      body: delivery,
      labels: [],
      parent: null,
      subIssues: [
        { number: 42, title: "Quote slice", state: "OPEN" },
        { number: 43, title: "Summary slice", state: "OPEN" },
      ],
    });
    const second = issue({
      number: 43,
      title: "Summary slice",
      body: "<!-- delivery-ticket-key: #10::02 -->",
    });
    const workstream = await runEffect(buildDeliveryWorkstream(rootIssue, [issue(), second]));
    const content = deliveryPullRequestContent(workstream);
    const withRoot = (root: TrackerIssue) => new DeliveryWorkstream({ ...workstream, root });

    expect(content.title).toBe("feat: quote simulator");
    expect(
      deliveryPullRequestContent(withRoot(issue({ title: "fix(quotes): reject invalid totals" })))
        .title,
    ).toBe("fix(quotes): reject invalid totals");
    expect(
      deliveryPullRequestContent(
        withRoot(issue({ title: "Reject invalid totals", labels: [{ name: "bug" }] })),
      ).title,
    ).toBe("fix: Reject invalid totals");
    expect(content.body).toContain("Closes #10");
    expect(content.body).not.toContain("Closes #42");
    expect(content.body).toContain("moon run sandcastle:preview -- start --branch 'feat/quotes'");
  });
});

test("branch and shell identities are deterministic", () => {
  expect(issueBranchName(10, 42)).toBe("sandcastle/workstream-10/issue-42");
  expect(quoteShellArgument("feat/user's-quote")).toBe("'feat/user'\"'\"'s-quote'");
});
