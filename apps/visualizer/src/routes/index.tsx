import { createFileRoute } from "@tanstack/solid-router";
import { Button } from "#components/ui/button";

export const Route = createFileRoute("/")({
  component: VisualizerHome,
});

function VisualizerHome() {
  return (
    <main class="mx-auto flex min-h-screen max-w-3xl items-center px-6">
      <section class="space-y-6">
        <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
          Kojo visualizer
        </p>
        <h1 class="font-semibold text-4xl tracking-tight">The new Kojo starts here.</h1>
        <p class="max-w-xl text-base text-muted-foreground leading-7">
          The SolidJS application, its Zaidan component registry, and the shared development
          toolchain are ready for the next iteration.
        </p>
        <Button type="button">Ready</Button>
      </section>
    </main>
  );
}
