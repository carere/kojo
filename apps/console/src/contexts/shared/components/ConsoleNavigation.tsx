import { Link } from "@tanstack/solid-router";
import type { JSX } from "solid-js";

const navigation = [
  { label: "Projects", to: "/" as const },
  { label: "Runs", to: "/runs" as const },
  { label: "Gate", to: "/gates" as const },
  { label: "Daemon", to: "/daemon" as const },
] as const;

export const ConsoleNavigation = (props: { readonly current: string }): JSX.Element => (
  <aside class="border-border border-b pb-4 lg:border-r lg:border-b-0 lg:pr-6">
    <p class="mb-4 font-semibold text-lg">Kojo Console</p>
    <nav aria-label="Console" class="flex flex-wrap gap-2 lg:flex-col">
      {navigation.map((entry) => (
        <Link
          aria-current={props.current === entry.label ? "page" : undefined}
          class={
            props.current === entry.label
              ? "rounded-md bg-foreground px-3 py-2 text-sm text-background"
              : "rounded-md px-3 py-2 text-sm hover:bg-muted"
          }
          to={entry.to}
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  </aside>
);
