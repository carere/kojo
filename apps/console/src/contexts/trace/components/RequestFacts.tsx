import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { For, type JSX, Show } from "solid-js";

const httpUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** Authored public request facts. Links cannot execute scripts or contain URL credentials. */
export const RequestFacts = (props: {
  readonly request: NonNullable<RunDocument["request"]>;
}): JSX.Element => (
  <section class="grid gap-3 rounded-lg border border-border p-4" aria-label="Original request">
    <Show when={httpUrl(props.request.url)}>
      {(url) => (
        <a
          class="break-all text-sm underline"
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
        >
          {props.request.url}
        </a>
      )}
    </Show>
    <dl class="grid gap-3 sm:grid-cols-2">
      <For each={Object.entries(props.request.fields)}>
        {([label, value]) => (
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{label}</dt>
            <dd class="whitespace-pre-wrap break-words text-sm">{value}</dd>
          </div>
        )}
      </For>
    </dl>
  </section>
);
