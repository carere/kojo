import type {
  InvocationDocument,
  InvocationUsage,
} from "@carere/kojo-client-contracts/contexts/client/contracts/invocation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};

/** Assemble retained observations without making old Claim activity appear live. */
export const invocationDocuments = (
  records: ReadonlyArray<Record<string, JsonValue>>,
): ReadonlyArray<InvocationDocument> => {
  const groups = new Map<string, Array<Record<string, JsonValue>>>();
  for (const record of records) {
    const id = String(record.invocationId);
    const group = groups.get(id) ?? [];
    group.push(record);
    groups.set(id, group);
  }
  const documents: InvocationDocument[] = [];
  for (const [invocationId, group] of groups) {
    group.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const first = group.find((record) => object(record.activity).kind === "started");
    if (first === undefined) continue;
    const start = object(first.activity);
    const finish = group.find((record) => object(record.activity).kind === "finished");
    const ended = object(finish?.activity);
    const measured = object(ended.usage);
    const usage: InvocationUsage = Object.fromEntries(
      Object.entries(measured).filter(
        ([, value]) => typeof value === "number" || typeof value === "string",
      ),
    );
    const activities: Array<InvocationDocument["activities"][number]> = [];
    const toolNames = new Map<string, string>();
    let lastActivityAt = Number(start.at);
    let redacted = start.redacted === true;
    let truncated = start.truncated === true;
    for (const record of group) {
      const activity = object(record.activity);
      lastActivityAt = Math.max(lastActivityAt, Number(activity.at));
      redacted ||= activity.redacted === true;
      truncated ||= activity.truncated === true;
      const kind = activity.kind;
      if (
        kind !== "message" &&
        kind !== "tool-started" &&
        kind !== "tool-finished" &&
        kind !== "output" &&
        kind !== "omitted"
      )
        continue;
      if (typeof activity.toolId === "string" && typeof activity.name === "string")
        toolNames.set(activity.toolId, activity.name);
      const name =
        typeof activity.name === "string"
          ? activity.name
          : typeof activity.toolId === "string"
            ? toolNames.get(activity.toolId)
            : undefined;
      activities.push({
        sequence: Number(record.sequence),
        kind,
        at: new Date(Number(activity.at)).toISOString(),
        text: String(activity.text),
        ...(name === undefined ? {} : { name }),
        ...(typeof activity.toolId === "string" ? { toolId: activity.toolId } : {}),
        ...(typeof activity.failed === "boolean" ? { failed: activity.failed } : {}),
        ...(activity.redacted === true ? { redacted: true } : {}),
        ...(activity.truncated === true ? { truncated: true } : {}),
      });
    }
    const outcome = ended.outcome;
    documents.push({
      invocationId,
      phasePath: String(first.phasePath),
      attempt: Number(first.attempt),
      agent: String(start.agent),
      provider: String(start.provider),
      model: String(start.model),
      startedAt: new Date(Number(start.at)).toISOString(),
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      ...(finish === undefined ? {} : { endedAt: new Date(Number(ended.at)).toISOString() }),
      state:
        outcome === "succeeded" || outcome === "failed" || outcome === "interrupted"
          ? outcome
          : first.active === true
            ? "executing"
            : "interrupted",
      system: String(start.system),
      user: String(start.user),
      renderedPrompt: String(start.renderedPrompt),
      systemDelivery:
        start.systemDelivery === "native-system" ||
        start.systemDelivery === "native-system-and-user-message" ||
        start.systemDelivery === "not-sent"
          ? start.systemDelivery
          : "user-message",
      redacted,
      truncated,
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      activities,
    });
  }
  return documents;
};
