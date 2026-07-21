import { Workflow } from "@kojo/workflow";
import { Context, Effect, Schema } from "effect";

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
const OpenWork = Schema.TaggedStruct("OpenWork", { evidence: DeliveryEvidence });

export const DeliveryResult = Schema.Union([
  NothingToDo,
  AlreadyComplete,
  OpenWorkNoReadyTicket,
  OpenWork,
]);
export type DeliveryResult = Schema.Schema.Type<typeof DeliveryResult>;

const InvalidDeliveryWorkstream = Schema.TaggedStruct("InvalidDeliveryWorkstream", {
  diagnostics: Schema.Array(Schema.String),
  inputGraph: Schema.optional(GitHubDeliveryGraphSchema),
});

export const DeliveryFailure = Schema.Union([InvalidDeliveryWorkstream, GitHubDeliveryFailure]);
export type DeliveryFailure = Schema.Schema.Type<typeof DeliveryFailure>;

const DeliveryInput = Schema.Struct({ workstream: Schema.String });

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
    const number = Number(segments[3]);
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
    !/^[0-9a-f]{40}$/i.test(sourceRevision)
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

export const Delivery = Workflow.make("delivery", {
  version: "1",
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
        frontier: { decision, tickets: ready },
      };
      switch (decision) {
        case "NothingToDo":
          return { _tag: "NothingToDo" as const, evidence };
        case "AlreadyComplete":
          return { _tag: "AlreadyComplete" as const, evidence };
        case "OpenWorkNoReadyTicket":
          return { _tag: "OpenWorkNoReadyTicket" as const, evidence };
        case "Ready":
          return { _tag: "OpenWork" as const, evidence };
      }
    }),
});
