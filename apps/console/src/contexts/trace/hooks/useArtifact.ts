import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { fetchText, refused } from "../../shared/services/api.ts";

/** The three things the trace deliberately does not store. */
export type ArtifactKind = "prompt" | "session" | "diff";

/**
 * One artifact of one phase, fetched when a person asks for it.
 *
 * console.md §6 keeps these three out of the trace — a prompt and a transcript are too large for a
 * wide row, and a diff is git's to supply, which is why the record lists *which* paths changed and
 * never what changed in them. So none of them is in the run document, and each is its own request.
 *
 * **Fetched on demand means on demand.** `enabled` is off until the pane is opened: a panel that
 * pulled a transcript and a patch every time somebody clicked a span would spend the run's whole
 * history on the one span they were passing over. Opening one pane never asks for the other two.
 *
 * **Cached for ever, and that is a statement about the trace rather than about the network.** An
 * artifact is only ever served for a phase that has a record, and a record is written when the phase
 * exits — so the answer cannot change, and the server says so with `Cache-Control: immutable`.
 *
 * **A refusal is not retried.** `404 no-such-artifact` is the answer for a phase that kept no
 * transcript and for a diff whose branch is gone; asking again produces the same answer. `502
 * artifact-unreadable` is a fault worth one more try, and only one — a pane that retried for ever
 * would be a spinner where console.md wants a sentence.
 */
export const useArtifact = (options: {
  readonly runId: Accessor<string>;
  readonly phaseId: Accessor<string>;
  readonly kind: ArtifactKind;
  /** Whether the pane has been opened. Nothing is requested until it has. */
  readonly wanted: Accessor<boolean>;
}): UseQueryResult<string, Error> =>
  useQuery(() => ({
    queryKey: ["artifact", options.runId(), options.phaseId(), options.kind],
    queryFn: () =>
      fetchText(
        `/api/runs/${encodeURIComponent(options.runId())}/phases/${encodeURIComponent(options.phaseId())}/${options.kind}`,
      ),
    enabled: options.wanted(),
    retry: (attempt: number, error: Error) => !refused(error) && attempt < 2,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const,
  }));
