import type { ProjectSnapshot } from "@kojo/control";

export const NAVIGATOR_PREFERENCES_KEY = "kojo.navigator.preferences";

export interface NavigatorPreferences {
  readonly order: ReadonlyArray<string>;
  readonly selectedProjectIdentity?: string;
  readonly version: 1;
}

const parsePreferences = (value: string | null): NavigatorPreferences | undefined => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<NavigatorPreferences>;
    if (parsed.version !== 1 || !Array.isArray(parsed.order)) return undefined;
    if (!parsed.order.every((identity) => typeof identity === "string")) return undefined;
    if (
      parsed.selectedProjectIdentity !== undefined &&
      typeof parsed.selectedProjectIdentity !== "string"
    ) {
      return undefined;
    }
    return parsed as NavigatorPreferences;
  } catch {
    return undefined;
  }
};

export const reconcileNavigatorPreferences = (
  projects: ReadonlyArray<ProjectSnapshot>,
  stored: string | null,
): NavigatorPreferences => {
  const previous = parsePreferences(stored);
  const identities = new Set<string>(projects.map((project) => project.identity));
  const retainedOrder = (previous?.order ?? []).filter(
    (identity, index, order) => identities.has(identity) && order.indexOf(identity) === index,
  );
  const order = [
    ...retainedOrder,
    ...projects
      .map((project) => project.identity)
      .filter((identity) => !retainedOrder.includes(identity)),
  ];
  const selectedProjectIdentity =
    previous?.selectedProjectIdentity !== undefined &&
    identities.has(previous.selectedProjectIdentity)
      ? previous.selectedProjectIdentity
      : order[0];
  return { version: 1, order, selectedProjectIdentity };
};

export const orderProjects = (
  projects: ReadonlyArray<ProjectSnapshot>,
  preferences: NavigatorPreferences,
) => {
  const positions = new Map<string, number>(
    preferences.order.map((identity, index) => [identity, index]),
  );
  return [...projects].sort(
    (left, right) =>
      (positions.get(left.identity) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(right.identity) ?? Number.MAX_SAFE_INTEGER),
  );
};
