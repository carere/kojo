import { Effect, Array as EffectArray, Order } from "effect";
import { DeliveryWorkstream, type TrackerIssue } from "../../types/delivery";
import { WorkflowError } from "../../types/errors";
import { isOpenIssue, issueLabelNames } from "./issue";
import { parseDeliveryMetadata } from "./metadata";

const STATE_ROLE_LABELS = new Set([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
]);

const failValidation = (message: string) =>
  new WorkflowError({ message, operation: "delivery.validateWorkstream" });

const publicationKey = (body: string) => {
  const matches = [...body.matchAll(/<!--\s*delivery-ticket-key:\s*([^\s]+)\s*-->/g)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
};

const blockerGraphIsCyclic = (tickets: ReadonlyArray<TrackerIssue>) => {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const blockersByTicket = new Map(
    tickets.map((ticket) => [ticket.number, ticket.blockedBy.nodes.map(({ number }) => number)]),
  );

  const visit = (number: number): boolean => {
    if (visiting.has(number)) return true;
    if (visited.has(number)) return false;
    visiting.add(number);
    if ((blockersByTicket.get(number) ?? []).some(visit)) return true;
    visiting.delete(number);
    visited.add(number);
    return false;
  };

  return tickets.some(({ number }) => visit(number));
};

const validateRoot = Effect.fn("validateWorkstreamRoot")(function* (
  root: TrackerIssue,
  tickets: ReadonlyArray<TrackerIssue>,
  repositoryName?: string,
) {
  if (root.parent) return yield* failValidation(`Workstream root #${root.number} has a parent`);
  if (root.assignees.length > 0) {
    return yield* failValidation(`Workstream root #${root.number} is assigned`);
  }

  const stateLabel = issueLabelNames(root).find((label) => STATE_ROLE_LABELS.has(label));
  if (stateLabel) {
    return yield* failValidation(`Workstream root #${root.number} has state label '${stateLabel}'`);
  }
  if (root.subIssues.totalCount !== root.subIssues.nodes.length) {
    return yield* failValidation(`Workstream root #${root.number} has a truncated child graph`);
  }
  if (
    repositoryName &&
    root.subIssues.nodes.some((child) => child.repository && child.repository !== repositoryName)
  ) {
    return yield* failValidation(
      `Workstream root #${root.number} has a child from another repository`,
    );
  }

  const expectedChildren = new Set(root.subIssues.nodes.map(({ number }) => number));
  const hydratedChildren = new Set(tickets.map(({ number }) => number));
  if (
    expectedChildren.size !== hydratedChildren.size ||
    [...expectedChildren].some((number) => !hydratedChildren.has(number))
  ) {
    return yield* failValidation(`Workstream root #${root.number} child graph is incomplete`);
  }
});

const validateTickets = Effect.fn("validateWorkstreamTickets")(function* (
  root: TrackerIssue,
  tickets: ReadonlyArray<TrackerIssue>,
  standalone: boolean,
  repositoryName?: string,
) {
  const seenKeys = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.blockedBy.totalCount !== ticket.blockedBy.nodes.length) {
      return yield* failValidation(`Ticket #${ticket.number} has a truncated blocker graph`);
    }
    if (isOpenIssue(ticket)) {
      const stateLabels = issueLabelNames(ticket).filter((label) => STATE_ROLE_LABELS.has(label));
      if (stateLabels.length !== 1 || stateLabels[0] !== "ready-for-agent") {
        return yield* failValidation(
          `Ticket #${ticket.number} must have only the ready-for-agent state role`,
        );
      }
      if (ticket.assignees.length > 0) {
        return yield* failValidation(`Ticket #${ticket.number} is assigned`);
      }
    }
    if (standalone) continue;

    if (ticket.parent?.number !== root.number) {
      return yield* failValidation(
        `Ticket #${ticket.number} is not a native child of #${root.number}`,
      );
    }
    if (repositoryName && ticket.parent.repository && ticket.parent.repository !== repositoryName) {
      return yield* failValidation(`Ticket #${ticket.number} belongs to another repository`);
    }
    const key = publicationKey(ticket.body);
    if (!key || !new RegExp(`^#${root.number}::\\d{2,}$`).test(key)) {
      return yield* failValidation(`Ticket #${ticket.number} has an invalid delivery-ticket-key`);
    }
    if (seenKeys.has(key)) return yield* failValidation(`Duplicate delivery-ticket-key '${key}'`);
    seenKeys.add(key);
  }
});

const validateBlockers = Effect.fn("validateWorkstreamBlockers")(function* (
  root: TrackerIssue,
  tickets: ReadonlyArray<TrackerIssue>,
  repositoryName?: string,
) {
  const childNumbers = new Set(tickets.map(({ number }) => number));
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy.nodes) {
      if (!childNumbers.has(blocker.number)) {
        return yield* failValidation(
          `Ticket #${ticket.number} has blocker #${blocker.number} outside its root`,
        );
      }
      if (repositoryName && blocker.repository && blocker.repository !== repositoryName) {
        return yield* failValidation(
          `Ticket #${ticket.number} has a blocker from another repository`,
        );
      }
    }
  }
  if (blockerGraphIsCyclic(tickets)) {
    return yield* failValidation(`Workstream #${root.number} blocker graph is cyclic`);
  }
});

export const buildDeliveryWorkstream = Effect.fn("buildDeliveryWorkstream")(function* (
  root: TrackerIssue,
  tickets: ReadonlyArray<TrackerIssue>,
  repositoryName?: string,
  deliveryActor?: string,
) {
  if (!isOpenIssue(root)) {
    return yield* failValidation(`Workstream root #${root.number} is not open`);
  }
  if (tickets.length === 0) {
    return yield* failValidation(`Workstream #${root.number} has no ready tickets`);
  }

  const standalone = tickets.length === 1 && tickets[0]?.number === root.number && !root.parent;
  if (!standalone) yield* validateRoot(root, tickets, repositoryName);
  yield* validateTickets(root, tickets, standalone, repositoryName);
  if (!standalone) yield* validateBlockers(root, tickets, repositoryName);

  return new DeliveryWorkstream({
    delivery: yield* parseDeliveryMetadata(root.body),
    kind: standalone ? "standalone" : "root",
    root,
    tickets: EffectArray.sortWith(tickets, (ticket) => ticket.number, Order.Number),
    repository: repositoryName ?? "",
    deliveryActor: deliveryActor ?? "",
  });
});

export const selectReadyFrontier = (tickets: ReadonlyArray<TrackerIssue>) =>
  tickets.filter(
    (ticket) =>
      isOpenIssue(ticket) &&
      ticket.blockedBy.nodes.every((blocker) => blocker.state.toUpperCase() === "CLOSED"),
  );
