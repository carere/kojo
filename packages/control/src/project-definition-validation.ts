import { Cron, Result, Schema } from "effect";

const ProjectDefinitionFindingKey = Schema.Literals([
  "dependency.workflow-package-missing",
  "configuration.missing",
  "configuration.load-failed",
  "configuration.invalid",
  "workflow.key-duplicate",
  "workflow.schema-invalid",
  "workflow.revision-conflict",
  "workflow.child-definition-missing",
  "schedule.key-duplicate",
  "schedule.definition-invalid",
]);

export const WorkflowScheduleSnapshot = Schema.Struct({
  scheduleKey: Schema.String,
  workflowKey: Schema.String,
  revision: Schema.String,
  cron: Schema.String,
  timeZone: Schema.String,
  overlapPolicy: Schema.Literals(["allow", "skip"]),
  inputRuleRevision: Schema.String,
});
export type WorkflowScheduleSnapshot = typeof WorkflowScheduleSnapshot.Type;

export const WorkflowDefinitionSnapshot = Schema.Struct({
  workflowKey: Schema.String,
  revision: Schema.String,
  inputSchemaFingerprint: Schema.String,
  successSchemaFingerprint: Schema.String,
  failureSchemaFingerprint: Schema.String,
  sourceIdentity: Schema.String,
  sensitivity: Schema.Struct({
    input: Schema.Array(Schema.String),
    success: Schema.Array(Schema.String),
    failure: Schema.Array(Schema.String),
  }),
  childWorkflowKeys: Schema.Array(Schema.String),
  schedules: Schema.Array(WorkflowScheduleSnapshot),
});
export type WorkflowDefinitionSnapshot = typeof WorkflowDefinitionSnapshot.Type;

export const ProjectDefinitionSnapshot = Schema.Struct({
  snapshotId: Schema.String,
  workflows: Schema.Array(WorkflowDefinitionSnapshot),
});
export type ProjectDefinitionSnapshot = typeof ProjectDefinitionSnapshot.Type;

export const ProjectDefinitionFinding = Schema.Struct({
  findingKey: ProjectDefinitionFindingKey,
  message: Schema.String,
  workflowKey: Schema.optionalKey(Schema.String),
});
export type ProjectDefinitionFinding = typeof ProjectDefinitionFinding.Type;

export const ProjectDefinitionValidation = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), snapshot: ProjectDefinitionSnapshot }),
  Schema.Struct({
    ok: Schema.Literal(false),
    findingKey: ProjectDefinitionFindingKey,
    message: Schema.String,
    findings: Schema.Array(ProjectDefinitionFinding),
  }),
]);
export type ProjectDefinitionValidation = typeof ProjectDefinitionValidation.Type;

const failure = (
  findings: ReadonlyArray<ProjectDefinitionFinding>,
): ProjectDefinitionValidation => {
  const first = findings[0] ?? {
    findingKey: "configuration.invalid" as const,
    message: "Kojo Configuration is invalid.",
  };
  return {
    ok: false,
    findingKey: first.findingKey,
    message: first.message,
    findings: [...findings],
  };
};

const finding = (
  findingKey: ProjectDefinitionFinding["findingKey"],
  message: string,
  workflowKey?: string,
): ProjectDefinitionFinding => ({
  findingKey,
  message,
  ...(workflowKey === undefined ? {} : { workflowKey }),
});

export const missingProjectDefinitionDependency = (
  installCommand: string,
): ProjectDefinitionValidation =>
  failure([
    finding(
      "dependency.workflow-package-missing",
      `The Project is missing the @kojo/workflow dependency. Run: ${installCommand}.`,
    ),
  ]);

export const missingProjectDefinition = (): ProjectDefinitionValidation =>
  failure([finding("configuration.missing", "The Project is missing kojo.config.ts.")]);

export const invalidProjectDefinition = (): ProjectDefinitionValidation =>
  failure([
    finding(
      "configuration.invalid",
      "Kojo Configuration is invalid; it must default-export defineConfig({ workflows: [...] }).",
    ),
  ]);

export const unavailableProjectDefinition = (
  message = "Kojo Configuration could not be loaded safely.",
): ProjectDefinitionValidation => failure([finding("configuration.load-failed", message)]);

/** A deterministic, serializable identity; cryptographic security is not required here. */
const digest = (value: string) => {
  const hash = (seed: number) => {
    let current = seed;
    for (let index = 0; index < value.length; index += 1) {
      current ^= value.charCodeAt(index);
      current = Math.imul(current, 0x01000193);
    }
    return (current >>> 0).toString(16).padStart(8, "0");
  };
  return [
    0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c,
  ]
    .map(hash)
    .join("");
};

const stableJson = (value: unknown, seen = new Set<object>()): string => {
  if (value === undefined) return '"__kojo_undefined__"';
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
  if (typeof value !== "object") throw new Error("non-serializable schema");
  if (seen.has(value)) throw new Error("cyclic schema");
  seen.add(value);
  const result = `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], seen)}`,
    )
    .join(",")}}`;
  seen.delete(value);
  return result;
};

const schemaFingerprint = (value: unknown): string | undefined => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    !("ast" in value)
  ) {
    return undefined;
  }
  try {
    return digest(stableJson((value as { readonly ast: unknown }).ast));
  } catch {
    return undefined;
  }
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const sensitivity = (value: unknown) => {
  const empty = { input: [], success: [], failure: [] } as const;
  if (value === undefined) return empty;
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const paths = (kind: "input" | "success" | "failure") => {
    const candidate = source[kind];
    if (candidate === undefined) return [];
    return Array.isArray(candidate) && candidate.every(nonEmptyString) ? [...candidate] : undefined;
  };
  const input = paths("input");
  const success = paths("success");
  const failure = paths("failure");
  return input === undefined || success === undefined || failure === undefined
    ? undefined
    : { input, success, failure };
};

interface ParsedDefinition {
  readonly snapshot: WorkflowDefinitionSnapshot;
}

const validTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const validFiveFieldCron = (value: string, timeZone: string) => {
  if (value.trim().split(/\s+/).length !== 5) return false;
  return !Result.isFailure(Cron.parse(value, timeZone));
};

const parseSchedule = (
  candidate: unknown,
  workflowKey: string,
  index: number,
): {
  readonly schedule?: WorkflowScheduleSnapshot;
  readonly findings: ReadonlyArray<ProjectDefinitionFinding>;
} => {
  if (typeof candidate !== "object" || candidate === null) {
    return {
      findings: [
        finding(
          "schedule.definition-invalid",
          `Workflow Schedule ${index + 1} on Workflow Definition ${workflowKey} is not an object.`,
          workflowKey,
        ),
      ],
    };
  }
  const schedule = candidate as Record<string, unknown>;
  const scheduleKey = schedule.scheduleKey;
  const targetWorkflowKey = schedule.workflowKey;
  const cron = schedule.cron;
  const timeZone = schedule.timeZone;
  const input = schedule.input;
  const overlapPolicy = schedule.overlap ?? "allow";
  const findings: Array<ProjectDefinitionFinding> = [];
  if (!nonEmptyString(scheduleKey)) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${index + 1} on Workflow Definition ${workflowKey} has no Schedule Key.`,
        workflowKey,
      ),
    );
  }
  if (!nonEmptyString(targetWorkflowKey) || targetWorkflowKey !== workflowKey) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${String(scheduleKey ?? index + 1)} must target its owning Workflow Key ${workflowKey}.`,
        workflowKey,
      ),
    );
  }
  if (!nonEmptyString(timeZone) || !validTimeZone(timeZone)) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${String(scheduleKey ?? index + 1)} has an invalid IANA time zone.`,
        workflowKey,
      ),
    );
  }
  if (
    !nonEmptyString(cron) ||
    !nonEmptyString(timeZone) ||
    !validTimeZone(timeZone) ||
    !validFiveFieldCron(cron, timeZone)
  ) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${String(scheduleKey ?? index + 1)} has an invalid five-field cron expression.`,
        workflowKey,
      ),
    );
  }
  if (overlapPolicy !== "allow" && overlapPolicy !== "skip") {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${String(scheduleKey ?? index + 1)} has an invalid overlap policy.`,
        workflowKey,
      ),
    );
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !nonEmptyString((input as Record<string, unknown>).revision) ||
    typeof (input as Record<string, unknown>).resolve !== "function"
  ) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Schedule ${String(scheduleKey ?? index + 1)} has an invalid deterministic input rule.`,
        workflowKey,
      ),
    );
  }
  if (findings.length > 0) return { findings };
  const inputRuleRevision = (input as { readonly revision: string }).revision;
  return {
    schedule: {
      scheduleKey: scheduleKey as string,
      workflowKey,
      revision: digest(
        stableJson({
          workflowKey,
          cron,
          timeZone,
          overlapPolicy,
          inputRuleRevision,
        }),
      ),
      cron: cron as string,
      timeZone: timeZone as string,
      overlapPolicy: overlapPolicy as "allow" | "skip",
      inputRuleRevision,
    },
    findings: [],
  };
};

const parseDefinition = (
  candidate: unknown,
  index: number,
): {
  readonly definition?: ParsedDefinition;
  readonly findings: ReadonlyArray<ProjectDefinitionFinding>;
} => {
  if (typeof candidate !== "object" || candidate === null) {
    return {
      findings: [
        finding("configuration.invalid", `Workflow Definition ${index + 1} is not an object.`),
      ],
    };
  }
  const definition = candidate as Record<string, unknown>;
  const workflowKey = definition.workflowKey;
  if (!nonEmptyString(workflowKey)) {
    return {
      findings: [
        finding("configuration.invalid", `Workflow Definition ${index + 1} has no Workflow Key.`),
      ],
    };
  }

  const findings: Array<ProjectDefinitionFinding> = [];
  if (!nonEmptyString(definition.revision)) {
    findings.push(
      finding(
        "configuration.invalid",
        `Workflow Definition ${workflowKey} has no explicit Workflow Definition Revision.`,
        workflowKey,
      ),
    );
  }
  if (typeof definition.handler !== "function") {
    findings.push(
      finding(
        "configuration.invalid",
        `Workflow Definition ${workflowKey} has no fully provided Effect handler.`,
        workflowKey,
      ),
    );
  }
  const inputSchemaFingerprint = schemaFingerprint(definition.inputSchema);
  const successSchemaFingerprint = schemaFingerprint(definition.successSchema);
  const failureSchemaFingerprint = schemaFingerprint(definition.failureSchema);
  if (
    inputSchemaFingerprint === undefined ||
    successSchemaFingerprint === undefined ||
    failureSchemaFingerprint === undefined
  ) {
    findings.push(
      finding(
        "workflow.schema-invalid",
        `Workflow Definition ${workflowKey} has an invalid or non-encodable schema.`,
        workflowKey,
      ),
    );
  }
  const markings = sensitivity(definition.sensitivity);
  if (markings === undefined) {
    findings.push(
      finding(
        "workflow.schema-invalid",
        `Workflow Definition ${workflowKey} has invalid sensitivity markings.`,
        workflowKey,
      ),
    );
  }
  const childWorkflowKeys = definition.childWorkflowKeys ?? [];
  if (!Array.isArray(childWorkflowKeys) || !childWorkflowKeys.every(nonEmptyString)) {
    findings.push(
      finding(
        "configuration.invalid",
        `Workflow Definition ${workflowKey} has invalid declared child dependencies.`,
        workflowKey,
      ),
    );
  }
  const schedules = definition.schedules ?? [];
  if (!Array.isArray(schedules)) {
    findings.push(
      finding(
        "schedule.definition-invalid",
        `Workflow Definition ${workflowKey} has invalid attached Workflow Schedules.`,
        workflowKey,
      ),
    );
  }
  const parsedSchedules = Array.isArray(schedules)
    ? schedules.map((schedule, scheduleIndex) =>
        parseSchedule(schedule, workflowKey, scheduleIndex),
      )
    : [];
  findings.push(...parsedSchedules.flatMap((result) => result.findings));
  if (findings.length > 0) return { findings };

  return {
    definition: {
      snapshot: {
        workflowKey,
        revision: definition.revision as string,
        inputSchemaFingerprint: inputSchemaFingerprint as string,
        successSchemaFingerprint: successSchemaFingerprint as string,
        failureSchemaFingerprint: failureSchemaFingerprint as string,
        sourceIdentity: digest((definition.handler as (...args: never[]) => unknown).toString()),
        sensitivity: markings as {
          readonly input: ReadonlyArray<string>;
          readonly success: ReadonlyArray<string>;
          readonly failure: ReadonlyArray<string>;
        },
        childWorkflowKeys: [...(childWorkflowKeys as ReadonlyArray<string>)].sort(),
        schedules: parsedSchedules
          .flatMap((result) => (result.schedule === undefined ? [] : [result.schedule]))
          .sort((left, right) => left.scheduleKey.localeCompare(right.scheduleKey)),
      },
    },
    findings: [],
  };
};

export const validateProjectDefinitionValue = (
  configuration: unknown,
): ProjectDefinitionValidation => {
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    !("workflows" in configuration) ||
    !Array.isArray(configuration.workflows)
  ) {
    return invalidProjectDefinition();
  }

  const parsed = configuration.workflows.map(parseDefinition);
  const findings = parsed.flatMap((result) => result.findings);
  const definitions = parsed.flatMap((result) =>
    result.definition === undefined ? [] : [result.definition.snapshot],
  );
  const byKey = new Map<string, Array<WorkflowDefinitionSnapshot>>();
  for (const definition of definitions) {
    const values = byKey.get(definition.workflowKey) ?? [];
    values.push(definition);
    byKey.set(definition.workflowKey, values);
  }
  for (const [workflowKey, duplicates] of byKey) {
    if (duplicates.length < 2) continue;
    findings.push(
      finding(
        "workflow.key-duplicate",
        `Workflow Key ${workflowKey} is registered more than once.`,
        workflowKey,
      ),
    );
    const identities = new Set(
      duplicates.map((definition) =>
        stableJson({
          revision: definition.revision,
          input: definition.inputSchemaFingerprint,
          success: definition.successSchemaFingerprint,
          failure: definition.failureSchemaFingerprint,
          source: definition.sourceIdentity,
        }),
      ),
    );
    if (identities.size > 1) {
      findings.push(
        finding(
          "workflow.revision-conflict",
          `Workflow Key ${workflowKey} has conflicting definitions for one registered revision.`,
          workflowKey,
        ),
      );
    }
  }
  const declaredKeys = new Set(definitions.map((definition) => definition.workflowKey));
  for (const definition of definitions) {
    for (const childWorkflowKey of definition.childWorkflowKeys) {
      if (!declaredKeys.has(childWorkflowKey)) {
        findings.push(
          finding(
            "workflow.child-definition-missing",
            `Workflow Definition ${definition.workflowKey} declares missing child Workflow ${childWorkflowKey}.`,
            definition.workflowKey,
          ),
        );
      }
    }
  }
  const schedules = definitions.flatMap((definition) => definition.schedules);
  const schedulesByKey = new Map<string, Array<WorkflowScheduleSnapshot>>();
  for (const schedule of schedules) {
    const values = schedulesByKey.get(schedule.scheduleKey) ?? [];
    values.push(schedule);
    schedulesByKey.set(schedule.scheduleKey, values);
    if (!declaredKeys.has(schedule.workflowKey)) {
      findings.push(
        finding(
          "schedule.definition-invalid",
          `Workflow Schedule ${schedule.scheduleKey} targets missing Workflow Definition ${schedule.workflowKey}.`,
          schedule.workflowKey,
        ),
      );
    }
  }
  for (const [scheduleKey, duplicates] of schedulesByKey) {
    if (duplicates.length < 2) continue;
    findings.push(
      finding(
        "schedule.key-duplicate",
        `Schedule Key ${scheduleKey} is registered more than once.`,
      ),
    );
  }
  if (findings.length > 0) return failure(findings);

  const workflows = [...definitions].sort((left, right) =>
    left.workflowKey.localeCompare(right.workflowKey),
  );
  return {
    ok: true,
    snapshot: { snapshotId: digest(stableJson(workflows)), workflows },
  };
};

export interface ProjectDefinitionEvaluationPlatform {
  readonly configurationExists: (configurationPath: string) => Promise<boolean>;
  readonly dependencyAvailable: (root: string) => Promise<boolean>;
  readonly installCommand: (root: string) => string;
  readonly loadDefaultExport: (configurationPath: string) => Promise<unknown>;
}

export const evaluateProjectDefinitionWith = async (
  platform: ProjectDefinitionEvaluationPlatform,
  configurationPath: string,
  root: string,
): Promise<ProjectDefinitionValidation> => {
  const [configurationExists, dependencyAvailable] = await Promise.all([
    platform.configurationExists(configurationPath),
    platform.dependencyAvailable(root),
  ]);
  const preflightFindings: Array<ProjectDefinitionFinding> = [];
  if (!configurationExists) {
    preflightFindings.push(
      finding("configuration.missing", "The Project is missing kojo.config.ts."),
    );
  }
  if (!dependencyAvailable) {
    preflightFindings.push(
      finding(
        "dependency.workflow-package-missing",
        `The Project is missing the @kojo/workflow dependency. Run: ${platform.installCommand(root)}.`,
      ),
    );
  }
  if (preflightFindings.length > 0) return failure(preflightFindings);
  try {
    return validateProjectDefinitionValue(await platform.loadDefaultExport(configurationPath));
  } catch {
    return unavailableProjectDefinition();
  }
};

export interface ProjectDefinitionSubprocessResult {
  readonly envelope?: unknown;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export const validateProjectDefinitionSubprocessResult = (
  result: ProjectDefinitionSubprocessResult,
): ProjectDefinitionValidation => {
  if (result.timedOut) {
    return unavailableProjectDefinition("Kojo Configuration validation timed out.");
  }
  try {
    if (result.exitCode !== 0 || result.envelope === undefined) throw new Error("missing result");
    return Schema.decodeUnknownSync(ProjectDefinitionValidation)(result.envelope);
  } catch {
    return unavailableProjectDefinition();
  }
};

export const selectProjectDefinitionInstallCommand = (
  hasProjectFile: (name: string) => boolean,
) => {
  if (hasProjectFile("bun.lock") || hasProjectFile("bun.lockb")) {
    return "bun add @kojo/workflow";
  }
  if (hasProjectFile("pnpm-lock.yaml")) return "pnpm add @kojo/workflow";
  if (hasProjectFile("yarn.lock")) return "yarn add @kojo/workflow";
  return "npm install @kojo/workflow";
};

export interface ProjectDefinitionValidationProcess {
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

export const validateProjectDefinitionInSubprocessWith = async (
  start: (receive: (envelope: unknown) => void) => ProjectDefinitionValidationProcess,
  timeoutMs: number,
): Promise<ProjectDefinitionValidation> => {
  let envelope: unknown;
  const child = start((message) => {
    envelope = message;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  return validateProjectDefinitionSubprocessResult({
    timedOut,
    exitCode,
    ...(envelope === undefined ? {} : { envelope }),
  });
};
