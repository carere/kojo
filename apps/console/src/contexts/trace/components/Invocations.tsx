import type {
  InvocationDocument,
  InvocationTotals,
} from "@carere/kojo-client-contracts/contexts/client/contracts/invocation";
import { For, Index, Show } from "solid-js";
import { useNow } from "../../shared/ports/Now.tsx";

const measured = (value: number | undefined): string =>
  value === undefined ? "Unavailable" : value.toLocaleString();

/** Retained prompts and public provider activity, including unfinished invocations. */
export const Invocations = (props: {
  readonly invocations: ReadonlyArray<InvocationDocument>;
  readonly totals?: InvocationTotals | undefined;
}) => {
  const now = useNow();
  return (
    <Show when={props.invocations.length > 0}>
      <section class="min-w-0 rounded-lg border border-border p-4" aria-label="Agent invocations">
        <h2 class="text-lg font-semibold">Agent invocations ({props.invocations.length})</h2>
        <p class="text-muted-foreground text-sm">
          Prompts and public provider activity. Missing measurements are unavailable.
        </p>
        <Show when={props.totals}>
          {(totals) => (
            <div class="mt-2 text-sm">
              <p>
                Reported charge:{" "}
                {totals().reportedCostUsd === undefined
                  ? "Unavailable"
                  : `$${totals().reportedCostUsd?.toFixed(4)}${totals().reportedCostPartial ? " (partial)" : ""}`}
              </p>
              <p>
                API estimate:{" "}
                {totals().estimatedCostUsd === undefined
                  ? "Unavailable"
                  : `$${totals().estimatedCostUsd?.toFixed(4)}${totals().estimatedCostPartial ? " (partial)" : ""}`}
              </p>
              <p>
                Fresh input tokens: {measured(totals().inputTokens)} · output:{" "}
                {measured(totals().outputTokens)}
                {totals().usagePartial ? " · partial usage" : ""}
              </p>
            </div>
          )}
        </Show>
        <div class="mt-3 flex min-w-0 flex-col gap-3">
          <For each={props.invocations.map((invocation) => invocation.invocationId)}>
            {(id) => {
              const initial = props.invocations.find((item) => item.invocationId === id);
              if (initial === undefined) return null;
              const invocation = () =>
                props.invocations.find((item) => item.invocationId === id) ?? initial;
              return (
                <details class="min-w-0 rounded-md border border-border p-3">
                  <summary class="cursor-pointer break-words">
                    <span class="font-medium">
                      {invocation().phasePath} · {invocation().agent}
                    </span>
                    <span class="ml-2 text-sm">
                      {invocation().state} ·{" "}
                      {Math.max(
                        0,
                        Math.floor(
                          ((invocation().state === "executing"
                            ? now()
                            : Date.parse(invocation().endedAt ?? invocation().lastActivityAt)) -
                            Date.parse(invocation().startedAt)) /
                            1000,
                        ),
                      )}
                      s
                      {invocation().state === "interrupted" && invocation().endedAt === undefined
                        ? " (last observed; end time unavailable)"
                        : ""}
                    </span>
                    <span class="block text-sm text-muted-foreground">
                      {invocation().provider} · {invocation().model} · attempt{" "}
                      {invocation().attempt}
                    </span>
                  </summary>
                  <div class="mt-3 flex min-w-0 flex-col gap-3 text-sm">
                    <p>
                      Last activity: {new Date(invocation().lastActivityAt).toLocaleTimeString()}
                    </p>
                    <Show when={invocation().redacted}>
                      <p>Credential values were redacted.</p>
                    </Show>
                    <Show when={invocation().truncated}>
                      <p>Some content was truncated or omitted.</p>
                    </Show>
                    <details>
                      <summary class="cursor-pointer">Prompts actually sent</summary>
                      <p class="my-2 text-muted-foreground">
                        {invocation().systemDelivery === "not-sent"
                          ? "This resumed turn did not resend system instructions."
                          : invocation().systemDelivery === "native-system"
                            ? "System instructions were sent through the provider system field."
                            : invocation().systemDelivery === "native-system-and-user-message"
                              ? "System instructions were sent through the provider system field and included in the rendered user message."
                              : "The rendered user message includes the system instructions. Provider-native instructions are not recorded unless the adapter exposes them."}
                      </p>
                      <h3 class="font-medium">System instructions</h3>
                      <pre class="my-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                        {invocation().system || "Not sent on this turn"}
                      </pre>
                      <h3 class="font-medium">User task and answer contract</h3>
                      <pre class="my-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                        {invocation().user}
                      </pre>
                      <h3 class="font-medium">Rendered provider input</h3>
                      <pre class="my-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                        {invocation().renderedPrompt}
                      </pre>
                    </details>
                    <details>
                      <summary class="cursor-pointer">Usage and cost</summary>
                      <dl class="mt-2 grid grid-cols-2 gap-2">
                        <dt>Fresh input tokens</dt>
                        <dd>{measured(invocation().usage?.inputTokens)}</dd>
                        <dt>Cache read tokens</dt>
                        <dd>{measured(invocation().usage?.cacheReadTokens)}</dd>
                        <dt>Cache write tokens</dt>
                        <dd>{measured(invocation().usage?.cacheWriteTokens)}</dd>
                        <dt>Output tokens</dt>
                        <dd>{measured(invocation().usage?.outputTokens)}</dd>
                        <dt>Current context</dt>
                        <dd>{measured(invocation().usage?.contextTokens)}</dd>
                        <dt>Context capacity</dt>
                        <dd>{measured(invocation().usage?.contextCapacity)}</dd>
                        <dt>Reported charge (USD)</dt>
                        <dd>
                          {invocation().usage?.reportedCostUsd ??
                            (invocation().state === "executing" ? "Pending" : "Unavailable")}
                        </dd>
                        <dt>API estimate (USD)</dt>
                        <dd>
                          {invocation().usage?.estimatedCostUsd ??
                            (invocation().state === "executing" ? "Pending" : "Unavailable")}
                        </dd>
                      </dl>
                      <Show when={invocation().usage?.estimateBasis}>
                        <p class="mt-2 text-muted-foreground">
                          {invocation().usage?.estimateBasis}
                        </p>
                      </Show>
                    </details>
                    <div>
                      <h3 class="font-medium">Activity ({invocation().activities.length})</h3>
                      <Index each={invocation().activities}>
                        {(activity) => (
                          <details class="mt-2 min-w-0 border-t border-border pt-2">
                            <summary class="cursor-pointer break-all">
                              {new Date(activity().at).toLocaleTimeString()} ·{" "}
                              {activity().kind.replaceAll("-", " ")}
                              {activity().name === undefined ? "" : ` · ${activity().name}`}
                              {activity().failed ? " · failed" : ""}
                            </summary>
                            <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                              {activity().text}
                            </pre>
                          </details>
                        )}
                      </Index>
                      <Show when={invocation().activities.length === 0}>
                        <p class="mt-2 text-muted-foreground">No provider activity received yet.</p>
                      </Show>
                    </div>
                  </div>
                </details>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
};
