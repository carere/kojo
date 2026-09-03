import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import { resourcePage } from "../components/data-grid/Pagination.tsx";

type SearchValue = string | ReadonlyArray<string> | undefined;

const cursorFromUrl = (): number => {
  const raw = new URLSearchParams(window.location.search).get("cursor");
  return Math.max(0, Number(raw ?? 0) || 0);
};

/**
 * One catalogue page projected from URL-owned cursor state.
 *
 * The caller owns its filters. This hook owns their URL projection together with the cursor, so a
 * filter reset and a browser refresh use the same state transition in every catalogue.
 */
export const usePaginationState = <A>(
  rows: Accessor<ReadonlyArray<A>>,
  searchValues: Accessor<Readonly<Record<string, SearchValue>>>,
) => {
  const [cursor, setCursorSignal] = createSignal(cursorFromUrl());
  const page = createMemo(() => resourcePage(rows(), cursor()));
  const setCursor = (next: number): void => {
    setCursorSignal(Math.max(0, next));
  };
  const reset = (): void => {
    setCursorSignal(0);
  };

  createEffect(() => {
    const url = new URL(window.location.href);
    url.search = "";
    for (const [name, raw] of Object.entries(searchValues())) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value !== undefined && value !== "") url.searchParams.append(name, value);
      }
    }
    if (cursor() > 0) url.searchParams.set("cursor", String(cursor()));
    window.history.replaceState(window.history.state, "", url);
  });

  return { cursor, page, setCursor, reset } as const;
};
