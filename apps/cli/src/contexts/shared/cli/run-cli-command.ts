import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ProjectCondition,
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectSelector,
  type ProjectSnapshot,
  type RequestKey,
  type WorkflowRunId,
  WorkflowRunId as WorkflowRunIdSchema,
  type WorkflowRunState,
  type WorkflowScheduleCondition,
  type WorkflowScheduleOccurrenceOutcome,
} from "@kojo/control";
import {
  defaultSocketPath,
  makeDefaultLocalClient,
  makeNonActivatingLocalClient,
} from "@kojo/control/local-client";
import { Schema } from "effect";
import {
  initializeProject,
  ProjectInitializationError,
  resolveInitializedProject,
} from "../../workflow-authoring/projects/services/project-initializer";
import { resolveProjectSelectionPath } from "../../workflow-authoring/projects/services/project-selection-path";
import { validateProjectDefinition } from "../../workflow-authoring/projects/services/subprocess-project-definition-validator";
import { selectProject } from "../../workflow-authoring/projects/use-cases/select-project";
import { runEffect } from "./cli-effect";
import { canonicalSelectorPath, decodeRequestKey, parseOptions } from "./cli-options";
import {
  type CliFailure,
  invalid,
  pendingRegistrationWarning,
  projectCursorFailure,
  projectFailure,
  projectQueryFailure,
  transportFailure,
  workflowRunFailure,
  workflowScheduleFailure,
  workflowScheduleOccurrenceFailure,
  writeFailure,
  writeProject,
  writeWorkflowRun,
  writeWorkflowSchedule,
  writeWorkflowScheduleOccurrence,
} from "./cli-output";

export const runCliCommand = async (rawArgs: ReadonlyArray<string>) => {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((argument) => argument !== "--json");

  if (args[0] === "schedule") {
    const options = parseOptions(args.slice(2));
    const command = `schedule.${args[1] ?? "unknown"}`;
    const operation = args[1];
    if (
      options === undefined ||
      !["list", "show", "next", "enable", "disable"].includes(operation ?? "")
    ) {
      return writeFailure(
        invalid("Run: kojo schedule list|show|next|enable|disable"),
        json,
        command,
      );
    }
    if (
      options.input !== undefined ||
      options.states.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.reveal ||
      (operation === "list" &&
        (options.args.length !== 0 ||
          options.requestKey !== undefined ||
          options.revision !== undefined)) ||
      (operation === "next" &&
        (options.args.length !== 0 ||
          options.requestKey !== undefined ||
          options.revision !== undefined)) ||
      (operation === "show" &&
        (options.args.length !== 1 ||
          options.requestKey !== undefined ||
          options.revision !== undefined)) ||
      (operation === "enable" && (options.args.length !== 1 || options.revision === undefined)) ||
      (operation === "disable" && (options.args.length !== 1 || options.revision !== undefined))
    ) {
      return writeFailure(
        invalid(
          "Run: kojo schedule list|next [--workflow <Workflow Key>] [--condition <condition>] [--project <path>|--project-id <Project Identity>] or kojo schedule show <Schedule Key> [--project <path>|--project-id <Project Identity>] or kojo schedule enable <Schedule Key> --revision <Schedule Revision> [--request-key <Request Key>] [--project <path>|--project-id <Project Identity>] or kojo schedule disable <Schedule Key> [--request-key <Request Key>] [--project <path>|--project-id <Project Identity>]",
        ),
        json,
        command,
      );
    }
    const conditions = new Set<WorkflowScheduleCondition>([
      "available",
      "unavailable",
      "needs-attention",
    ]);
    if (
      options.conditions.some(
        (condition) => !conditions.has(condition as WorkflowScheduleCondition),
      )
    ) {
      return writeFailure(
        invalid("Use --condition available, unavailable, or needs-attention."),
        json,
        command,
      );
    }
    let identity: ProjectSnapshot["identity"];
    if (options.projectId !== undefined) {
      try {
        identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      } catch {
        return writeFailure(invalid("Use a full Project Identity."), json, command);
      }
    } else {
      try {
        identity = (await resolveInitializedProject(options.projectPath ?? process.cwd())).identity;
      } catch (error) {
        return writeFailure(
          invalid(
            error instanceof ProjectInitializationError
              ? error.message
              : "Choose an initialized Kojo Project.",
          ),
          json,
          command,
        );
      }
    }
    const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
    const scheduleInput = {
      identity,
      workflowKeys: options.workflowKeys,
      conditions: options.conditions as ReadonlyArray<WorkflowScheduleCondition>,
    };
    if (operation === "list" || operation === "next") {
      const listed = await runEffect(
        operation === "next"
          ? client.listNextWorkflowSchedules(scheduleInput)
          : client.listWorkflowSchedules(scheduleInput),
      );
      if (!listed.succeeded) return writeFailure(transportFailure(listed.error), json, command);
      if (!listed.value.ok)
        return writeFailure(workflowScheduleFailure(listed.value.error), json, command);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, command, result: listed.value.schedules, warnings: [] })}\n`,
        );
      } else {
        const lines = listed.value.schedules.map((schedule) => {
          const definition = schedule.definition;
          const next =
            schedule.nextOccurrenceMs === null
              ? "-"
              : new Date(schedule.nextOccurrenceMs).toISOString();
          return `${schedule.scheduleKey}\t${schedule.enabledIntent ? "enabled" : "disabled"}\t${schedule.condition}\t${definition?.workflowKey ?? "-"}\t${definition?.revision ?? schedule.appliedRevision ?? "-"}\t${next}`;
        });
        process.stdout.write(
          `${lines.length === 0 ? "No Workflow Schedules." : lines.join("\n")}\n`,
        );
      }
      return 0;
    }
    if (operation === "show") {
      const shown = await runEffect(
        client.showWorkflowSchedule(identity, options.args[0] as string),
      );
      if (!shown.succeeded) return writeFailure(transportFailure(shown.error), json, command);
      if (!shown.value.ok)
        return writeFailure(workflowScheduleFailure(shown.value.error), json, command);
      writeWorkflowSchedule(command, shown.value.schedule, json);
      return 0;
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(
        invalid("Use a non-empty Request Key of at most 256 characters."),
        json,
        command,
      );
    }
    const result = await runEffect(
      operation === "enable"
        ? client.enableWorkflowSchedule(
            identity,
            options.args[0] as string,
            options.revision as string,
            requestKey,
          )
        : client.disableWorkflowSchedule(identity, options.args[0] as string, requestKey),
    );
    if (!result.succeeded) return writeFailure(transportFailure(result.error), json, command);
    if (!result.value.ok) {
      return writeFailure(
        workflowScheduleFailure(result.value.error, result.value.requestKey),
        json,
        command,
      );
    }
    writeWorkflowSchedule(
      command,
      result.value.schedule,
      json,
      result.value.requestKey,
      result.value.alreadyApplied,
      result.value.acceptedRunsContinue,
    );
    return 0;
  }

  if (args[0] === "occurrence") {
    const options = parseOptions(args.slice(2));
    const command = `occurrence.${args[1] ?? "unknown"}`;
    const operation = args[1];
    if (options === undefined || !["list", "show"].includes(operation ?? "")) {
      return writeFailure(invalid("Run: kojo occurrence list|show"), json, command);
    }
    if (
      options.input !== undefined ||
      options.requestKey !== undefined ||
      options.revision !== undefined ||
      options.cursor !== undefined ||
      options.reveal ||
      options.workflowKeys.length > 0 ||
      options.conditions.length > 0 ||
      options.states.length > 0 ||
      (operation === "list" && options.args.length !== 0) ||
      (operation === "show" && options.args.length !== 2)
    ) {
      return writeFailure(
        invalid(
          "Run: kojo occurrence list [--schedule <Schedule Key>] [--outcome <outcome>] [--limit <1-200>] [--project <path>|--project-id <Project Identity>] or kojo occurrence show <Schedule Key> <scheduled UTC instant> [--project <path>|--project-id <Project Identity>]",
        ),
        json,
        command,
      );
    }
    let identity: ProjectSnapshot["identity"];
    if (options.projectId !== undefined) {
      try {
        identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      } catch {
        return writeFailure(invalid("Use a full Project Identity."), json, command);
      }
    } else {
      try {
        identity = (await resolveInitializedProject(options.projectPath ?? process.cwd())).identity;
      } catch (error) {
        return writeFailure(
          invalid(
            error instanceof ProjectInitializationError
              ? error.message
              : "Choose an initialized Kojo Project.",
          ),
          json,
          command,
        );
      }
    }
    const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
    if (operation === "list") {
      const allowedOutcomes = new Set<WorkflowScheduleOccurrenceOutcome>([
        "planned",
        "started",
        "skipped",
        "invalidated",
        "failed",
      ]);
      if (options.states.length > 0) {
        return writeFailure(invalid("Use --outcome, not --state, for occurrences."), json, command);
      }
      const outcomes = options.outcomes as ReadonlyArray<WorkflowScheduleOccurrenceOutcome>;
      if (outcomes.some((outcome) => !allowedOutcomes.has(outcome))) {
        return writeFailure(
          invalid("Use a valid Workflow Schedule Occurrence outcome."),
          json,
          command,
        );
      }
      const limit = options.limit === undefined ? 100 : Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return writeFailure(
          invalid("Use --limit with a whole number from 1 to 200."),
          json,
          command,
        );
      }
      const listed = await runEffect(
        client.listWorkflowScheduleOccurrences({
          identity,
          scheduleKeys: options.scheduleKeys,
          outcomes,
          limit,
        }),
      );
      if (!listed.succeeded) return writeFailure(transportFailure(listed.error), json, command);
      if (!listed.value.ok)
        return writeFailure(workflowScheduleOccurrenceFailure(listed.value.error), json, command);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, command, result: listed.value.occurrences, warnings: [] })}\n`,
        );
      } else {
        process.stdout.write(
          `${listed.value.occurrences.length === 0 ? "No Workflow Schedule Occurrences." : listed.value.occurrences.map((occurrence) => `${occurrence.scheduleKey}\t${new Date(occurrence.scheduledAtMs).toISOString()}\t${occurrence.outcome}${occurrence.missedRange === null ? "" : ` (${occurrence.missedRange.count} missed)`}\t${occurrence.linkedRunId ?? "-"}`).join("\n")}\n`,
        );
      }
      return 0;
    }
    if (
      options.scheduleKeys.length > 0 ||
      options.limit !== undefined ||
      options.states.length > 0 ||
      options.outcomes.length > 0
    ) {
      return writeFailure(
        invalid(
          "Run: kojo occurrence show <Schedule Key> <scheduled UTC instant> [--project <path>|--project-id <Project Identity>]",
        ),
        json,
        command,
      );
    }
    const scheduledAtMs = Date.parse(options.args[1] as string);
    if (!Number.isFinite(scheduledAtMs) || scheduledAtMs < 0) {
      return writeFailure(invalid("Use an ISO UTC scheduled instant."), json, command);
    }
    const shown = await runEffect(
      client.showWorkflowScheduleOccurrence(identity, options.args[0] as string, scheduledAtMs),
    );
    if (!shown.succeeded) return writeFailure(transportFailure(shown.error), json, command);
    if (!shown.value.ok)
      return writeFailure(workflowScheduleOccurrenceFailure(shown.value.error), json, command);
    writeWorkflowScheduleOccurrence(command, shown.value.occurrence, json);
    return 0;
  }

  if (args[0] === "run") {
    const options = parseOptions(args.slice(2));
    const deferredComplete = args[1] === "deferred" && options?.args[0] === "complete";
    const command = deferredComplete ? "run.deferred.complete" : `run.${args[1] ?? "unknown"}`;
    if (
      options === undefined ||
      (!["start", "list", "show", "resume", "stop"].includes(args[1] ?? "") && !deferredComplete)
    ) {
      return writeFailure(
        invalid("Run: kojo run start|list|show|resume|stop|deferred complete"),
        json,
        command,
      );
    }
    const selectIdentity = async () => {
      if (options.projectId !== undefined) {
        try {
          return Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
        } catch {
          return undefined;
        }
      }
      try {
        return (await resolveInitializedProject(options.projectPath ?? process.cwd())).identity;
      } catch {
        return undefined;
      }
    };
    const identity = await selectIdentity();
    if (identity === undefined) {
      return writeFailure(
        invalid("Choose an initialized Kojo Project or use a full --project-id."),
        json,
        command,
      );
    }
    const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
    const parseControlValue = async () => {
      let source = options.value;
      if (options.valueFile !== undefined) {
        try {
          source =
            options.valueFile === "-"
              ? await new Response(Bun.stdin.stream()).text()
              : await readFile(options.valueFile, "utf8");
        } catch {
          return { ok: false as const };
        }
      }
      if (source === undefined) return { ok: true as const, value: undefined };
      try {
        return { ok: true as const, value: JSON.parse(source) as unknown };
      } catch {
        return { ok: false as const };
      }
    };
    if (args[1] === "stop") {
      if (
        options.args.length !== 1 ||
        options.input !== undefined ||
        options.value !== undefined ||
        options.valueFile !== undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.limit !== undefined ||
        options.states.length > 0 ||
        options.workflowKeys.length > 0 ||
        options.reveal
      ) {
        return writeFailure(
          invalid(
            "Run: kojo run stop <Run Identity> [--request-key <Request Key>] [--project <path>|--project-id <Project Identity>] [--json]",
          ),
          json,
          command,
        );
      }
      const requestKey = decodeRequestKey(options.requestKey);
      if (requestKey === undefined) {
        return writeFailure(
          invalid("Use a non-empty Request Key of at most 256 characters."),
          json,
          command,
        );
      }
      let runId: WorkflowRunId;
      try {
        runId = Schema.decodeUnknownSync(WorkflowRunIdSchema)(options.args[0]);
      } catch {
        return writeFailure(invalid("Use a valid Run Identity."), json, command);
      }
      const stopped = await runEffect(client.stopWorkflowRun(identity, runId, requestKey));
      if (!stopped.succeeded) return writeFailure(transportFailure(stopped.error), json, command);
      if (!stopped.value.ok) {
        return writeFailure(
          workflowRunFailure(stopped.value.error, stopped.value.requestKey),
          json,
          command,
        );
      }
      writeWorkflowRun(
        command,
        stopped.value.run,
        json,
        stopped.value.requestKey,
        stopped.value.alreadyApplied,
      );
      return 0;
    }
    if (args[1] === "resume" || deferredComplete) {
      const expectedArguments = deferredComplete ? 3 : 1;
      const controlArguments = deferredComplete ? options.args.slice(1) : options.args;
      if (
        controlArguments.length !== expectedArguments - (deferredComplete ? 1 : 0) ||
        options.input !== undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.limit !== undefined ||
        options.states.length > 0 ||
        options.workflowKeys.length > 0 ||
        options.reveal
      ) {
        return writeFailure(
          invalid(
            deferredComplete
              ? "Run: kojo run deferred complete <Run Identity> <completion-token> [--value <JSON>|--value-file <path|->] [--request-key <Request Key>]"
              : "Run: kojo run resume <Run Identity> [--value <JSON>|--value-file <path|->] [--request-key <Request Key>]",
          ),
          json,
          command,
        );
      }
      const requestKey = decodeRequestKey(options.requestKey);
      if (requestKey === undefined) {
        return writeFailure(
          invalid("Use a non-empty Request Key of at most 256 characters."),
          json,
          command,
        );
      }
      const parsedValue = await parseControlValue();
      if (!parsedValue.ok) {
        return writeFailure(invalid("Use valid JSON for --value or --value-file."), json, command);
      }
      let runId: WorkflowRunId;
      try {
        runId = Schema.decodeUnknownSync(WorkflowRunIdSchema)(controlArguments[0]);
      } catch {
        return writeFailure(invalid("Use a valid Run Identity."), json, command);
      }
      const controlled = await runEffect(
        deferredComplete
          ? client.completeWorkflowDeferred(
              identity,
              runId,
              controlArguments[1] ?? "",
              parsedValue.value,
              requestKey,
            )
          : client.resumeWorkflowRun(identity, runId, parsedValue.value, requestKey),
      );
      if (!controlled.succeeded)
        return writeFailure(transportFailure(controlled.error), json, command);
      if (!controlled.value.ok) {
        return writeFailure(
          workflowRunFailure(controlled.value.error, controlled.value.requestKey),
          json,
          command,
        );
      }
      writeWorkflowRun(
        command,
        controlled.value.run,
        json,
        controlled.value.requestKey,
        controlled.value.alreadyApplied,
      );
      return 0;
    }
    if (args[1] === "start") {
      if (
        options.args.length !== 1 ||
        options.input === undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.limit !== undefined ||
        options.states.length > 0 ||
        options.workflowKeys.length > 0 ||
        options.value !== undefined ||
        options.valueFile !== undefined ||
        options.parentRunId !== undefined ||
        options.reveal
      ) {
        return writeFailure(
          invalid(
            "Run: kojo run start <Workflow Key> --input <JSON> [--project <path>|--project-id <Project Identity>] [--request-key <Request Key>] [--json]",
          ),
          json,
          "run.start",
        );
      }
      const requestKey = decodeRequestKey(options.requestKey);
      if (requestKey === undefined) {
        return writeFailure(
          invalid("Use a non-empty Request Key of at most 256 characters."),
          json,
          "run.start",
        );
      }
      let workflowInput: unknown;
      try {
        workflowInput = JSON.parse(options.input);
      } catch {
        return writeFailure(invalid("Use valid JSON for --input."), json, "run.start");
      }
      const definition = await runEffect(client.showWorkflowDefinition(identity, options.args[0]));
      if (!definition.succeeded)
        return writeFailure(transportFailure(definition.error), json, "run.start");
      if (!definition.value.ok)
        return writeFailure(projectQueryFailure(definition.value.error), json, "run.start");
      const started = await runEffect(
        client.startWorkflowRun(
          identity,
          options.args[0],
          definition.value.workflow.revision,
          workflowInput,
          requestKey,
        ),
      );
      if (!started.succeeded)
        return writeFailure(transportFailure(started.error), json, "run.start");
      if (!started.value.ok) {
        return writeFailure(
          workflowRunFailure(started.value.error, started.value.requestKey),
          json,
          "run.start",
        );
      }
      writeWorkflowRun(
        "run.start",
        started.value.run,
        json,
        started.value.requestKey,
        started.value.alreadyApplied,
      );
      return 0;
    }
    if (args[1] === "list") {
      if (
        options.args.length !== 0 ||
        options.input !== undefined ||
        options.requestKey !== undefined ||
        options.value !== undefined ||
        options.valueFile !== undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.reveal
      ) {
        return writeFailure(
          invalid(
            "Run: kojo run list [--workflow <Workflow Key>] [--parent-run <Run Identity>] [--state <state>] [--limit <1-200>] [--project <path>|--project-id <Project Identity>] [--json]",
          ),
          json,
          "run.list",
        );
      }
      const allowedStates = new Set<WorkflowRunState>([
        "running",
        "suspended",
        "stopping",
        "stopped",
        "failed",
        "completed",
      ]);
      if (options.states.some((state) => !allowedStates.has(state as WorkflowRunState))) {
        return writeFailure(invalid("Use a valid Workflow Run State."), json, "run.list");
      }
      const limit = options.limit === undefined ? 100 : Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return writeFailure(
          invalid("Use --limit with a whole number from 1 to 200."),
          json,
          "run.list",
        );
      }
      let parentRunId: WorkflowRunId | undefined;
      if (options.parentRunId !== undefined) {
        try {
          parentRunId = Schema.decodeUnknownSync(WorkflowRunIdSchema)(options.parentRunId);
        } catch {
          return writeFailure(invalid("Use a valid parent Run Identity."), json, "run.list");
        }
      }
      const listed = await runEffect(
        client.listWorkflowRuns({
          identity,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          workflowKeys: options.workflowKeys,
          states: options.states as ReadonlyArray<WorkflowRunState>,
          limit,
        }),
      );
      if (!listed.succeeded) return writeFailure(transportFailure(listed.error), json, "run.list");
      if (!listed.value.ok)
        return writeFailure(workflowRunFailure(listed.value.error), json, "run.list");
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, command: "run.list", result: listed.value.runs, warnings: [] })}\n`,
        );
      } else {
        process.stdout.write(
          `${listed.value.runs.length === 0 ? "No Workflow Runs." : listed.value.runs.map((run) => `${run.runId}\t${run.state}\t${run.workflowKey}@${run.workflowRevision}${run.parentRunId == null ? "" : `\tparent=${run.parentRunId}\tinvocation=${run.childInvocationKey ?? "-"}`}`).join("\n")}\n`,
        );
      }
      return 0;
    }
    if (
      options.args.length !== 1 ||
      options.input !== undefined ||
      options.requestKey !== undefined ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.states.length > 0 ||
      options.workflowKeys.length > 0 ||
      options.parentRunId !== undefined ||
      options.value !== undefined ||
      options.valueFile !== undefined
    ) {
      return writeFailure(
        invalid(
          "Run: kojo run show <Run Identity> [--reveal] [--project <path>|--project-id <Project Identity>] [--json]",
        ),
        json,
        "run.show",
      );
    }
    let runId: WorkflowRunId;
    try {
      runId = Schema.decodeUnknownSync(WorkflowRunIdSchema)(options.args[0]);
    } catch {
      return writeFailure(invalid("Use a valid Run Identity."), json, "run.show");
    }
    const shown = await runEffect(
      options.reveal
        ? client.revealWorkflowRun(identity, runId)
        : client.showWorkflowRun(identity, runId),
    );
    if (!shown.succeeded) return writeFailure(transportFailure(shown.error), json, "run.show");
    if (!shown.value.ok)
      return writeFailure(workflowRunFailure(shown.value.error), json, "run.show");
    writeWorkflowRun(
      "run.show",
      shown.value.run,
      json,
      undefined,
      undefined,
      options.reveal
        ? [
            {
              code: "sensitive-content-not-scanned",
              message: "Revealed content may contain arbitrary secrets; Kojo did not scan it.",
              next: "Handle revealed content as sensitive and avoid copying it into logs or issue trackers.",
            },
          ]
        : [],
    );
    return 0;
  }

  if (args[0] === "workflow") {
    const options = parseOptions(args.slice(2));
    if (options === undefined) {
      return writeFailure(
        invalid("Run: kojo workflow validate|list|show"),
        json,
        `workflow.${args[1] ?? "unknown"}`,
      );
    }
    if (args[1] === "validate") {
      if (
        options.args.length > 1 ||
        options.projectId !== undefined ||
        options.projectPath !== undefined ||
        options.requestKey !== undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.limit !== undefined ||
        options.input !== undefined ||
        options.states.length > 0 ||
        options.workflowKeys.length > 0 ||
        options.reveal
      ) {
        return writeFailure(
          invalid("Run: kojo workflow validate [Project path or kojo.config.ts] [--json]"),
          json,
          "workflow.validate",
        );
      }
      const input = options.args[0] ?? process.cwd();
      const configurationPath = input.endsWith(".ts")
        ? resolve(input)
        : join(resolve(input), "kojo.config.ts");
      const validation = await validateProjectDefinition(configurationPath);
      if (validation.ok) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              schemaVersion: 1,
              command: "workflow.validate",
              result: validation.snapshot,
              warnings: [],
            })}\n`,
          );
        } else {
          process.stdout.write(
            `Kojo Configuration is valid. Accepted Workflow Definitions: ${validation.snapshot.workflows.length}\n`,
          );
        }
        return 0;
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            command: "workflow.validate",
            error: {
              code: validation.findingKey,
              message: validation.message,
              findings: validation.findings,
            },
            warnings: [],
          })}\n`,
        );
      }
      process.stderr.write(`${validation.message}\n`);
      for (const finding of validation.findings.slice(1)) {
        process.stderr.write(`${finding.message}\n`);
      }
      return 1;
    }

    if (
      (args[1] !== "list" && args[1] !== "show") ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.requestKey !== undefined ||
      options.input !== undefined ||
      options.states.length > 0 ||
      options.workflowKeys.length > 0 ||
      options.reveal ||
      (args[1] === "list" && options.args.length !== 0) ||
      (args[1] === "show" && options.args.length !== 1)
    ) {
      return writeFailure(
        invalid(
          "Run: kojo workflow list [--project <path>|--project-id <Project Identity>] or kojo workflow show <Workflow Key> [--project <path>|--project-id <Project Identity>]",
        ),
        json,
        `workflow.${args[1] ?? "unknown"}`,
      );
    }
    let identity: ProjectSnapshot["identity"];
    if (options.projectId !== undefined) {
      try {
        identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      } catch {
        return writeFailure(invalid("Use a full Project Identity."), json, `workflow.${args[1]}`);
      }
    } else {
      try {
        identity = (await resolveInitializedProject(options.projectPath ?? process.cwd())).identity;
      } catch (error) {
        return writeFailure(
          invalid(
            error instanceof ProjectInitializationError
              ? error.message
              : "Choose an initialized Kojo Project.",
          ),
          json,
          `workflow.${args[1]}`,
        );
      }
    }
    const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
    if (args[1] === "list") {
      const listed = await runEffect(client.listWorkflowDefinitions(identity));
      if (!listed.succeeded)
        return writeFailure(transportFailure(listed.error), json, "workflow.list");
      if (!listed.value.ok) {
        return writeFailure(projectQueryFailure(listed.value.error), json, "workflow.list");
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            command: "workflow.list",
            result: listed.value.snapshot,
            warnings: [],
          })}\n`,
        );
      } else {
        const workflows = listed.value.snapshot.definitions.workflows;
        process.stdout.write(
          `${workflows.length === 0 ? "No accepted Workflow Definitions." : workflows.map((workflow) => `${workflow.workflowKey}\t${workflow.revision}`).join("\n")}\n`,
        );
      }
      return 0;
    }
    const shown = await runEffect(client.showWorkflowDefinition(identity, options.args[0]));
    if (!shown.succeeded) return writeFailure(transportFailure(shown.error), json, "workflow.show");
    if (!shown.value.ok) {
      return writeFailure(projectQueryFailure(shown.value.error), json, "workflow.show");
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          command: "workflow.show",
          result: shown.value,
          warnings: [],
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${shown.value.workflow.workflowKey}\t${shown.value.workflow.revision}\t${shown.value.snapshotId}\n`,
      );
    }
    return 0;
  }

  if (args[0] === "init") {
    const options = parseOptions(args.slice(1));
    if (
      options === undefined ||
      options.args.length > 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.input !== undefined ||
      options.states.length > 0 ||
      options.workflowKeys.length > 0 ||
      options.reveal
    ) {
      return writeFailure(
        invalid("Run: kojo init [path] [--request-key <Request Key>] [--json]"),
        json,
        "init",
      );
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(invalid("Use a full Request Key."), json, "init");
    }
    let project: ProjectSnapshot;
    try {
      project = await initializeProject(options.args[0] ?? process.cwd());
    } catch (error) {
      return writeFailure(
        {
          code: "project-initialization-failed",
          exitCode: 1,
          message:
            error instanceof ProjectInitializationError
              ? error.message
              : "Kojo Project initialization failed safely.",
          next: "Correct the Project layout and try again.",
          ...(error instanceof ProjectInitializationError && error.layoutMutated
            ? { requestKey }
            : {}),
        },
        json,
        "init",
      );
    }

    const client = makeNonActivatingLocalClient(
      process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
    );
    const registration = await runEffect(client.registerProject(project.path, requestKey));
    if (!registration.succeeded) {
      const warning = pendingRegistrationWarning(project);
      if (json) writeProject("init", project, true, undefined, [warning], requestKey);
      else {
        process.stdout.write(
          `Initialized Kojo Project at ${project.path}\nProject Identity: ${project.identity}\nRequest Key: ${requestKey}\n`,
        );
        process.stderr.write(`Warning: ${warning.message}\nNext: ${warning.next}\n`);
      }
      return 0;
    }
    if (!registration.value.ok) {
      return writeFailure(projectFailure(registration.value), json, "init");
    }
    if (json) writeProject("init", registration.value.project, true, registration.value);
    else {
      process.stdout.write(
        `Initialized Kojo Project at ${registration.value.project.path}\nProject Identity: ${registration.value.project.identity}\nRequest Key: ${registration.value.requestKey}\n`,
      );
    }
    return 0;
  }

  if (args[0] !== "project") {
    return writeFailure(
      invalid("Run: kojo init [path] or kojo project list|show|register|forget"),
      json,
      args.length === 0 ? "kojo" : args.join("."),
    );
  }

  const options = parseOptions(args.slice(2));
  if (options === undefined) {
    return writeFailure(
      invalid("Use each option once and choose either --project or --project-id."),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }
  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());

  if (args[1] === "list") {
    if (
      options.args.length !== 0 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.requestKey !== undefined ||
      options.input !== undefined ||
      options.states.length > 0 ||
      options.workflowKeys.length > 0 ||
      options.reveal
    ) {
      return writeFailure(
        invalid(
          "Run: kojo project list [--condition <condition>] [--limit <1-200>] [--cursor <cursor>] [--json]",
        ),
        json,
        "project.list",
      );
    }
    const allowedConditions = new Set<ProjectCondition>(["ready", "limited", "needs-attention"]);
    if (
      options.conditions.some((condition) => !allowedConditions.has(condition as ProjectCondition))
    ) {
      return writeFailure(
        invalid("Use --condition ready, limited, or needs-attention."),
        json,
        "project.list",
      );
    }
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return writeFailure(
        invalid("Use --limit with a whole number from 1 to 200."),
        json,
        "project.list",
      );
    }
    const listed = await runEffect(
      client.listProjectPage({
        conditions: options.conditions as ReadonlyArray<ProjectCondition>,
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }),
    );
    if (!listed.succeeded)
      return writeFailure(transportFailure(listed.error), json, "project.list");
    if (!listed.value.ok)
      return writeFailure(projectCursorFailure(listed.value.error), json, "project.list");
    const page = listed.value.page;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "project.list", result: page, warnings: [] })}\n`,
      );
    } else {
      const lines =
        page.items.length === 0
          ? "No Kojo Projects."
          : page.items
              .map((project) => `${project.identity}\t${project.condition}\t${project.path}`)
              .join("\n");
      process.stdout.write(`${lines}\n`);
      if (page.nextCursor !== null)
        process.stdout.write(
          `More Projects are available. Continue with --cursor ${page.nextCursor}\n`,
        );
    }
    return 0;
  }

  if (args[1] === "register") {
    if (
      options.args.length !== 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.input !== undefined ||
      options.states.length > 0 ||
      options.workflowKeys.length > 0 ||
      options.reveal
    ) {
      return writeFailure(
        invalid("Run: kojo project register <path> [--request-key <Request Key>] [--json]"),
        json,
        "project.register",
      );
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(
        invalid("Use a non-empty Request Key of at most 256 characters."),
        json,
        "project.register",
      );
    }
    const result = await runEffect(client.registerProject(options.args[0], requestKey));
    if (!result.succeeded) {
      return writeFailure(transportFailure(result.error), json, "project.register");
    }
    if (!result.value.ok) {
      return writeFailure(projectFailure(result.value), json, "project.register");
    }
    writeProject("project.register", result.value.project, json, result.value);
    return 0;
  }

  if (
    (args[1] !== "show" && args[1] !== "forget") ||
    options.args.length !== 0 ||
    options.conditions.length > 0 ||
    options.cursor !== undefined ||
    options.limit !== undefined ||
    options.input !== undefined ||
    options.states.length > 0 ||
    options.workflowKeys.length > 0 ||
    options.reveal ||
    (args[1] === "show" && options.requestKey !== undefined)
  ) {
    return writeFailure(
      invalid("Run: kojo project list|show|register|forget"),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }

  let chosen: ProjectSnapshot | undefined;
  let forgetIdentity: ProjectSnapshot["identity"] | undefined;
  let forgetSelector: ProjectSelector | undefined;
  const forgetRequestKey = args[1] === "forget" ? decodeRequestKey(options.requestKey) : undefined;
  if (args[1] === "forget" && forgetRequestKey === undefined) {
    return writeFailure(
      invalid("Use a non-empty Request Key of at most 256 characters."),
      json,
      "project.forget",
    );
  }
  if (args[1] === "forget" && options.projectId !== undefined) {
    try {
      forgetIdentity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      forgetSelector = { kind: "identity", identity: forgetIdentity };
    } catch {
      return writeFailure(invalid("Use a full Project Identity."), json, "project.forget");
    }
  } else if (args[1] === "forget") {
    forgetSelector = {
      kind: "path",
      path: await canonicalSelectorPath(options.projectPath ?? process.cwd()),
    };
    try {
      forgetIdentity = (await resolveInitializedProject(options.projectPath ?? process.cwd()))
        .identity;
    } catch {
      // A damaged or unavailable local Project can still be selected from the Host Index below.
    }
  }

  if (forgetIdentity === undefined && chosen === undefined) {
    const projects: Array<ProjectSnapshot> = [];
    let cursor: string | undefined;
    let listFailure: CliFailure | undefined;
    do {
      const list = await runEffect(
        client.listProjectPage({
          conditions: [],
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (!list.succeeded) {
        listFailure = transportFailure(list.error);
        break;
      }
      if (!list.value.ok) {
        listFailure = projectCursorFailure(list.value.error);
        break;
      }
      projects.push(...list.value.page.items);
      cursor = list.value.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    if (listFailure !== undefined) {
      if (args[1] === "show") {
        return writeFailure(listFailure, json, "project.show");
      }
    } else {
      const selection = await selectProject(
        projects,
        options,
        options.projectId === undefined
          ? await resolveProjectSelectionPath(options.projectPath ?? process.cwd())
          : undefined,
      );
      if ("exitCode" in selection) {
        if (args[1] === "show") {
          return writeFailure(selection, json, "project.show");
        }
      } else {
        chosen = selection;
      }
    }
  }

  if (args[1] === "show") {
    if (chosen === undefined) {
      return writeFailure(invalid("Choose a Kojo Project."), json, "project.show");
    }
    const shown = await runEffect(client.showProject(chosen.identity));
    if (!shown.succeeded) {
      return writeFailure(transportFailure(shown.error), json, "project.show");
    }
    if (!shown.value.ok) {
      return writeFailure(projectQueryFailure(shown.value.error), json, "project.show");
    }
    writeProject("project.show", shown.value.project, json);
    return 0;
  }

  const requestKey = forgetRequestKey as RequestKey;
  const identity = forgetIdentity ?? chosen?.identity;
  const selector = forgetSelector as ProjectSelector;
  const forgotten = await runEffect(
    identity === undefined
      ? client.replayForgetProject(selector, requestKey)
      : client.forgetProject(identity, selector, requestKey),
  );
  if (!forgotten.succeeded) {
    return writeFailure(transportFailure(forgotten.error), json, "project.forget");
  }
  if (!forgotten.value.ok) {
    return writeFailure(projectFailure(forgotten.value), json, "project.forget");
  }
  if (json) writeProject("project.forget", forgotten.value.project, true, forgotten.value);
  else {
    process.stdout.write(
      `Forgot Kojo Project ${forgotten.value.project.identity}. Project files were not changed.\nRequest Key: ${forgotten.value.requestKey}\n`,
    );
  }
  return 0;
};
