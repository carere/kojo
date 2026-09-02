import { useQuery } from "@tanstack/solid-query";
import type { JSX } from "solid-js";
import { ResourceList } from "../../shared/components/data-grid/ResourceList.tsx";
import { readRecentClientRequests } from "../services/browserAccess.ts";

/** Daemon-owned accepted long operations, retained across Console reloads. */
export const RecentChanges = (): JSX.Element => {
  const changes = useQuery(() => ({
    queryKey: ["client-requests"],
    queryFn: readRecentClientRequests,
  }));
  const requests = () => changes.data?.requests ?? [];
  return (
    <section class="flex flex-col gap-2" data-recent-changes>
      <header>
        <h2 class="font-semibold text-sm">Recent changes</h2>
        <p class="text-muted-foreground text-xs">
          Accepted work stays in Daemon history. Its request ID is the durable lookup.
        </p>
      </header>
      <ResourceList
        emptyMessage="No accepted changes are recorded by this Daemon."
        items={requests()}
        label="Recent changes"
        searchText={(change) =>
          `${change.request.requestId}\n${change.request.operation}\n${change.receipt?.status ?? "accepted"}`
        }
        render={(change) => (
          <div class="grid gap-1 text-xs" data-recent-request={change.request.requestId}>
            <span>
              <strong>{change.request.operation}</strong> · {change.receipt?.status ?? "accepted"}
            </span>
            <span class="text-muted-foreground">{change.request.target.kind}</span>
            <code>{change.request.requestId}</code>
          </div>
        )}
      />
    </section>
  );
};
