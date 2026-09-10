import { decodeClosedRecord, decodeString } from "../../shared/codecs/json.ts";

/** Authored progress is an observation, not evidence of execution or resource cleanup. */
export interface WorkItemProgress {
  readonly key: string;
  readonly title: string;
  readonly revision: number;
  readonly state: "waiting" | "executing" | "accepted" | "integrating" | "integrated" | "failed";
  readonly waitingFor?: "dependencies" | "capacity" | "human";
  readonly detail: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly url?: string;
}

/** Decode only explicit progress results. Never infer work items from arbitrary Phase output. */
export const decodeRunProgress = (input: unknown): ReadonlyArray<WorkItemProgress> | undefined => {
  const record = decodeClosedRecord(input, ["_tag", "items"], []);
  if (!record.ok || record.value._tag !== "KojoRunProgress" || !Array.isArray(record.value.items))
    return undefined;
  const items: Array<WorkItemProgress> = [];
  for (const input of record.value.items) {
    const decoded = decodeClosedRecord(
      input,
      ["key", "title", "revision", "state", "waitingFor", "detail", "dependencies", "url"],
      [],
    );
    if (!decoded.ok) return undefined;
    const item = decoded.value;
    if (
      !decodeString(item.key, [], { minLength: 1 }).ok ||
      typeof item.title !== "string" ||
      typeof item.detail !== "string" ||
      typeof item.revision !== "number" ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      typeof item.state !== "string" ||
      !["waiting", "executing", "accepted", "integrating", "integrated", "failed"].includes(
        item.state,
      ) ||
      !Array.isArray(item.dependencies) ||
      !item.dependencies.every((key) => typeof key === "string") ||
      (item.url !== undefined && typeof item.url !== "string") ||
      (item.waitingFor !== undefined &&
        (typeof item.waitingFor !== "string" ||
          !["dependencies", "capacity", "human"].includes(item.waitingFor)))
    )
      return undefined;
    items.push({
      key: item.key as string,
      title: item.title,
      revision: item.revision,
      state: item.state as WorkItemProgress["state"],
      detail: item.detail,
      dependencies: item.dependencies,
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      ...(item.waitingFor === undefined
        ? {}
        : { waitingFor: item.waitingFor as NonNullable<WorkItemProgress["waitingFor"]> }),
    });
  }
  return items;
};
