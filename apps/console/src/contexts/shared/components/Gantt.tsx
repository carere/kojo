import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { cn } from "../lib/cn.ts";

/** Local Gantt primitives for scope rows and immutable Run records. The Console does not expose timeline editing controls. */

/** The width of the row-label column. One number, because the header and the rows both need it. */
export const sidebarWidth = 176;

/** How tall one row is drawn. Fixed: a row is a scope, and scopes are not weighted by anything. */
export const rowHeight = 44;

/** The scroll container. Everything inside it shares one horizontal position by construction. */
export const Gantt = (props: ComponentProps<"div">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={cn("border-border relative w-full overflow-x-auto rounded-md border", local.class)}
      {...rest}
    />
  );
};

/** The band the timeline is drawn in, as wide as the axis rather than as wide as the viewport. */
export const GanttCanvas = (
  props: ComponentProps<"div"> & { readonly width: number },
): JSX.Element => {
  const [local, rest] = splitProps(props, ["class", "width", "style"]);
  return (
    <div
      class={cn("relative", local.class)}
      style={{ width: `${sidebarWidth + local.width}px`, ...(local.style as object) }}
      {...rest}
    />
  );
};

/** The scale row. Sticky at the top so it survives a long scope tree. */
export const GanttHeader = (props: ComponentProps<"div">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={cn(
        "bg-background border-border sticky top-0 z-20 flex h-9 items-stretch border-b",
        local.class,
      )}
      {...rest}
    />
  );
};

/** One row: its label pinned to the left, its spans laid out against the axis. */
export const GanttRow = (props: ComponentProps<"div">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={cn(
        "border-border/60 relative flex items-stretch border-b last:border-b-0",
        local.class,
      )}
      style={{ height: `${rowHeight}px` }}
      {...rest}
    />
  );
};

/**
 * The row label, pinned left.
 *
 * `sticky` rather than a second scrolling pane: two panes kept in step by an event handler is the
 * classic gantt defect, and one that only shows up once somebody scrolls fast.
 */
export const GanttSidebar = (
  props: ComponentProps<"div"> & { readonly depth?: number },
): JSX.Element => {
  const [local, rest] = splitProps(props, ["class", "depth", "style"]);
  return (
    <div
      class={cn(
        "bg-background border-border sticky left-0 z-10 flex shrink-0 flex-col justify-center gap-0.5 border-r px-3 py-1",
        local.class,
      )}
      style={{
        width: `${sidebarWidth}px`,
        "padding-left": `${12 + (local.depth ?? 0) * 14}px`,
        ...(local.style as object),
      }}
      {...rest}
    />
  );
};

/** Where spans are positioned. Relative, so every child is placed by pixel offset off the axis. */
export const GanttLane = (props: ComponentProps<"div">): JSX.Element => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={cn("relative flex-1", local.class)} {...rest} />;
};
