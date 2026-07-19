import { For } from "solid-js";

export type PrototypeVariantOption<Key extends string> = {
  key: Key;
  name: string;
};

export function PrototypeSwitcher<Key extends string>(props: {
  current: Key;
  onSelect: (key: Key) => void;
  variants: readonly PrototypeVariantOption<Key>[];
}) {
  const currentIndex = () => props.variants.findIndex((variant) => variant.key === props.current);

  const cycle = (direction: -1 | 1) => {
    const nextIndex = (currentIndex() + direction + props.variants.length) % props.variants.length;
    props.onSelect(props.variants[nextIndex].key);
  };

  return (
    <nav
      aria-label="Prototype variants"
      class="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-zinc-950 p-1.5 font-sans text-white shadow-2xl shadow-black/35"
    >
      <button
        aria-label="Previous prototype variant"
        class="grid size-9 place-items-center rounded-full text-lg hover:bg-white/12"
        onClick={() => cycle(-1)}
        type="button"
      >
        ←
      </button>
      <div class="min-w-56 px-3 text-center">
        <p class="font-semibold text-xs">
          {props.current} — {props.variants.find((variant) => variant.key === props.current)?.name}
        </p>
        <div class="mt-1 flex justify-center gap-1">
          <For each={props.variants}>
            {(variant) => (
              <button
                aria-label={`Open ${variant.name}`}
                class={`h-1.5 w-6 rounded-full ${
                  variant.key === props.current ? "bg-white" : "bg-zinc-600"
                }`}
                onClick={() => props.onSelect(variant.key)}
                type="button"
              />
            )}
          </For>
        </div>
        <p class="mt-1 text-[9px] text-zinc-400">prototype · use ← →</p>
      </div>
      <button
        aria-label="Next prototype variant"
        class="grid size-9 place-items-center rounded-full text-lg hover:bg-white/12"
        onClick={() => cycle(1)}
        type="button"
      >
        →
      </button>
    </nav>
  );
}
