import type { MaskedWorkflowValue } from "@kojo/control";

export const SENSITIVITY_MAP_VERSION = 1;

export interface SensitivityMap {
  readonly paths: ReadonlyArray<string>;
}

export type StoredSensitivityMap =
  | { readonly valid: true; readonly map: SensitivityMap }
  | { readonly valid: false };

const masked = (): MaskedWorkflowValue => ({ _tag: "sensitive-value-masked" });

const normalisePaths = (paths: ReadonlyArray<string>) =>
  [...new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))].sort();

export const sensitivityMap = (paths: ReadonlyArray<string>): SensitivityMap => ({
  paths: normalisePaths(paths),
});

export const prefixedSensitivityMap = (
  prefix: string,
  paths: ReadonlyArray<string>,
): SensitivityMap =>
  sensitivityMap(paths.map((path) => (path === "$" ? prefix : `${prefix}.${path}`)));

const isAgentSession = (value: unknown): value is { readonly sessionId: string } =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "agent-session" &&
  typeof (value as { readonly sessionId?: unknown }).sessionId === "string";

/**
 * Agent Session references are continuation capabilities, so completed
 * Workflow output must never expose them merely because an author forgot to
 * list the path in a sensitivity declaration.
 */
export const agentSessionSensitivityPaths = (value: unknown): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  const visit = (candidate: unknown, path: string): void => {
    if (isAgentSession(candidate)) {
      paths.push(path.length === 0 ? "$" : path);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        visit(item, path.length === 0 ? `${index}` : `${path}.${index}`);
      });
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      visit(item, path.length === 0 ? key : `${path}.${key}`);
    }
  };
  visit(value, "");
  return normalisePaths(paths);
};

export const encodeSensitivityMap = (map: SensitivityMap) => JSON.stringify(map.paths);

/**
 * A sensitivity map is authoritative only when both its version and its stored
 * JSON have the expected shape. Unknown or damaged maps fail closed.
 */
export const decodeSensitivityMap = (version: unknown, encoded: unknown): StoredSensitivityMap => {
  if (version !== SENSITIVITY_MAP_VERSION || typeof encoded !== "string") {
    return { valid: false };
  }
  try {
    const decoded = JSON.parse(encoded);
    if (
      !Array.isArray(decoded) ||
      !decoded.every((path) => typeof path === "string" && path.trim().length > 0)
    ) {
      return { valid: false };
    }
    const paths = normalisePaths(decoded);
    if (paths.length !== decoded.length) return { valid: false };
    return { valid: true, map: { paths } };
  } catch {
    return { valid: false };
  }
};

const hasSensitiveAncestor = (path: string, paths: ReadonlyArray<string>) =>
  paths.some(
    (marked) =>
      marked === "$" || marked === path || (path.length > 0 && path.startsWith(`${marked}.`)),
  );

const hasSensitiveDescendant = (path: string, paths: ReadonlyArray<string>) =>
  path.length === 0 ? paths.length > 0 : paths.some((marked) => marked.startsWith(`${path}.`));

const maskValue = (value: unknown, path: string, paths: ReadonlyArray<string>): unknown => {
  if (hasSensitiveAncestor(path, paths)) return masked();
  if (!hasSensitiveDescendant(path, paths)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => maskValue(item, `${path}.${index}`, paths));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      maskValue(item, path.length === 0 ? key : `${path}.${key}`, paths),
    ]),
  );
};

/**
 * Returns a safe view of a schema-encoded payload. A missing or invalid map
 * deliberately masks the entire payload rather than guessing which fields are safe.
 */
export const maskPayload = (value: unknown, map: StoredSensitivityMap): unknown =>
  map.valid ? maskValue(value, "", map.map.paths) : masked();
