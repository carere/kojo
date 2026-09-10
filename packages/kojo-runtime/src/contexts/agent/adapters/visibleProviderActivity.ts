import type { AgentUsage } from "../models/AgentActivity.ts";

interface VisibleActivity {
  readonly kind: "message" | "tool-started" | "tool-finished";
  readonly text: string;
  readonly name?: string;
  readonly toolId?: string;
  readonly failed?: boolean;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const textContent = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((item) => object(item).type === "text" && typeof object(item).text === "string")
          .map((item) => object(item).text)
          .join("\n")
      : "";
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Read only public tool fields from known provider event shapes. Never retain raw JSON. */
export const visibleProviderActivity = (
  line: string,
  provider: string,
): { activities: ReadonlyArray<VisibleActivity>; usage?: AgentUsage } => {
  let event: Record<string, unknown>;
  try {
    event = object(JSON.parse(line));
  } catch {
    return { activities: [] };
  }
  const activities: VisibleActivity[] = [];
  const content = object(event.message).content;
  if ((event.type === "assistant" || event.type === "user") && Array.isArray(content)) {
    const hasTools = content.some((item) =>
      ["tool_use", "tool_result"].includes(String(object(item).type)),
    );
    for (const item of content) {
      const block = object(item);
      if (hasTools && block.type === "text" && typeof block.text === "string")
        activities.push({ kind: "message", text: block.text });
      else if (block.type === "tool_use" && typeof block.name === "string")
        activities.push({
          kind: "tool-started",
          name: block.name,
          text: JSON.stringify(block.input ?? {}),
          ...(typeof block.id === "string" ? { toolId: block.id } : {}),
        });
      else if (block.type === "tool_result")
        activities.push({
          kind: "tool-finished",
          text: textContent(block.content),
          failed: block.is_error === true,
          ...(typeof block.tool_use_id === "string" ? { toolId: block.tool_use_id } : {}),
        });
    }
  }
  if (event.type === "tool_result")
    activities.push({
      kind: "tool-finished",
      text: textContent(event.content),
      failed: event.is_error === true,
      ...(typeof event.tool_use_id === "string" ? { toolId: event.tool_use_id } : {}),
    });
  if (
    provider === "pi" &&
    (event.type === "tool_execution_start" || event.type === "tool_execution_end")
  ) {
    activities.push({
      kind: event.type === "tool_execution_start" ? "tool-started" : "tool-finished",
      text:
        event.type === "tool_execution_start"
          ? JSON.stringify(event.args ?? {})
          : textContent(object(event.result).content),
      ...(typeof event.toolName === "string" ? { name: event.toolName } : {}),
      ...(typeof event.toolCallId === "string" ? { toolId: event.toolCallId } : {}),
      ...(event.type === "tool_execution_end" ? { failed: event.isError === true } : {}),
    });
  }
  const item = object(event.item);
  if (
    provider === "codex" &&
    item.type === "command_execution" &&
    (event.type === "item.started" || event.type === "item.completed")
  ) {
    activities.push({
      kind: event.type === "item.started" ? "tool-started" : "tool-finished",
      name: "Bash",
      text: String(
        event.type === "item.started" ? (item.command ?? "") : (item.aggregated_output ?? ""),
      ),
      ...(typeof item.id === "string" ? { toolId: item.id } : {}),
      ...(event.type === "item.completed"
        ? { failed: typeof item.exit_code === "number" && item.exit_code !== 0 }
        : {}),
    });
  }
  const measurements: Record<string, number | string> = {};
  const add = (name: string, value: unknown) => {
    const measured = finite(value);
    if (measured !== undefined) measurements[name] = Number(measurements[name] ?? 0) + measured;
  };
  if (provider === "claude-code" && event.type === "result") {
    const reported = object(event.usage);
    add("inputTokens", reported.input_tokens);
    add("outputTokens", reported.output_tokens);
    add("cacheReadTokens", reported.cache_read_input_tokens);
    add("cacheWriteTokens", reported.cache_creation_input_tokens);
    add("estimatedCostUsd", event.total_cost_usd);
    if (measurements.estimatedCostUsd !== undefined)
      measurements.estimateBasis = "Claude Code reported API estimate; model rates are not exposed";
  }
  if (provider === "pi" && event.type === "agent_end" && Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (object(message).role !== "assistant") continue;
      const reported = object(object(message).usage);
      add("inputTokens", reported.input);
      add("outputTokens", reported.output);
      add("cacheReadTokens", reported.cacheRead);
      add("cacheWriteTokens", reported.cacheWrite);
      add("estimatedCostUsd", object(reported.cost).total);
    }
    if (measurements.estimatedCostUsd !== undefined)
      measurements.estimateBasis = "pi reported API estimate from its configured model rates";
  }
  return {
    activities,
    ...(Object.keys(measurements).length === 0 ? {} : { usage: measurements }),
  };
};
