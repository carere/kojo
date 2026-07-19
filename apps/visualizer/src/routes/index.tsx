import { createQuery } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { onCleanup, onMount } from "solid-js";
import { healthQueryOptions } from "@/features/health/queries/get-health";
import { RunVisualizerPrototype } from "@/features/run-visualizer-prototype/RunVisualizerPrototype";

type PrototypeVariant = "A" | "B" | "C" | "D";

function isPrototypeVariant(value: unknown): value is PrototypeVariant {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    variant: isPrototypeVariant(search.variant) ? search.variant : "A",
  }),
  component: VisualizerHome,
});

// PROTOTYPE — Three read-only Workflow Run visualizer variants on the existing `/` route.
// Switch with `?variant=A`, `?variant=B`, `?variant=C`, or `?variant=D`.
// This code is intentionally throwaway.
function VisualizerHome() {
  const health = createQuery(() => healthQueryOptions());
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const variants: PrototypeVariant[] = ["A", "B", "C", "D"];
  const currentVariant = () => search().variant;

  const setVariant = (variant: PrototypeVariant) => {
    navigate({
      search: { variant },
      replace: true,
    });
  };

  const cycleVariant = (direction: -1 | 1) => {
    const currentIndex = variants.indexOf(currentVariant());
    const nextIndex = (currentIndex + direction + variants.length) % variants.length;
    setVariant(variants[nextIndex]);
  };

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, [contenteditable='true']") ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) {
        return;
      }

      event.preventDefault();
      cycleVariant(event.key === "ArrowLeft" ? -1 : 1);
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <>
      <RunVisualizerPrototype
        serverState={
          health.isPending ? "connecting" : health.isSuccess ? "connected" : "unavailable"
        }
        variant={currentVariant()}
      />
      {import.meta.env.DEV && (
        <PrototypeSwitcher
          current={currentVariant()}
          onNext={() => cycleVariant(1)}
          onPrevious={() => cycleVariant(-1)}
        />
      )}
    </>
  );
}

const variantNames: Record<PrototypeVariant, string> = {
  A: "Trace inspector",
  B: "Run story",
  C: "Evidence ledger",
  D: "Dense inspector",
};

function PrototypeSwitcher(props: {
  current: PrototypeVariant;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <nav
      aria-label="Prototype variants"
      class="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-zinc-950 p-1.5 text-white shadow-2xl shadow-black/35"
    >
      <button
        aria-label="Previous prototype variant"
        class="grid size-9 place-items-center rounded-full text-lg hover:bg-white/12"
        onClick={props.onPrevious}
        type="button"
      >
        ←
      </button>
      <div class="min-w-48 px-3 text-center">
        <p class="font-semibold text-xs">
          {props.current} — {variantNames[props.current]}
        </p>
        <p class="mt-0.5 text-[10px] text-zinc-400">prototype · use ← →</p>
      </div>
      <button
        aria-label="Next prototype variant"
        class="grid size-9 place-items-center rounded-full text-lg hover:bg-white/12"
        onClick={props.onNext}
        type="button"
      >
        →
      </button>
    </nav>
  );
}
