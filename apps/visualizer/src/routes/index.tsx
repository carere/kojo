import { createQuery } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { healthQueryOptions } from "@/features/health/queries/get-health";

export const Route = createFileRoute("/")({
  component: VisualizerHome,
});

function VisualizerHome() {
  const health = createQuery(() => healthQueryOptions());

  return (
    <main class="mx-auto flex min-h-svh max-w-5xl flex-col justify-between px-6 py-10 sm:px-10 sm:py-14">
      <header class="flex items-center justify-between border-b pb-5">
        <div>
          <p class="font-medium text-muted-foreground text-xs uppercase tracking-[0.24em]">
            Delivery workflow factory
          </p>
          <h1 class="mt-2 font-semibold text-2xl tracking-tight">Kojo Visualizer</h1>
        </div>
        <div class="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 font-medium text-xs">
          <span
            class="size-2 rounded-full"
            classList={{
              "bg-amber-500": health.isPending,
              "bg-emerald-500": health.isSuccess,
              "bg-red-500": health.isError,
            }}
          />
          <Show when={health.isPending}>Connecting</Show>
          <Show when={health.isSuccess}>Server connected</Show>
          <Show when={health.isError}>Server unavailable</Show>
        </div>
      </header>

      <section class="grid gap-10 py-16 lg:grid-cols-[1.4fr_0.6fr] lg:items-end">
        <div>
          <p class="font-medium text-primary text-sm">工場 · factory</p>
          <h2 class="mt-4 max-w-3xl font-semibold text-5xl tracking-[-0.04em] sm:text-7xl">
            See delivery work as it happens.
          </h2>
          <p class="mt-6 max-w-2xl text-base text-muted-foreground leading-7">
            Kojo will expose sandbox activity, workflow progress, and completed work from one local
            control surface.
          </p>
        </div>

        <aside class="rounded-xl border bg-card p-5 shadow-sm">
          <p class="font-medium text-muted-foreground text-xs uppercase tracking-wider">
            Runtime status
          </p>
          <p class="mt-3 font-medium text-lg">
            <Show when={health.data} fallback="Waiting for Kojo">
              {(data) => `${data().service} is ${data().status}`}
            </Show>
          </p>
          <p class="mt-2 text-muted-foreground text-sm leading-6">
            Start the server with <code class="text-foreground">kojo serve &lt;project&gt;</code>.
          </p>
          <Show when={health.isError}>
            <Button class="mt-5" variant="outline" onClick={() => health.refetch()}>
              Retry connection
            </Button>
          </Show>
        </aside>
      </section>

      <footer class="border-t pt-5 text-muted-foreground text-xs">
        Direct delivery and webhook execution share the same Kojo runtime.
      </footer>
    </main>
  );
}
