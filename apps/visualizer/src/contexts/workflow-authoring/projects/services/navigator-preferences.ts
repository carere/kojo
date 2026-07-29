import {
  type ProjectIdentity,
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectSnapshot,
} from "@kojo/control";
import { Schema } from "effect";

export const NAVIGATOR_PREFERENCES_KEY = "kojo.navigator.preferences";

export interface NavigatorPreferences {
  readonly order: ReadonlyArray<ProjectIdentity>;
  readonly selectedProjectIdentity?: ProjectIdentity;
  readonly version: 1;
}

const parsePreferences = (value: string | null): NavigatorPreferences | undefined => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<NavigatorPreferences>;
    if (parsed.version !== 1 || !Array.isArray(parsed.order)) return undefined;
    const order = parsed.order.map((identity) =>
      Schema.decodeUnknownSync(ProjectIdentitySchema)(identity),
    );
    const selectedProjectIdentity =
      parsed.selectedProjectIdentity === undefined
        ? undefined
        : Schema.decodeUnknownSync(ProjectIdentitySchema)(parsed.selectedProjectIdentity);
    return {
      version: 1,
      order,
      ...(selectedProjectIdentity === undefined ? {} : { selectedProjectIdentity }),
    };
  } catch {
    return undefined;
  }
};

export const reconcileNavigatorPreferences = (
  projects: ReadonlyArray<ProjectSnapshot>,
  stored: string | null,
): NavigatorPreferences => {
  const previous = parsePreferences(stored);
  const identities = new Set<ProjectIdentity>(projects.map((project) => project.identity));
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
  return {
    version: 1,
    order,
    ...(selectedProjectIdentity === undefined ? {} : { selectedProjectIdentity }),
  };
};

export const orderProjects = (
  projects: ReadonlyArray<ProjectSnapshot>,
  preferences: NavigatorPreferences,
) => {
  const positions = new Map<ProjectIdentity, number>(
    preferences.order.map((identity, index) => [identity, index]),
  );
  return [...projects].sort(
    (left, right) =>
      (positions.get(left.identity) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(right.identity) ?? Number.MAX_SAFE_INTEGER),
  );
};
