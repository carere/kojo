import { Effect } from "effect";
import { DeliveryMetadata } from "../../types/delivery";
import { WorkflowError } from "../../types/errors";

const metadataFailure = (message: string) =>
  new WorkflowError({ message, operation: "delivery.parseMetadata" });

const deliveryMetadataHeadings = (body: string) => [...body.matchAll(/^## Delivery[\t ]*\r?$/gm)];

export const hasDeliveryMetadataHeading = (body: string) =>
  deliveryMetadataHeadings(body).length > 0;

const sectionValue = Effect.fn("deliveryMetadataSectionValue")(function* (
  section: string,
  field: string,
) {
  const expression = new RegExp(`^- ${field}:\\s*(.+?)\\s*$`, "gm");
  const matches = [...section.matchAll(expression)];
  if (matches.length !== 1) {
    return yield* metadataFailure(`Delivery metadata requires exactly one '${field}'`);
  }

  const raw = matches[0]?.[1]?.trim() ?? "";
  const value = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
  if (!value) {
    return yield* metadataFailure(`Delivery metadata '${field}' cannot be empty`);
  }
  return value;
});

export const parseDeliveryMetadata = Effect.fn("parseDeliveryMetadata")(function* (body: string) {
  const headings = deliveryMetadataHeadings(body);
  if (headings.length !== 1) {
    return yield* metadataFailure("Issue body requires exactly one '## Delivery' section");
  }

  const start = (headings[0]?.index ?? 0) + (headings[0]?.[0].length ?? 0);
  const remainder = body.slice(start);
  const nextHeading = remainder.search(/^## /m);
  const section = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
  const targetBranch = yield* sectionValue(section, "Target branch");
  const destinationBranch = yield* sectionValue(section, "Destination branch");
  const sourceRevision = (yield* sectionValue(section, "Source revision")).toLowerCase();

  if (targetBranch === destinationBranch) {
    return yield* metadataFailure("Delivery target and destination branches must differ");
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sourceRevision)) {
    return yield* metadataFailure("Delivery source revision must be a full Git commit object ID");
  }

  return new DeliveryMetadata({ destinationBranch, sourceRevision, targetBranch });
});

export const hasSameDeliveryMetadata = (left: DeliveryMetadata, right: DeliveryMetadata) =>
  left.targetBranch === right.targetBranch &&
  left.destinationBranch === right.destinationBranch &&
  left.sourceRevision === right.sourceRevision;
