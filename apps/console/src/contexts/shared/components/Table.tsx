import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { cn } from "../lib/cn.ts";

/**
 * The table primitives, in Zaidan's shape.
 *
 * Zaidan is a shadcn port: its components are copied into the project rather than installed from a
 * registry, so they live here as ordinary source and are edited like anything else. They are
 * deliberately unopinionated about data — TanStack Table owns the row model, these own the markup —
 * which is what lets the same primitives carry the run list now and the phase table toggle later.
 *
 * The horizontal scroll belongs to the wrapper and not to the page. A run id is long and a factory
 * with long workflow names must never make the whole document scroll sideways.
 */
export const Table = (props: ComponentProps<"table">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div class="relative w-full overflow-x-auto">
      <table class={cn("w-full caption-bottom border-collapse text-sm", local.class)} {...rest} />
    </div>
  );
};

export const TableHeader = (props: ComponentProps<"thead">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return <thead class={cn("[&_tr]:border-b", local.class)} {...rest} />;
};

export const TableBody = (props: ComponentProps<"tbody">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return <tbody class={cn("[&_tr:last-child]:border-0", local.class)} {...rest} />;
};

export const TableRow = (props: ComponentProps<"tr">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <tr
      class={cn("border-border hover:bg-muted/50 border-b transition-colors", local.class)}
      {...rest}
    />
  );
};

export const TableHead = (props: ComponentProps<"th">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <th
      class={cn(
        "text-muted-foreground h-10 px-3 text-left align-middle font-medium whitespace-nowrap",
        local.class,
      )}
      {...rest}
    />
  );
};

export const TableCell = (props: ComponentProps<"td">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return <td class={cn("px-3 py-2 align-middle whitespace-nowrap", local.class)} {...rest} />;
};
