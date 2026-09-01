import type { JSX } from "solid-js";

export interface ProjectFilters {
  readonly factory: "all" | "available" | "invalid" | "missing";
  readonly project: "all" | "available" | "unavailable" | "archived";
  readonly text: string;
}

/** A deep local adaptation of Zaidan Filters for the three Project fields in this ticket. */
export const Filters = (props: {
  readonly filters: ProjectFilters;
  readonly onChange: (next: ProjectFilters) => void;
}): JSX.Element => (
  <div class="flex flex-wrap gap-2" data-slot="filters">
    <label class="grid gap-1 text-muted-foreground text-xs">
      Find
      <input
        aria-label="Find Projects"
        class="min-w-56 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onInput={(event) => props.onChange({ ...props.filters, text: event.currentTarget.value })}
        placeholder="Name, ID, or location"
        type="search"
        value={props.filters.text}
      />
    </label>
    <label class="grid gap-1 text-muted-foreground text-xs">
      Project
      <select
        aria-label="Project state"
        class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onChange={(event) =>
          props.onChange({
            ...props.filters,
            project: event.currentTarget.value as ProjectFilters["project"],
          })
        }
        value={props.filters.project}
      >
        <option value="all">All states</option>
        <option value="available">Available</option>
        <option value="unavailable">Unavailable</option>
        <option value="archived">Archived</option>
      </select>
    </label>
    <label class="grid gap-1 text-muted-foreground text-xs">
      Factory
      <select
        aria-label="Factory state"
        class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onChange={(event) =>
          props.onChange({
            ...props.filters,
            factory: event.currentTarget.value as ProjectFilters["factory"],
          })
        }
        value={props.filters.factory}
      >
        <option value="all">All Factories</option>
        <option value="available">Available</option>
        <option value="missing">Missing</option>
        <option value="invalid">Invalid</option>
      </select>
    </label>
  </div>
);
