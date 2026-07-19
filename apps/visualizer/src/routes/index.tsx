import { createQuery } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { onCleanup, onMount } from "solid-js";
import {
  PrototypeSwitcher,
  type PrototypeVariantOption,
} from "@/components/prototype/PrototypeSwitcher";
import { healthQueryOptions } from "@/features/health/queries/get-health";
import {
  MultiProjectDenseInspectorPrototype,
  type MultiProjectPrototypeVariant,
} from "@/features/multi-project-dense-inspector-prototype/MultiProjectDenseInspectorPrototype";

const variants: readonly PrototypeVariantOption<MultiProjectPrototypeVariant>[] = [
  { key: "A", name: "Project drill-down" },
  { key: "B", name: "Faceted run inbox" },
  { key: "C", name: "Project / workflow matrix" },
];

function isPrototypeVariant(value: unknown): value is MultiProjectPrototypeVariant {
  return value === "A" || value === "B" || value === "C";
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    variant: isPrototypeVariant(search.variant) ? search.variant : "A",
  }),
  component: VisualizerHome,
});

function VisualizerHome() {
  const health = createQuery(() => healthQueryOptions());
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const currentVariant = () => search().variant;

  const setVariant = (variant: MultiProjectPrototypeVariant) => {
    navigate({ replace: true, search: { variant } });
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
      const currentIndex = variants.findIndex((variant) => variant.key === currentVariant());
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      setVariant(variants[nextIndex].key);
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <>
      <MultiProjectDenseInspectorPrototype
        serverState={
          health.isPending ? "connecting" : health.isSuccess ? "connected" : "unavailable"
        }
        variant={currentVariant()}
      />
      {import.meta.env.DEV && (
        <PrototypeSwitcher current={currentVariant()} onSelect={setVariant} variants={variants} />
      )}
    </>
  );
}
