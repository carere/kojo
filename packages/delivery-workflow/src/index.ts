import {
  Agent,
  type AgentProviderService,
  Command,
  Loop,
  Sandbox,
  type SandboxProviderService,
  Workflow,
} from "@kojo/workflow";
import { Cause, Context, Effect, Option, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";

const IssueState = Schema.Literals(["OPEN", "CLOSED"]);
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const IssueIdentity = Schema.Struct({ number: PositiveInteger });
const Blocker = Schema.Struct({ number: PositiveInteger, state: IssueState });
const RelationshipCollection = <A extends Schema.Top>(node: A) =>
  Schema.Struct({ totalCount: NonNegativeInteger, nodes: Schema.Array(node) });

const GitHubRootIssue = Schema.Struct({
  number: PositiveInteger,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  assignees: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  parent: Schema.NullOr(IssueIdentity),
  children: RelationshipCollection(IssueIdentity),
});

const GitHubDeliveryTicket = Schema.Struct({
  number: PositiveInteger,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  assignees: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  parent: Schema.NullOr(IssueIdentity),
  blockedBy: RelationshipCollection(Blocker),
});

export const GitHubDeliveryGraphSchema = Schema.Struct({
  root: GitHubRootIssue,
  tickets: Schema.Array(GitHubDeliveryTicket),
});

export type GitHubDeliveryGraph = Schema.Schema.Type<typeof GitHubDeliveryGraphSchema>;

const GitHubDeliveryFailure = Schema.TaggedStruct("GitHubDeliveryFailure", {
  message: Schema.String,
  operation: Schema.String,
});

export type GitHubDeliveryFailure = Schema.Schema.Type<typeof GitHubDeliveryFailure>;

export interface GitHubDeliveryService {
  readonly load: (rootUrl: string) => Effect.Effect<unknown, GitHubDeliveryFailure>;
  readonly isSourceRevisionReachable: (input: {
    readonly repository: string;
    readonly revision: string;
    readonly targetBranch: string;
  }) => Effect.Effect<boolean, GitHubDeliveryFailure>;
  readonly readPublication: (input: {
    readonly repository: string;
    readonly targetBranch: string;
    readonly ticketNumber: number;
  }) => Effect.Effect<PublicationSnapshot, GitHubDeliveryFailure>;
  readonly pushExact: (input: {
    readonly expectedTargetCommit: string;
    readonly idempotencyKey: string;
    readonly repository: string;
    readonly targetBranch: string;
    readonly targetCommit: string;
  }) => Effect.Effect<PublicationReceipt, GitHubDeliveryFailure>;
  readonly closeTicket: (input: {
    readonly expectedState: "OPEN";
    readonly idempotencyKey: string;
    readonly repository: string;
    readonly targetCommit: string;
    readonly ticketNumber: number;
  }) => Effect.Effect<PublicationReceipt, GitHubDeliveryFailure>;
}

export const GitHubDelivery = Context.Service<GitHubDeliveryService>(
  "@kojo/delivery-workflow/GitHubDelivery",
);

const Routing = Schema.Struct({
  targetBranch: Schema.String,
  destinationBranch: Schema.String,
});

const NormalizedSpecification = Schema.Struct({
  number: PositiveInteger,
  title: Schema.String,
  body: Schema.String,
  publicationKey: Schema.String,
  parentNumber: PositiveInteger,
  blockerNumbers: Schema.Array(PositiveInteger),
});

const WorkTicket = Schema.Struct({
  number: PositiveInteger,
  publicationKey: Schema.String,
});

const DeliveryTicketInput = Schema.Struct({
  baseCommit: Schema.String,
  branch: Schema.String,
  destinationBranch: Schema.String,
  targetBranch: Schema.String,
  ticket: NormalizedSpecification,
});

const ReviewFinding = Schema.Struct({
  id: Schema.String,
  priority: Schema.Literals(["P1", "P2", "P3"]),
  summary: Schema.String,
  detail: Schema.String,
});

const FindingDisposition = Schema.Struct({
  findingId: Schema.String,
  disposition: Schema.Literal("Addressed"),
  summary: Schema.String,
});

const FindingHistory = Schema.Struct({
  attempt: PositiveInteger,
  findings: Schema.Array(ReviewFinding),
  dispositions: Schema.Array(FindingDisposition),
});

const TicketIdentity = Schema.Struct({
  number: PositiveInteger,
  publicationKey: Schema.String,
});

const Implemented = Schema.TaggedStruct("Implemented", {
  ticket: TicketIdentity,
  sandbox: Schema.Struct({ name: Schema.String, branch: Schema.String }),
  baseCommit: Schema.String,
  finalCommit: Schema.String,
  reviewAttempts: PositiveInteger,
  findingHistory: Schema.Array(FindingHistory),
});

const PublicationSnapshotSchema = Schema.Struct({
  remoteTargetCommit: Schema.String,
  ticketState: IssueState,
});

export type PublicationSnapshot = Schema.Schema.Type<typeof PublicationSnapshotSchema>;

const PublicationReceiptSchema = Schema.Struct({
  idempotencyKey: Schema.String,
  state: Schema.Literals(["Applied", "AlreadyApplied"]),
  targetCommit: Schema.String,
});

export type PublicationReceipt = Schema.Schema.Type<typeof PublicationReceiptSchema>;

const Published = Schema.TaggedStruct("Published", {
  ticket: TicketIdentity,
  reviewedCommit: Schema.String,
  integratedCommit: Schema.String,
  verifiedCommit: Schema.String,
  mergeParents: Schema.Tuple([Schema.String, Schema.String]),
  repairedConflict: Schema.Boolean,
  repairReviewAttempts: NonNegativeInteger,
  reviewAttempts: PositiveInteger,
  findingHistory: Schema.Array(FindingHistory),
  pushReceipt: PublicationReceiptSchema,
  closeReceipt: PublicationReceiptSchema,
});

const ReviewLimitReached = Schema.TaggedStruct("ReviewLimitReached", {
  ticket: TicketIdentity,
  sandbox: Schema.Struct({ name: Schema.String, branch: Schema.String }),
  baseCommit: Schema.String,
  finalCommit: Schema.String,
  reviewAttempts: PositiveInteger,
  findingHistory: Schema.Array(FindingHistory),
  failure: Loop.MaximumLimitReached,
});

const TicketFailed = Schema.TaggedStruct("TicketFailed", {
  ticket: TicketIdentity,
  failure: Schema.Unknown,
});

export const DeliveryTicketOutcome = Schema.Union([Implemented, ReviewLimitReached, TicketFailed]);
export type DeliveryTicketOutcome = Schema.Schema.Type<typeof DeliveryTicketOutcome>;

const Exclusion = Schema.Struct({
  number: PositiveInteger,
  publicationKey: Schema.String,
  reason: Schema.Literals(["Closed", "Blocked"]),
  blockerNumbers: Schema.Array(PositiveInteger),
});

const Frontier = Schema.Struct({
  decision: Schema.Literals(["NothingToDo", "AlreadyComplete", "OpenWorkNoReadyTicket", "Ready"]),
  tickets: Schema.Array(WorkTicket),
});

const DeliveryEvidence = Schema.Struct({
  inputGraph: GitHubDeliveryGraphSchema,
  routing: Routing,
  normalizedSpecifications: Schema.Array(NormalizedSpecification),
  sourceRevision: Schema.String,
  eligibleWork: Schema.Array(WorkTicket),
  exclusions: Schema.Array(Exclusion),
  frontier: Frontier,
});

const NothingToDo = Schema.TaggedStruct("NothingToDo", { evidence: DeliveryEvidence });
const AlreadyComplete = Schema.TaggedStruct("AlreadyComplete", { evidence: DeliveryEvidence });
const OpenWorkNoReadyTicket = Schema.TaggedStruct("OpenWorkNoReadyTicket", {
  evidence: DeliveryEvidence,
});
const OpenWork = Schema.TaggedStruct("OpenWork", {
  evidence: DeliveryEvidence,
  ticketOutcomes: Schema.Array(Schema.Union([Published, ReviewLimitReached, TicketFailed])),
});
const TicketsFailed = Schema.TaggedStruct("TicketsFailed", {
  evidence: DeliveryEvidence,
  ticketOutcomes: Schema.Array(Schema.Union([Published, ReviewLimitReached, TicketFailed])),
});

export const DeliveryResult = Schema.Union([
  NothingToDo,
  AlreadyComplete,
  OpenWorkNoReadyTicket,
  OpenWork,
  TicketsFailed,
]);
export type DeliveryResult = Schema.Schema.Type<typeof DeliveryResult>;

const InvalidDeliveryWorkstream = Schema.TaggedStruct("InvalidDeliveryWorkstream", {
  diagnostics: Schema.Array(Schema.String),
  inputGraph: Schema.optional(GitHubDeliveryGraphSchema),
});

export const DeliveryFailure = Schema.Union([InvalidDeliveryWorkstream, GitHubDeliveryFailure]);
export type DeliveryFailure = Schema.Schema.Type<typeof DeliveryFailure>;

const DeliveryInput = Schema.Struct({ workstream: Schema.String });

const ImplementerResult = Schema.Struct({
  summary: Schema.String,
  dispositions: Schema.Array(FindingDisposition),
});

const ReviewerResult = Schema.Struct({ findings: Schema.Array(ReviewFinding) });

const AgentStepFailure = Schema.TaggedStruct("Delivery.AgentStepFailure", {
  message: Schema.String,
});

interface ParsedRootUrl {
  readonly repository: string;
  readonly number: number;
  readonly canonical: string;
}

interface DeliveryRouting {
  readonly targetBranch: string;
  readonly destinationBranch: string;
  readonly sourceRevision: string;
}

interface TicketWithPublicationKey {
  readonly ticket: GitHubDeliveryGraph["tickets"][number];
  readonly publicationKey: string;
  readonly publicationOrdinal: number;
}

const EXECUTION_LABELS = new Set([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
]);

const parseRootUrl = (value: string): ParsedRootUrl | undefined => {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const issueSegment = segments[3] ?? "";
    const number = Number(issueSegment);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      segments.length !== 4 ||
      segments[2] !== "issues" ||
      !/^[1-9]\d*$/.test(issueSegment) ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      return undefined;
    }
    const repository = `${segments[0]}/${segments[1]}`;
    return {
      repository,
      number,
      canonical: `https://github.com/${repository}/issues/${number}`,
    };
  } catch {
    return undefined;
  }
};

const hasForbiddenBranchCharacter = (branch: string) =>
  [...branch].some(
    (character) =>
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 127 ||
      "~^:?*[\\".includes(character),
  );

const branchIsValid = (branch: string) =>
  branch.length > 0 &&
  branch === branch.trim() &&
  !branch.startsWith("-") &&
  !branch.startsWith("/") &&
  !branch.endsWith("/") &&
  !branch.endsWith(".") &&
  !branch.includes("..") &&
  !branch.includes("//") &&
  !branch.includes("@{") &&
  branch !== "@" &&
  !hasForbiddenBranchCharacter(branch) &&
  branch
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));

const parseDelivery = (body: string): DeliveryRouting | undefined => {
  const headings = [...body.matchAll(/^## Delivery\s*$/gm)];
  if (headings.length !== 1) return undefined;
  const heading = headings[0];
  if (heading?.index === undefined) return undefined;
  const start = heading.index + heading[0].length;
  const remainder = body.slice(start);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = (nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)).trim();
  const fields = new Map<string, string>();
  for (const line of section
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const match = /^- (Target branch|Destination branch|Source revision): `([^`]+)`$/.exec(line);
    if (!match || fields.has(match[1] ?? "")) return undefined;
    fields.set(match[1] ?? "", match[2] ?? "");
  }
  if (fields.size !== 3) return undefined;
  const targetBranch = fields.get("Target branch");
  const destinationBranch = fields.get("Destination branch");
  const sourceRevision = fields.get("Source revision");
  if (
    targetBranch === undefined ||
    destinationBranch === undefined ||
    sourceRevision === undefined ||
    !branchIsValid(targetBranch) ||
    !branchIsValid(destinationBranch) ||
    targetBranch === destinationBranch ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceRevision)
  ) {
    return undefined;
  }
  return { targetBranch, destinationBranch, sourceRevision: sourceRevision.toLowerCase() };
};

const publicationIdentity = (rootNumber: number, body: string) => {
  const matches = [...body.matchAll(/<!--\s*delivery-ticket-key:\s*([^\s]+)\s*-->/g)];
  if (matches.length !== 1) return undefined;
  const publicationKey = matches[0]?.[1];
  if (publicationKey === undefined) return undefined;
  const parsed = new RegExp(`^#${rootNumber}::(\\d{2,})$`).exec(publicationKey);
  if (!parsed) return undefined;
  const publicationOrdinal = Number(parsed[1]);
  if (!Number.isSafeInteger(publicationOrdinal)) return undefined;
  return { publicationKey, publicationOrdinal };
};

const hasCycle = (tickets: ReadonlyArray<TicketWithPublicationKey>) => {
  const blockers = new Map(
    tickets.map(({ ticket }) => [
      ticket.number,
      ticket.blockedBy.nodes.map(({ number }) => number),
    ]),
  );
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (number: number): boolean => {
    if (visiting.has(number)) return true;
    if (visited.has(number)) return false;
    visiting.add(number);
    if ((blockers.get(number) ?? []).some(visit)) return true;
    visiting.delete(number);
    visited.add(number);
    return false;
  };
  return tickets.some(({ ticket }) => visit(ticket.number));
};

const validateGraph = (
  graph: GitHubDeliveryGraph,
  rootUrl: ParsedRootUrl,
): {
  readonly diagnostics: ReadonlyArray<string>;
  readonly tickets: ReadonlyArray<TicketWithPublicationKey>;
} => {
  const diagnostics: Array<string> = [];
  const { root } = graph;
  if (root.number !== rootUrl.number || root.url !== rootUrl.canonical) {
    diagnostics.push("The loaded workstream root does not match the requested GitHub issue URL.");
  }
  if (root.state !== "OPEN") diagnostics.push("The workstream root must be open.");
  if (root.parent !== null) diagnostics.push("The workstream root must not have a parent.");
  if (root.assignees.length > 0) diagnostics.push("The workstream root must be unassigned.");
  if (root.labels.length > 0) diagnostics.push("The workstream root must be unlabelled.");
  if (root.children.totalCount !== root.children.nodes.length) {
    diagnostics.push("The native child graph is truncated.");
  }

  const childNumbers = root.children.nodes.map(({ number }) => number);
  const uniqueChildNumbers = new Set(childNumbers);
  if (uniqueChildNumbers.size !== childNumbers.length) {
    diagnostics.push("The native child graph contains duplicate issue identities.");
  }
  const ticketNumbers = graph.tickets.map(({ number }) => number);
  const uniqueTicketNumbers = new Set(ticketNumbers);
  if (uniqueTicketNumbers.size !== ticketNumbers.length) {
    diagnostics.push("The loaded ticket graph contains duplicate issue identities.");
  }
  if (
    uniqueChildNumbers.size !== uniqueTicketNumbers.size ||
    [...uniqueChildNumbers].some((number) => !uniqueTicketNumbers.has(number))
  ) {
    diagnostics.push("The loaded ticket graph is not the complete native child graph.");
  }

  const seenPublicationKeys = new Set<string>();
  const tickets: Array<TicketWithPublicationKey> = [];
  for (const ticket of graph.tickets) {
    const expectedUrl = `https://github.com/${rootUrl.repository}/issues/${ticket.number}`;
    if (ticket.url !== expectedUrl) {
      diagnostics.push(`Ticket #${ticket.number} has drifted outside the workstream repository.`);
    }
    if (ticket.parent?.number !== root.number) {
      diagnostics.push(
        `Ticket #${ticket.number} must have exactly one native parent, #${root.number}.`,
      );
    }
    if (ticket.blockedBy.totalCount !== ticket.blockedBy.nodes.length) {
      diagnostics.push(`Ticket #${ticket.number} has a truncated blocker graph.`);
    }
    const blockerNumbers = ticket.blockedBy.nodes.map(({ number }) => number);
    if (new Set(blockerNumbers).size !== blockerNumbers.length) {
      diagnostics.push(`Ticket #${ticket.number} has duplicate blocker identities.`);
    }
    for (const blocker of ticket.blockedBy.nodes) {
      if (!uniqueTicketNumbers.has(blocker.number)) {
        diagnostics.push(
          `Ticket #${ticket.number} has blocker #${blocker.number} outside the workstream.`,
        );
      }
    }
    if (ticket.state === "OPEN") {
      if (ticket.assignees.length > 0) {
        diagnostics.push(`Executable ticket #${ticket.number} must be unassigned.`);
      }
      const executionLabels = ticket.labels.filter((label) => EXECUTION_LABELS.has(label));
      if (executionLabels.length !== 1 || executionLabels[0] !== "ready-for-agent") {
        diagnostics.push(
          `Executable ticket #${ticket.number} must have only the ready-for-agent execution label.`,
        );
      }
    }
    const identity = publicationIdentity(root.number, ticket.body);
    if (identity === undefined) {
      diagnostics.push(`Ticket #${ticket.number} has an invalid publication key.`);
      continue;
    }
    if (seenPublicationKeys.has(identity.publicationKey)) {
      diagnostics.push(`Publication key '${identity.publicationKey}' is duplicated.`);
    }
    seenPublicationKeys.add(identity.publicationKey);
    tickets.push({ ticket, ...identity });
  }
  if (hasCycle(tickets)) diagnostics.push("The blocker graph is cyclic.");

  return {
    diagnostics,
    tickets: tickets.sort(
      (left, right) =>
        left.publicationOrdinal - right.publicationOrdinal ||
        left.ticket.number - right.ticket.number,
    ),
  };
};

const invalid = (diagnostics: ReadonlyArray<string>, inputGraph?: GitHubDeliveryGraph) => ({
  _tag: "InvalidDeliveryWorkstream" as const,
  diagnostics: [...diagnostics],
  ...(inputGraph === undefined ? {} : { inputGraph }),
});

const decodeGraphSync = Schema.decodeUnknownSync(GitHubDeliveryGraphSchema);

const ticketIdentity = (ticket: Schema.Schema.Type<typeof NormalizedSpecification>) => ({
  number: ticket.number,
  publicationKey: ticket.publicationKey,
});

const failProof = (check: string, message: string) =>
  Effect.fail({ _tag: "Delivery.TicketProofFailure" as const, check, message });

const successfulCommand = (name: string, command: string) =>
  Command.run(name, { command }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : failProof(name, `'${command}' exited with ${result.exitCode}`),
    ),
  );

const cleanOutput = (value: string) => value.replace(/\r\n/g, "\n").trim();

const proveImplementation = (baseCommit: string) =>
  Effect.gen(function* () {
    const headResult = yield* successfulCommand("committed-head", "git rev-parse HEAD");
    const head = cleanOutput(headResult.stdout);
    if (!/^[0-9a-f]{40,64}$/i.test(head) || head.toLowerCase() === baseCommit.toLowerCase()) {
      return yield* failProof("committed-head", "The implementer did not produce a new commit.");
    }
    yield* successfulCommand("base-ancestry", `git merge-base --is-ancestor ${baseCommit} HEAD`);
    const changed = yield* Command.run("non-empty-change", {
      command: `git diff --quiet ${baseCommit} HEAD`,
    });
    if (changed.exitCode !== 1) {
      return yield* failProof(
        "non-empty-change",
        changed.exitCode === 0
          ? "The committed change is empty."
          : `Git could not compare the committed change (exit ${changed.exitCode}).`,
      );
    }
    const status = yield* successfulCommand("clean-worktree", "git status --porcelain");
    if (cleanOutput(status.stdout) !== "") {
      return yield* failProof("clean-worktree", "The implementer left uncommitted work.");
    }
    yield* successfulCommand("check", "moon run :check");
    yield* successfulCommand("typecheck", "moon run :tsc");
    yield* successfulCommand("test", "moon run :test");
    const postCheckStatus = yield* successfulCommand(
      "post-check-clean-worktree",
      "git status --porcelain",
    );
    if (cleanOutput(postCheckStatus.stdout) !== "") {
      return yield* failProof(
        "post-check-clean-worktree",
        "The configured commands left uncommitted work.",
      );
    }
    return { head, status: cleanOutput(postCheckStatus.stdout) };
  });

const implementationPrompt = (
  input: Schema.Schema.Type<typeof DeliveryTicketInput>,
  history: ReadonlyArray<Schema.Schema.Type<typeof FindingHistory>>,
) => {
  const findings = history.at(-1)?.findings ?? [];
  const feedback =
    findings.length === 0
      ? "There are no prior review findings."
      : findings
          .map(
            (finding) =>
              `Finding ${finding.id}: ${finding.priority} ${finding.summary}\n${finding.detail}`,
          )
          .join("\n\n");
  return `Implement Delivery ticket #${input.ticket.number} in the current isolated Sandbox.
The Sandbox starts from exact target commit ${input.baseCommit} on branch ${input.branch}.
Produce a non-empty committed change and leave the worktree clean.

Ticket title: ${input.ticket.title}
Ticket specification:
${input.ticket.body}

Review finding history:
${JSON.stringify(history)}

Findings to address in this turn:
${feedback}

Return one Addressed disposition for every listed finding. Do not claim checks passed; deterministic Code Steps run them after you commit.`;
};

const reviewPrompt = (
  input: Schema.Schema.Type<typeof DeliveryTicketInput>,
  cumulativeDiff: string,
  history: ReadonlyArray<Schema.Schema.Type<typeof FindingHistory>>,
) => `Act as a mechanically read-only reviewer for Delivery ticket #${input.ticket.number}.
Do not modify files, create commits, or change the worktree. Review all severities and return every P1, P2, and P3 finding. Success requires an empty findings array.

Ticket specification:
${input.ticket.body}

Cumulative diff from exact base commit ${input.baseCommit}:
${cumulativeDiff}

Finding and disposition history:
${JSON.stringify(history)}`;

const dispositionsMatch = (
  findings: ReadonlyArray<Schema.Schema.Type<typeof ReviewFinding>>,
  dispositions: ReadonlyArray<Schema.Schema.Type<typeof FindingDisposition>>,
) => {
  const expected = findings.map(({ id }) => id).sort();
  const actual = dispositions.map(({ findingId }) => findingId).sort();
  return (
    expected.length === actual.length &&
    expected.every((findingId, index) => actual[index] === findingId)
  );
};

const ticketFailureFromCause = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findErrorOption(cause);
  if (!Cause.hasDies(cause) && Option.isSome(failure)) return failure.value;
  return {
    _tag: "Delivery.TicketDefect" as const,
    cause: Cause.pretty(cause),
  };
};

const normalizeSpecification = (
  ticket: GitHubDeliveryGraph["tickets"][number],
  publicationKey: string,
) => ({
  number: ticket.number,
  title: ticket.title.trim(),
  body: ticket.body.replace(/\r\n/g, "\n").trim(),
  publicationKey,
  parentNumber: ticket.parent?.number ?? 0,
  blockerNumbers: ticket.blockedBy.nodes.map(({ number }) => number).sort((a, b) => a - b),
});

const exactCommit = (value: string) => /^[0-9a-f]{40,64}$/i.test(value);

const durableGitHub = <A, E>(
  name: string,
  success: Schema.Schema<A>,
  execute: Effect.Effect<A, E>,
) =>
  Activity.make({
    name,
    success,
    error: GitHubDeliveryFailure,
    execute: execute as Effect.Effect<A, GitHubDeliveryFailure>,
  });

const proveExactMerge = (expectedTargetCommit: string, reviewedCommit: string) =>
  Effect.gen(function* () {
    const head = cleanOutput(
      (yield* successfulCommand("integrated-head", "git rev-parse HEAD")).stdout,
    );
    if (!exactCommit(head)) {
      return yield* failProof("integrated-head", `Integration produced invalid commit '${head}'.`);
    }
    const parents = cleanOutput(
      (yield* successfulCommand("merge-parents", "git show -s --format=%P HEAD")).stdout,
    ).split(/\s+/);
    if (
      parents.length !== 2 ||
      parents[0]?.toLowerCase() !== expectedTargetCommit.toLowerCase() ||
      parents[1]?.toLowerCase() !== reviewedCommit.toLowerCase()
    ) {
      return yield* failProof(
        "merge-parents",
        "The integrated commit is not the exact two-parent no-fast-forward transition.",
      );
    }
    yield* successfulCommand("integrated-clean-worktree", "git status --porcelain").pipe(
      Effect.flatMap((status) =>
        cleanOutput(status.stdout) === ""
          ? Effect.void
          : failProof("integrated-clean-worktree", "Integration left uncommitted work."),
      ),
    );
    return { head, parents: [parents[0] ?? "", parents[1] ?? ""] as const };
  });

const runConfiguredVerification = () =>
  Effect.gen(function* () {
    yield* successfulCommand("check", "moon run :check");
    yield* successfulCommand("typecheck", "moon run :tsc");
    yield* successfulCommand("test", "moon run :test");
    const clean = yield* successfulCommand("verification-clean-worktree", "git status --porcelain");
    if (cleanOutput(clean.stdout) !== "") {
      return yield* failProof("verification-clean-worktree", "Verification changed the worktree.");
    }
  });

const repairPrompt = (
  input: Schema.Schema.Type<typeof DeliveryTicketInput>,
  expectedTargetCommit: string,
  reviewedCommit: string,
  history: ReadonlyArray<Schema.Schema.Type<typeof FindingHistory>>,
) => {
  const findings = history.at(-1)?.findings ?? [];
  const feedback = findings
    .map(
      (finding) =>
        `Finding ${finding.id}: ${finding.priority} ${finding.summary}\n${finding.detail}`,
    )
    .join("\n\n");
  return `Repair the active merge conflict for Delivery ticket #${input.ticket.number}.
The accepted target base must remain ${expectedTargetCommit} and the reviewed second parent must remain ${reviewedCommit}.
Resolve and commit the merge without rebasing, squashing, resetting, or changing either parent.
${findings.length > 0 ? "Amend the existing merge commit in place; do not add a commit on top of it." : ""}

Ticket specification:
${input.ticket.body}

Review finding history:
${JSON.stringify(history)}

Findings to address in this turn:
${feedback || "There are no prior integration findings."}`;
};

const integrateReviewed = (
  input: Schema.Schema.Type<typeof DeliveryTicketInput>,
  reviewed: Schema.Schema.Type<typeof Implemented>,
  expectedTargetCommit: string,
) =>
  Sandbox.use(`integrate-${input.ticket.number}`, {
    baseBranch: expectedTargetCommit,
    branch: `kojo-delivery-integration-${input.ticket.number}`,
    effect: Effect.gen(function* () {
      const openedHead = cleanOutput(
        (yield* successfulCommand("expected-target-head", "git rev-parse HEAD")).stdout,
      );
      if (openedHead.toLowerCase() !== expectedTargetCommit.toLowerCase()) {
        return yield* failProof(
          "expected-target-head",
          `Integration opened ${openedHead}, expected ${expectedTargetCommit}.`,
        );
      }
      const merge = yield* Command.run("merge-reviewed-commit", {
        command: `git merge --no-ff --no-edit ${reviewed.finalCommit}`,
      });
      let repairedConflict = false;
      let repairReviewAttempts = 0;
      if (merge.exitCode !== 0) {
        repairedConflict = true;
        let history: Array<Schema.Schema.Type<typeof FindingHistory>> = [];
        yield* Agent.run("repair-integration", {
          prompt: repairPrompt(input, expectedTargetCommit, reviewed.finalCommit, history),
          success: ImplementerResult,
          failure: AgentStepFailure,
        });
        yield* Loop.run("integration-review", {
          maxIterations: 3,
          effect: ({ iteration }) =>
            Effect.gen(function* () {
              yield* proveExactMerge(expectedTargetCommit, reviewed.finalCommit);
              yield* runConfiguredVerification();
              const diff = yield* successfulCommand(
                "integration-cumulative-diff",
                `git diff --binary ${expectedTargetCommit}...HEAD`,
              );
              const before = yield* successfulCommand(
                "integration-review-head",
                "git rev-parse HEAD",
              );
              const review = yield* Agent.run("integration-reviewer", {
                prompt: reviewPrompt(input, diff.stdout, history),
                success: ReviewerResult,
                failure: AgentStepFailure,
              });
              const after = yield* successfulCommand(
                "integration-review-head-proof",
                "git rev-parse HEAD",
              );
              const status = yield* successfulCommand(
                "integration-review-worktree-proof",
                "git status --porcelain",
              );
              if (
                cleanOutput(before.stdout) !== cleanOutput(after.stdout) ||
                cleanOutput(status.stdout) !== ""
              ) {
                return yield* failProof(
                  "integration-read-only-review",
                  "The reviewer changed the integration.",
                );
              }
              let dispositions: ReadonlyArray<Schema.Schema.Type<typeof FindingDisposition>> = [];
              if (review.findings.length > 0) {
                const repair = yield* Agent.run("repair-integration-findings", {
                  prompt: repairPrompt(input, expectedTargetCommit, reviewed.finalCommit, [
                    ...history,
                    { attempt: iteration, findings: review.findings, dispositions: [] },
                  ]),
                  success: ImplementerResult,
                  failure: AgentStepFailure,
                });
                dispositions = repair.dispositions;
                if (!dispositionsMatch(review.findings, dispositions)) {
                  return yield* failProof(
                    "integration-dispositions",
                    "The repair did not disposition every integration finding exactly once.",
                  );
                }
              }
              history = [
                ...history,
                { attempt: iteration, findings: review.findings, dispositions: [...dispositions] },
              ];
              repairReviewAttempts = history.length;
              return history.at(-1) as Schema.Schema.Type<typeof FindingHistory>;
            }),
          repeatWhile: (entry: Schema.Schema.Type<typeof FindingHistory>) =>
            entry.findings.length > 0,
        });
      }
      const proof = yield* proveExactMerge(expectedTargetCommit, reviewed.finalCommit);
      return { ...proof, repairedConflict, repairReviewAttempts };
    }),
  });

const verifyIntegrated = (ticketNumber: number, targetCommit: string) =>
  Sandbox.use(`verify-${ticketNumber}`, {
    baseBranch: targetCommit,
    branch: `kojo-delivery-verify-${ticketNumber}`,
    effect: Effect.gen(function* () {
      const opened = cleanOutput(
        (yield* successfulCommand("verified-target-head", "git rev-parse HEAD")).stdout,
      );
      if (opened.toLowerCase() !== targetCommit.toLowerCase()) {
        return yield* failProof(
          "verified-target-head",
          `Verification opened ${opened}, expected ${targetCommit}.`,
        );
      }
      yield* runConfiguredVerification();
      return opened;
    }),
  });

const publishIntegrated = (
  github: GitHubDeliveryService,
  rootUrl: ParsedRootUrl,
  routing: DeliveryRouting,
  inputGraph: GitHubDeliveryGraph,
  input: Schema.Schema.Type<typeof DeliveryTicketInput>,
  reviewed: Schema.Schema.Type<typeof Implemented>,
  expectedTargetCommit: string,
) =>
  Effect.gen(function* () {
    const integrated = yield* integrateReviewed(input, reviewed, expectedTargetCommit);
    const verifiedCommit = yield* verifyIntegrated(input.ticket.number, integrated.head);

    const reloadedUnknown = yield* durableGitHub(
      `reload-workstream-${input.ticket.number}`,
      Schema.Unknown,
      github.load(rootUrl.canonical),
    );
    const reloaded = yield* Effect.try({
      try: () => decodeGraphSync(reloadedUnknown),
      catch: (error) => invalid([`GitHub returned an invalid publication graph: ${error}`]),
    });
    const reloadedRouting = parseDelivery(reloaded.root.body);
    const revalidated = validateGraph(reloaded, rootUrl);
    const reloadedTicket = revalidated.tickets.find(
      ({ ticket }) => ticket.number === input.ticket.number,
    );
    const originalRoot = inputGraph.root;
    if (
      revalidated.diagnostics.length > 0 ||
      reloadedRouting === undefined ||
      reloadedRouting.targetBranch !== routing.targetBranch ||
      reloadedRouting.destinationBranch !== routing.destinationBranch ||
      reloadedRouting.sourceRevision !== routing.sourceRevision ||
      reloaded.root.number !== originalRoot.number ||
      reloaded.root.title !== originalRoot.title ||
      reloaded.root.body !== originalRoot.body ||
      reloaded.root.url !== originalRoot.url ||
      reloaded.root.children.totalCount !== originalRoot.children.totalCount ||
      JSON.stringify(
        reloaded.root.children.nodes.map(({ number }) => number).sort((a, b) => a - b),
      ) !==
        JSON.stringify(
          originalRoot.children.nodes.map(({ number }) => number).sort((a, b) => a - b),
        ) ||
      reloadedTicket === undefined ||
      JSON.stringify(
        normalizeSpecification(reloadedTicket.ticket, reloadedTicket.publicationKey),
      ) !== JSON.stringify(input.ticket)
    ) {
      return yield* failProof(
        "publication-drift",
        `Ticket #${input.ticket.number}, its relationships, routing, or provenance changed after review.`,
      );
    }

    const read = (suffix: string) =>
      durableGitHub(
        `read-publication-${input.ticket.number}-${suffix}`,
        PublicationSnapshotSchema,
        github.readPublication({
          repository: rootUrl.repository,
          targetBranch: routing.targetBranch,
          ticketNumber: input.ticket.number,
        }),
      );
    const before = yield* read("before");
    if (
      before.remoteTargetCommit.toLowerCase() !== expectedTargetCommit.toLowerCase() &&
      before.remoteTargetCommit.toLowerCase() !== verifiedCommit.toLowerCase()
    ) {
      return yield* failProof(
        "publication-expected-state",
        `Remote target moved to ${before.remoteTargetCommit}; expected ${expectedTargetCommit}.`,
      );
    }
    if (
      before.ticketState === "CLOSED" &&
      before.remoteTargetCommit.toLowerCase() !== verifiedCommit.toLowerCase()
    ) {
      return yield* failProof(
        "publication-ticket-state",
        `Ticket #${input.ticket.number} closed before its verified commit was published.`,
      );
    }
    const pushKey = `${input.ticket.publicationKey}:push:${verifiedCommit}`;
    const pushReceipt =
      before.remoteTargetCommit.toLowerCase() === verifiedCommit.toLowerCase()
        ? {
            idempotencyKey: pushKey,
            state: "AlreadyApplied" as const,
            targetCommit: verifiedCommit,
          }
        : yield* durableGitHub(
            `push-ticket-${input.ticket.number}`,
            PublicationReceiptSchema,
            github.pushExact({
              expectedTargetCommit,
              idempotencyKey: pushKey,
              repository: rootUrl.repository,
              targetBranch: routing.targetBranch,
              targetCommit: verifiedCommit,
            }),
          );
    if (
      pushReceipt.idempotencyKey !== pushKey ||
      pushReceipt.targetCommit.toLowerCase() !== verifiedCommit.toLowerCase()
    ) {
      return yield* failProof("publication-push-receipt", "Push receipt did not match its intent.");
    }
    const afterPush = yield* read("after-push");
    if (afterPush.remoteTargetCommit.toLowerCase() !== verifiedCommit.toLowerCase()) {
      return yield* failProof(
        "publication-push-proof",
        "The exact verified commit was not published.",
      );
    }
    const closeKey = `${input.ticket.publicationKey}:close:${verifiedCommit}`;
    const closeReceipt =
      afterPush.ticketState === "CLOSED"
        ? {
            idempotencyKey: closeKey,
            state: "AlreadyApplied" as const,
            targetCommit: verifiedCommit,
          }
        : yield* durableGitHub(
            `close-ticket-${input.ticket.number}`,
            PublicationReceiptSchema,
            github.closeTicket({
              expectedState: "OPEN",
              idempotencyKey: closeKey,
              repository: rootUrl.repository,
              targetCommit: verifiedCommit,
              ticketNumber: input.ticket.number,
            }),
          );
    if (
      closeReceipt.idempotencyKey !== closeKey ||
      closeReceipt.targetCommit.toLowerCase() !== verifiedCommit.toLowerCase()
    ) {
      return yield* failProof(
        "publication-close-receipt",
        "Close receipt did not match its intent.",
      );
    }
    const completed = yield* read("completed");
    if (
      completed.remoteTargetCommit.toLowerCase() !== verifiedCommit.toLowerCase() ||
      completed.ticketState !== "CLOSED"
    ) {
      return yield* failProof("publication-completion-proof", "Publication did not converge.");
    }
    return {
      _tag: "Published" as const,
      ticket: reviewed.ticket,
      reviewedCommit: reviewed.finalCommit,
      integratedCommit: integrated.head,
      verifiedCommit,
      mergeParents: integrated.parents,
      repairedConflict: integrated.repairedConflict,
      repairReviewAttempts: integrated.repairReviewAttempts,
      reviewAttempts: reviewed.reviewAttempts,
      findingHistory: reviewed.findingHistory,
      pushReceipt,
      closeReceipt,
    };
  });

export const DeliveryTicket = Workflow.make("delivery-ticket", {
  version: "1",
  entryPoint: "packages/delivery-workflow/src/index.ts",
  input: DeliveryTicketInput,
  success: DeliveryTicketOutcome,
  failure: Schema.Unknown,
  run: (input) =>
    Sandbox.use(`ticket-${input.ticket.number}`, {
      baseBranch: input.baseCommit,
      branch: input.branch,
      effect: Effect.gen(function* () {
        const sandbox = { name: `ticket-${input.ticket.number}`, branch: input.branch };
        let history: Array<Schema.Schema.Type<typeof FindingHistory>> = [];
        let finalCommit = input.baseCommit;
        const initial = yield* Agent.run("implement", {
          prompt: implementationPrompt(input, history),
          success: ImplementerResult,
          failure: AgentStepFailure,
        });
        if (!dispositionsMatch([], initial.dispositions)) {
          return yield* failProof(
            "implementer-dispositions",
            "The implementer returned dispositions that do not match the routed findings.",
          );
        }

        const reviewed = yield* Loop.run("review", {
          maxIterations: 3,
          effect: ({ iteration }) =>
            Effect.gen(function* () {
              const proof = yield* proveImplementation(input.baseCommit);
              finalCommit = proof.head;
              const diff = yield* successfulCommand(
                "cumulative-diff",
                `git diff --binary ${input.baseCommit}...HEAD`,
              );
              const review = yield* Agent.run("reviewer", {
                prompt: reviewPrompt(input, diff.stdout, history),
                success: ReviewerResult,
                failure: AgentStepFailure,
              });
              const afterHead = yield* successfulCommand("review-head-proof", "git rev-parse HEAD");
              const afterStatus = yield* successfulCommand(
                "review-worktree-proof",
                "git status --porcelain",
              );
              if (
                cleanOutput(afterHead.stdout) !== proof.head ||
                cleanOutput(afterStatus.stdout) !== proof.status
              ) {
                return yield* failProof(
                  "read-only-review",
                  "The reviewer changed the commit or worktree.",
                );
              }

              let dispositions: ReadonlyArray<Schema.Schema.Type<typeof FindingDisposition>> = [];
              if (review.findings.length > 0) {
                const repair = yield* Agent.run("repair", {
                  prompt: implementationPrompt(input, [
                    ...history,
                    { attempt: iteration, findings: review.findings, dispositions: [] },
                  ]),
                  success: ImplementerResult,
                  failure: AgentStepFailure,
                });
                dispositions = repair.dispositions;
                if (!dispositionsMatch(review.findings, dispositions)) {
                  return yield* failProof(
                    "implementer-dispositions",
                    "The implementer did not disposition every routed finding exactly once.",
                  );
                }
              }
              const entry = {
                attempt: iteration,
                findings: review.findings,
                dispositions: [...dispositions],
              };
              history = [...history, entry];
              return entry;
            }),
          repeatWhile: (entry: Schema.Schema.Type<typeof FindingHistory>) =>
            entry.findings.length > 0,
        }).pipe(
          Effect.catch((failure) =>
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            failure._tag === "Loop.MaximumLimitReached"
              ? Effect.succeed({
                  _tag: "ReviewLimit" as const,
                  failure: failure as Schema.Schema.Type<typeof Loop.MaximumLimitReached>,
                })
              : Effect.fail(failure),
          ),
        );

        if ("_tag" in reviewed && reviewed._tag === "ReviewLimit") {
          const finalHead = yield* successfulCommand("review-limit-head", "git rev-parse HEAD");
          finalCommit = cleanOutput(finalHead.stdout);
          return {
            _tag: "ReviewLimitReached" as const,
            ticket: ticketIdentity(input.ticket),
            sandbox,
            baseCommit: input.baseCommit,
            finalCommit,
            reviewAttempts: history.length,
            findingHistory: history,
            failure: reviewed.failure,
          };
        }
        return {
          _tag: "Implemented" as const,
          ticket: ticketIdentity(input.ticket),
          sandbox,
          baseCommit: input.baseCommit,
          finalCommit,
          reviewAttempts: history.length,
          findingHistory: history,
        };
      }),
    }) as Effect.Effect<
      DeliveryTicketOutcome,
      unknown,
      AgentProviderService | SandboxProviderService
    >,
});

export const Delivery = Workflow.make("delivery", {
  version: "2",
  entryPoint: "packages/delivery-workflow/src/index.ts",
  input: DeliveryInput,
  success: DeliveryResult,
  failure: DeliveryFailure,
  run: ({ workstream }) =>
    Effect.gen(function* () {
      const rootUrl = parseRootUrl(workstream);
      if (rootUrl === undefined) {
        return yield* Effect.fail(
          invalid(["Expected a canonical GitHub issue URL for the Delivery Workstream root."]),
        );
      }
      const github = yield* GitHubDelivery;
      const loaded = yield* github.load(rootUrl.canonical);
      const inputGraph = yield* Effect.try({
        try: () => decodeGraphSync(loaded),
        catch: (error) => invalid([`GitHub returned an invalid native graph: ${error}`]),
      });
      const routing = parseDelivery(inputGraph.root.body);
      const validated = validateGraph(inputGraph, rootUrl);
      if (validated.diagnostics.length > 0 || routing === undefined) {
        return yield* Effect.fail(
          invalid(
            routing === undefined
              ? [
                  ...validated.diagnostics,
                  "The root must contain one valid immutable Delivery section.",
                ]
              : validated.diagnostics,
            inputGraph,
          ),
        );
      }
      const reachable = yield* github.isSourceRevisionReachable({
        repository: rootUrl.repository,
        revision: routing.sourceRevision,
        targetBranch: routing.targetBranch,
      });
      if (!reachable) {
        return yield* Effect.fail(
          invalid([`Source revision '${routing.sourceRevision}' is not reachable.`], inputGraph),
        );
      }

      const sortedTickets = validated.tickets;
      const normalizedSpecifications = sortedTickets.map(({ publicationKey, ticket }) => ({
        number: ticket.number,
        title: ticket.title.trim(),
        body: ticket.body.replace(/\r\n/g, "\n").trim(),
        publicationKey,
        parentNumber: ticket.parent?.number ?? rootUrl.number,
        blockerNumbers: ticket.blockedBy.nodes.map(({ number }) => number).sort((a, b) => a - b),
      }));
      const eligibleWork = sortedTickets
        .filter(({ ticket }) => ticket.state === "OPEN")
        .map(({ publicationKey, ticket }) => ({ number: ticket.number, publicationKey }));
      const ready = sortedTickets
        .filter(
          ({ ticket }) =>
            ticket.state === "OPEN" &&
            ticket.blockedBy.nodes.every(({ state }) => state === "CLOSED"),
        )
        .map(({ publicationKey, ticket }) => ({ number: ticket.number, publicationKey }));
      const selected = ready.slice(0, 2);
      const exclusions: Array<Schema.Schema.Type<typeof Exclusion>> = [];
      for (const { publicationKey, ticket } of sortedTickets) {
        if (ticket.state === "CLOSED") {
          exclusions.push({
            number: ticket.number,
            publicationKey,
            reason: "Closed",
            blockerNumbers: [],
          });
          continue;
        }
        const blockerNumbers = ticket.blockedBy.nodes
          .filter(({ state }) => state !== "CLOSED")
          .map(({ number }) => number)
          .sort((a, b) => a - b);
        if (blockerNumbers.length > 0) {
          exclusions.push({
            number: ticket.number,
            publicationKey,
            reason: "Blocked",
            blockerNumbers,
          });
        }
      }
      const decision =
        sortedTickets.length === 0
          ? "NothingToDo"
          : eligibleWork.length === 0
            ? "AlreadyComplete"
            : ready.length === 0
              ? "OpenWorkNoReadyTicket"
              : "Ready";
      const normalizedInputGraph: GitHubDeliveryGraph = {
        root: {
          ...inputGraph.root,
          assignees: [...inputGraph.root.assignees].sort(),
          labels: [...inputGraph.root.labels].sort(),
          children: {
            ...inputGraph.root.children,
            nodes: [...inputGraph.root.children.nodes].sort((a, b) => a.number - b.number),
          },
        },
        tickets: sortedTickets.map(({ ticket }) => ({
          ...ticket,
          assignees: [...ticket.assignees].sort(),
          labels: [...ticket.labels].sort(),
          blockedBy: {
            ...ticket.blockedBy,
            nodes: [...ticket.blockedBy.nodes].sort((a, b) => a.number - b.number),
          },
        })),
      };
      const evidence: Schema.Schema.Type<typeof DeliveryEvidence> = {
        inputGraph: normalizedInputGraph,
        routing: {
          targetBranch: routing.targetBranch,
          destinationBranch: routing.destinationBranch,
        },
        normalizedSpecifications,
        sourceRevision: routing.sourceRevision,
        eligibleWork,
        exclusions,
        frontier: { decision, tickets: selected },
      };
      switch (decision) {
        case "NothingToDo":
          return { _tag: "NothingToDo" as const, evidence };
        case "AlreadyComplete":
          return { _tag: "AlreadyComplete" as const, evidence };
        case "OpenWorkNoReadyTicket":
          return { _tag: "OpenWorkNoReadyTicket" as const, evidence };
        case "Ready": {
          const initialPublication = yield* durableGitHub(
            "capture-target-head",
            PublicationSnapshotSchema,
            github.readPublication({
              repository: rootUrl.repository,
              targetBranch: routing.targetBranch,
              ticketNumber: selected[0]?.number ?? rootUrl.number,
            }),
          );
          if (!exactCommit(initialPublication.remoteTargetCommit)) {
            return yield* Effect.fail(
              invalid(["The target branch did not resolve to an exact commit."], inputGraph),
            );
          }
          if (initialPublication.ticketState !== "OPEN") {
            return yield* Effect.fail(
              invalid(
                ["The selected ticket changed state while the target HEAD was captured."],
                inputGraph,
              ),
            );
          }
          const implementations = yield* Effect.all(
            selected.map((selectedTicket) => {
              const specification = normalizedSpecifications.find(
                ({ number }) => number === selectedTicket.number,
              );
              if (specification === undefined) {
                return Effect.die(
                  `Ready ticket #${selectedTicket.number} has no normalized specification`,
                );
              }
              return DeliveryTicket.run(`ticket-${selectedTicket.number}`, {
                baseCommit: initialPublication.remoteTargetCommit,
                branch: `kojo-delivery-ticket-${selectedTicket.number}`,
                destinationBranch: routing.destinationBranch,
                targetBranch: routing.targetBranch,
                ticket: specification,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.succeed({
                    _tag: "TicketFailed" as const,
                    ticket: selectedTicket,
                    failure: ticketFailureFromCause(cause),
                  }),
                ),
              );
            }),
            { concurrency: 2 },
          );
          const ticketOutcomes: Array<
            | Schema.Schema.Type<typeof Published>
            | Schema.Schema.Type<typeof ReviewLimitReached>
            | Schema.Schema.Type<typeof TicketFailed>
          > = [];
          let expectedTargetCommit = initialPublication.remoteTargetCommit;
          for (const implementation of implementations) {
            if (implementation._tag !== "Implemented") {
              ticketOutcomes.push(implementation);
              continue;
            }
            const specification = normalizedSpecifications.find(
              ({ number }) => number === implementation.ticket.number,
            );
            if (specification === undefined) {
              return yield* Effect.die(
                `Implemented ticket #${implementation.ticket.number} has no normalized specification`,
              );
            }
            const published = yield* publishIntegrated(
              github,
              rootUrl,
              routing,
              inputGraph,
              {
                baseCommit: initialPublication.remoteTargetCommit,
                branch: `kojo-delivery-ticket-${implementation.ticket.number}`,
                destinationBranch: routing.destinationBranch,
                targetBranch: routing.targetBranch,
                ticket: specification,
              },
              implementation,
              expectedTargetCommit,
            ).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  Effect.succeed({
                    _tag: "TicketFailed" as const,
                    ticket: implementation.ticket,
                    failure: ticketFailureFromCause(cause),
                  }),
                onSuccess: Effect.succeed,
              }),
            );
            ticketOutcomes.push(published);
            if (published._tag === "Published") expectedTargetCommit = published.verifiedCommit;
          }
          return {
            _tag: ticketOutcomes.some(({ _tag }) => _tag !== "Published")
              ? ("TicketsFailed" as const)
              : ("OpenWork" as const),
            evidence,
            ticketOutcomes,
          };
        }
      }
    }) as Effect.Effect<
      DeliveryResult,
      DeliveryFailure,
      AgentProviderService | GitHubDeliveryService | SandboxProviderService
    >,
});
