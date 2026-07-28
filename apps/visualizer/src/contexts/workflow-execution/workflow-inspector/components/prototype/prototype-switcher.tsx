import { ArrowLeft, ArrowRight } from "lucide-solid";
import { createEffect, onCleanup } from "solid-js";

export const prototypeVariants = [
  { key: "A", name: "Navigator" },
  { key: "B", name: "Operations timeline" },
  { key: "C", name: "Workflow canvas" },
] as const;

export type PrototypeVariant = (typeof prototypeVariants)[number]["key"];

interface PrototypeSwitcherProps {
  current: PrototypeVariant;
  onChange: (variant: PrototypeVariant) => void;
}

export function PrototypeSwitcher(props: PrototypeSwitcherProps) {
  const move = (offset: number) => {
    const currentIndex = prototypeVariants.findIndex((variant) => variant.key === props.current);
    const nextIndex = (currentIndex + offset + prototypeVariants.length) % prototypeVariants.length;
    props.onChange(prototypeVariants[nextIndex].key);
  };

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const currentName = () =>
    prototypeVariants.find((variant) => variant.key === props.current)?.name;

  return (
    <nav
      aria-label="Prototype variants"
      class="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-zinc-950 p-1.5 text-white shadow-2xl shadow-black/30"
    >
      <button
        type="button"
        aria-label="Previous variant"
        class="grid size-8 place-items-center rounded-full text-zinc-300 transition hover:bg-white/10 hover:text-white"
        onClick={() => move(-1)}
      >
        <ArrowLeft class="size-4" />
      </button>
      <div class="min-w-48 px-3 text-center">
        <p class="text-[10px] text-zinc-500 uppercase tracking-[0.2em]">Throwaway prototype</p>
        <p class="font-medium text-xs">
          {props.current} — {currentName()}
        </p>
      </div>
      <button
        type="button"
        aria-label="Next variant"
        class="grid size-8 place-items-center rounded-full text-zinc-300 transition hover:bg-white/10 hover:text-white"
        onClick={() => move(1)}
      >
        <ArrowRight class="size-4" />
      </button>
    </nav>
  );
}
