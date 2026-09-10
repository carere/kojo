import type { AgentProvider } from "@ai-hero/sandcastle";
import { Effect } from "effect";
import type { AgentActivity, AgentUsage } from "../models/AgentActivity.ts";
import type { AgentCall } from "../ports/AgentInvoker.ts";
import { visibleProviderActivity } from "./visibleProviderActivity.ts";

interface AgentObservation {
  readonly redact: (text: string) => { text: string; redacted: boolean; truncated: boolean };
  readonly provider: AgentProvider;
  readonly answer: () => string;
  readonly start: (renderedPrompt: string, resumed: boolean) => Effect.Effect<void>;
  readonly finish: (outcome: "succeeded" | "failed" | "interrupted") => Effect.Effect<void>;
}

/** Keep provider output bounded and remove known credential values before retention. */
export const observeAgent = (
  call: AgentCall,
  provider: AgentProvider,
  environment: Readonly<Record<string, string>>,
): AgentObservation => {
  const secrets = Object.entries({ ...environment, ...provider.env })
    .filter(
      ([name, value]) =>
        /token|secret|password|api[_-]?key|credential/i.test(name) && value.length >= 4,
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  const redact = (text: string) => {
    let safe = text;
    for (const secret of secrets) safe = safe.replaceAll(secret, "[redacted]");
    safe = safe
      .replace(
        /("(?:api[_-]?key|token|secret|password|access_token|refresh_token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[redacted]"',
      )
      .replace(
        /('(?:api[_-]?key|token|secret|password|access_token|refresh_token)'\s*:\s*)'(?:\\.|[^'\\])*'/gi,
        "$1'[redacted]'",
      )
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
      .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
    return {
      text: safe.slice(0, 32_768) + (safe.length > 32_768 ? "\n[truncated]" : ""),
      redacted: safe !== text,
      truncated: safe.length > 32_768,
    };
  };
  let queue = Promise.resolve();
  let count = 0;
  let omitted = 0;
  let remainingCharacters = 262_144;
  let usage: AgentUsage | undefined;
  let answerText = "";
  let resultText: string | undefined;
  const emit = (activity: AgentActivity) => call.observe?.(activity) ?? Effect.void;
  const enqueue = (activity: AgentActivity): void => {
    if (call.observe === undefined) return;
    const characters = "text" in activity ? activity.text.length : 0;
    if (count >= 512 || characters > remainingCharacters) {
      omitted += 1;
      return;
    }
    count += 1;
    remainingCharacters -= characters;
    queue = queue.then(() => Effect.runPromise(emit(activity)));
    // Attach a handler immediately; finish still observes and propagates a failed write.
    void queue.catch(() => undefined);
  };
  const textActivity = (
    kind: "message" | "tool-started" | "output",
    text: string,
    name?: string,
  ): void => {
    enqueue({
      kind,
      at: Date.now(),
      ...redact(text),
      ...(name === undefined ? {} : { name: redact(name).text }),
    });
  };
  return {
    redact,
    answer: () => resultText ?? answerText,
    provider: {
      ...provider,
      parseStreamLine: (line: string) => {
        const events = provider.parseStreamLine(line);
        const visible = visibleProviderActivity(line, provider.name);
        if (visible.usage !== undefined) usage = { ...usage, ...visible.usage };
        for (const activity of visible.activities) {
          if (activity.kind === "message") answerText += activity.text;
          enqueue({
            ...activity,
            at: Date.now(),
            ...redact(activity.text),
            ...(activity.name === undefined ? {} : { name: redact(activity.name).text }),
            ...(activity.toolId === undefined ? {} : { toolId: redact(activity.toolId).text }),
          });
        }
        for (const event of events) {
          if (visible.activities.length > 0 && event.type !== "usage") continue;
          if (event.type === "text") {
            answerText += event.text;
            textActivity("message", event.text);
          } else if (event.type === "result") {
            resultText = event.result;
            textActivity("output", event.result);
          } else if (event.type === "tool_call")
            textActivity("tool-started", event.args, event.name);
          else if (event.type === "usage") {
            const measurements = Object.fromEntries(
              Object.entries({
                inputTokens: event.usage.inputTokens,
                cacheReadTokens: event.usage.cacheReadInputTokens,
                cacheWriteTokens: event.usage.cacheCreationInputTokens,
                outputTokens: event.usage.outputTokens,
              }).filter(
                ([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0,
              ),
            );
            if (Object.keys(measurements).length > 0) usage = { ...usage, ...measurements };
          }
        }
        return events;
      },
    } satisfies AgentProvider,
    start: (renderedPrompt: string, resumed: boolean) => {
      const nativeSystem =
        "nativeSystemPrompt" in provider && typeof provider.nativeSystemPrompt === "string"
          ? provider.nativeSystemPrompt
          : undefined;
      const system = redact(nativeSystem ?? (resumed ? "" : call.system));
      const user = redact(call.prompt);
      const rendered = redact(renderedPrompt);
      return emit({
        kind: "started",
        at: Date.now(),
        agent: call.agent,
        provider: provider.name,
        model: call.model,
        system: system.text,
        user: user.text,
        renderedPrompt: rendered.text,
        systemDelivery:
          nativeSystem === undefined
            ? resumed
              ? "not-sent"
              : "user-message"
            : resumed
              ? "native-system"
              : "native-system-and-user-message",
        redacted: system.redacted || user.redacted || rendered.redacted,
        truncated: system.truncated || user.truncated || rendered.truncated,
      });
    },
    finish: (outcome: "succeeded" | "failed" | "interrupted") =>
      Effect.gen(function* () {
        yield* Effect.promise(() => queue);
        if (omitted > 0)
          yield* emit({
            kind: "omitted",
            at: Date.now(),
            text: `${omitted} provider events omitted after the retention limit`,
            truncated: true,
          });
        yield* emit({
          kind: "finished",
          at: Date.now(),
          outcome,
          ...(usage === undefined ? {} : { usage }),
        });
      }),
  };
};
