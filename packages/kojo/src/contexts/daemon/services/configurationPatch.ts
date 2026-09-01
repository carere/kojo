import type {
  ConfigurationChange,
  ConfigurationValue,
  DaemonSettingPath,
  ProjectSettingPath,
} from "../models/Configuration.ts";
import { ConfigurationError } from "../models/ConfigurationError.ts";

const daemonPaths = new Set<DaemonSettingPath>([
  "limits.executingRuns",
  "limits.newStartQueue",
  "runner.idleMs",
  "runner.handshakeMs",
  "runner.heartbeatMs",
  "runner.unhealthyMs",
  "runner.cleanupMs",
  "runner.recoveryCheckMs",
  "runner.restartDelaysMs",
  "runner.healthyResetMs",
  "daemon.readinessMs",
  "daemon.cleanupMs",
  "daemon.restartDelaysMs",
  "daemon.healthyResetMs",
  "retention.runHistoryMs",
  "retention.traceMs",
  "retention.artifactMs",
]);

const projectPaths = new Set<ProjectSettingPath>(["limits.executingRuns", "limits.newStartQueue"]);

const invalid = (message: string): ConfigurationError =>
  new ConfigurationError({ code: "INVALID_CONFIGURATION_PATCH", message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const flatten = (
  value: Record<string, unknown>,
  paths: ReadonlySet<string>,
  scope: "daemon" | "project",
  prefix = "",
): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(value).flatMap(([name, child]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    if (!isRecord(child)) return [[path, child] as const];
    if (![...paths].some((candidate) => candidate.startsWith(`${path}.`))) {
      throw invalid(`unknown ${scope} setting ${path}`);
    }
    return flatten(child, paths, scope, path);
  });

const valueAt = (path: string, value: unknown): ConfigurationValue => {
  if (path.startsWith("retention.")) {
    if (value === "indefinite") return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    throw invalid(`${path} must be "indefinite" or a positive integer duration`);
  }
  if (path.endsWith("restartDelaysMs")) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 16 ||
      value.some(
        (item) =>
          typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0 || item > 86_400_000,
      )
    ) {
      throw invalid(`${path} must be a nonempty list of at most 16 positive durations`);
    }
    return value as ReadonlyArray<number>;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw invalid(`${path} must be a positive integer`);
  }
  return value;
};

/** Decode the complete documented patch before any configuration state changes. */
export const decodeConfigurationPatch = (
  input: unknown,
  scope: "daemon" | "project",
): ReadonlyArray<ConfigurationChange> => {
  if (!isRecord(input)) throw invalid("the configuration patch must be a JSON object");
  if (Object.keys(input).some((key) => key !== "set" && key !== "reset")) {
    throw invalid("the configuration patch contains an unknown top-level field");
  }
  if (input.set !== undefined && !isRecord(input.set)) {
    throw invalid("set must be a JSON object");
  }
  if (
    input.reset !== undefined &&
    (!Array.isArray(input.reset) || input.reset.some((path) => typeof path !== "string"))
  ) {
    throw invalid("reset must be a list of documented field paths");
  }
  const paths: ReadonlySet<string> = scope === "daemon" ? daemonPaths : projectPaths;
  const set = flatten((input.set as Record<string, unknown> | undefined) ?? {}, paths, scope);
  const resets = (input.reset as ReadonlyArray<string> | undefined) ?? [];
  const setPaths = new Set<string>();
  const changes: Array<ConfigurationChange> = [];
  for (const [path, value] of set) {
    if (!paths.has(path)) throw invalid(`unknown ${scope} setting ${path}`);
    if (setPaths.has(path)) throw invalid(`setting ${path} occurs more than once`);
    setPaths.add(path);
    changes.push({
      path: path as DaemonSettingPath | ProjectSettingPath,
      value: valueAt(path, value),
      reset: false,
    });
  }
  const resetPaths = new Set<string>();
  for (const path of resets) {
    if (!paths.has(path)) throw invalid(`unknown ${scope} setting ${path}`);
    if (resetPaths.has(path)) throw invalid(`reset ${path} occurs more than once`);
    if (setPaths.has(path)) throw invalid(`setting ${path} cannot be set and reset together`);
    resetPaths.add(path);
    changes.push({
      path: path as DaemonSettingPath | ProjectSettingPath,
      value: 0,
      reset: true,
    });
  }
  return changes.toSorted((left, right) => left.path.localeCompare(right.path));
};

export const configurationRequestHash = (
  target: "daemon" | `project:${string}`,
  changes: ReadonlyArray<ConfigurationChange>,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ formatVersion: 1, target, changes }))
    .digest("hex");
