import { createSignal, onCleanup } from "solid-js";

const safeNamespace = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** URL-owned filter and cursor state for one embedded resource list. */
export const resourceListState = (namespace: string, pageSize = 50) => {
  const prefix = safeNamespace(namespace);
  const filterKey = `${prefix}-filter`;
  const cursorKey = `${prefix}-cursor`;
  const read = (key: string): string => new URL(window.location.href).searchParams.get(key) ?? "";
  const readCursor = (): number => {
    const parsed = Number.parseInt(read(cursorKey), 10);
    return Number.isFinite(parsed) && parsed > pageSize ? parsed : pageSize;
  };
  const [filter, setFilterSignal] = createSignal(read(filterKey));
  const [limit, setLimit] = createSignal(readCursor());
  const write = (key: string, value: string): void => {
    const url = new URL(window.location.href);
    if (value === "" || value === String(pageSize)) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, "", url);
  };
  const setFilter = (value: string): void => {
    setFilterSignal(value);
    setLimit(pageSize);
    write(filterKey, value);
    write(cursorKey, String(pageSize));
  };
  const loadMore = (): void => {
    const next = limit() + pageSize;
    setLimit(next);
    write(cursorKey, String(next));
  };
  const restore = (): void => {
    setFilterSignal(read(filterKey));
    setLimit(readCursor());
  };
  window.addEventListener("popstate", restore);
  onCleanup(() => window.removeEventListener("popstate", restore));
  return { filter, limit, setFilter, loadMore, filterKey, cursorKey } as const;
};
