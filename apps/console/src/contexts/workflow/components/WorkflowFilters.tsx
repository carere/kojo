import type { JSX } from "solid-js";

export interface WorkflowFilterState {
  readonly text: string;
  readonly availability: "all" | "available" | "invalid" | "removed";
  readonly activity: "all" | "active" | "inactive";
}

export const WorkflowFilters = (props: {
  readonly filters: WorkflowFilterState;
  readonly onChange: (next: WorkflowFilterState) => void;
}): JSX.Element => (
  <div class="flex flex-wrap gap-2" data-slot="filters">
    <label class="grid gap-1 text-muted-foreground text-xs">
      Find
      <input
        aria-label="Find Workflows"
        class="min-w-56 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onInput={(event) => props.onChange({ ...props.filters, text: event.currentTarget.value })}
        placeholder="Name, source, fault, or revision"
        type="search"
        value={props.filters.text}
      />
    </label>
    <label class="grid gap-1 text-muted-foreground text-xs">
      Workflow
      <select
        aria-label="Workflow availability"
        class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onChange={(event) =>
          props.onChange({
            ...props.filters,
            availability: event.currentTarget.value as WorkflowFilterState["availability"],
          })
        }
        value={props.filters.availability}
      >
        <option value="all">All availability</option>
        <option value="available">Available</option>
        <option value="invalid">Invalid</option>
        <option value="removed">Removed</option>
      </select>
    </label>
    <label class="grid gap-1 text-muted-foreground text-xs">
      Activity
      <select
        aria-label="Workflow activity"
        class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
        onChange={(event) =>
          props.onChange({
            ...props.filters,
            activity: event.currentTarget.value as WorkflowFilterState["activity"],
          })
        }
        value={props.filters.activity}
      >
        <option value="all">All activity</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </label>
  </div>
);
