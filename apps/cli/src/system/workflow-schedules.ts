import { Cron, DateTime } from "effect";
import type { SystemStore } from "./storage";
import type { makeWorkflowRunService, WorkflowStartRequest } from "./workflow-runs";

interface ScheduleDefinition {
  readonly cron: {
    readonly and: boolean;
    readonly days: ReadonlyArray<number>;
    readonly hours: ReadonlyArray<number>;
    readonly minutes: ReadonlyArray<number>;
    readonly months: ReadonlyArray<number>;
    readonly seconds: ReadonlyArray<number>;
    readonly weekdays: ReadonlyArray<number>;
  };
  readonly input: unknown;
  readonly missedTimePolicy: "catch-up-once" | "skip";
  readonly name: string;
  readonly timezone: string;
  readonly workflow: string;
}

interface CatchUpRange {
  readonly count: number;
  readonly earliest: string;
  readonly latest: string;
}

type WorkflowRuns = ReturnType<typeof makeWorkflowRunService>;

const minute = (value: Date) => {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
};

const parseDefinition = (encoded: string): ScheduleDefinition =>
  JSON.parse(encoded) as ScheduleDefinition;

const parseCatchUp = (encoded: string | null): CatchUpRange | null =>
  encoded === null ? null : (JSON.parse(encoded) as CatchUpRange);

const mergeCatchUp = (
  pending: CatchUpRange | null,
  occurrences: ReadonlyArray<string>,
): CatchUpRange | null => {
  if (occurrences.length === 0) return pending;
  const first = occurrences[0];
  const last = occurrences.at(-1);
  if (first === undefined || last === undefined) return pending;
  return {
    count: (pending?.count ?? 0) + occurrences.length,
    earliest:
      pending?.earliest !== undefined && pending.earliest < first ? pending.earliest : first,
    latest: pending?.latest !== undefined && pending.latest > last ? pending.latest : last,
  };
};

const occurrencesThrough = (
  definition: ScheduleDefinition,
  cursor: string,
  now: Date,
): ReadonlyArray<string> => {
  const cron = Cron.make({
    ...definition.cron,
    tz: DateTime.zoneMakeNamedUnsafe(definition.timezone),
  });
  const occurrences: Array<string> = [];
  let next = Cron.next(cron, new Date(cursor));
  while (next <= now) {
    const scheduledAt = next.toISOString();
    if (occurrences.at(-1) !== scheduledAt) occurrences.push(scheduledAt);
    next = Cron.next(cron, next);
  }
  return occurrences;
};

export const makeWorkflowScheduleService = (store: SystemStore, workflowRuns: WorkflowRuns) => {
  const inspect = (projectId: string, name: string) => {
    const schedule = store.workflowSchedules.find(projectId, name);
    if (schedule === undefined) {
      throw new Error(`Workflow Schedule '${name}' was not found for Project ${projectId}`);
    }
    return {
      ...schedule,
      catchUp: parseCatchUp(schedule.catchUp),
      history: store.workflowSchedules.history(projectId, name),
      occurrences: store.workflowSchedules.occurrences(projectId, name),
    };
  };

  const commitWithoutStart = (
    schedule: NonNullable<ReturnType<SystemStore["workflowSchedules"]["find"]>>,
    input: {
      readonly catchUp: CatchUpRange | null;
      readonly cursor: string;
      readonly occurrences: ReadonlyArray<string>;
      readonly outcome: "PreflightFailed" | "Skipped";
      readonly reason: string;
    },
  ) => {
    if (schedule.definitionFingerprint === null) return;
    store.workflowSchedules.commitEvaluation({
      catchUp: input.catchUp === null ? null : JSON.stringify(input.catchUp),
      cursor: input.cursor,
      details: JSON.stringify({
        catchUp: input.catchUp,
        occurrences: input.occurrences,
        reason: input.reason,
      }),
      expectedDefinitionFingerprint: schedule.definitionFingerprint,
      occurrences: input.occurrences,
      outcome: input.outcome,
      projectId: schedule.projectId,
      recordedAt: new Date().toISOString(),
      scheduleName: schedule.name,
    });
  };

  return {
    disable: (projectId: string, name: string) => store.workflowSchedules.disable(projectId, name),
    enable: (projectId: string, name: string, enabledAt = new Date()) =>
      store.workflowSchedules.enable(projectId, name, minute(enabledAt).toISOString()),
    evaluate: async (evaluatedAt = new Date()) => {
      const now = minute(evaluatedAt);
      const nowIso = now.toISOString();
      const candidates: Array<{
        readonly definition: ScheduleDefinition;
        readonly occurrences: ReadonlyArray<string>;
        readonly pending: CatchUpRange | null;
        readonly schedule: NonNullable<ReturnType<SystemStore["workflowSchedules"]["find"]>>;
      }> = [];

      for (const schedule of store.workflowSchedules.list()) {
        if (schedule.enablement !== "Enabled") continue;
        const project = store.projects.findById(schedule.projectId);
        if (project?.registrationState !== "Enabled" || schedule.activeDefinition === null) {
          store.workflowSchedules.updateCursorWithoutMisses(
            schedule.projectId,
            schedule.name,
            nowIso,
          );
          continue;
        }
        if (schedule.cursor === null) {
          store.workflowSchedules.updateCursorWithoutMisses(
            schedule.projectId,
            schedule.name,
            nowIso,
          );
          continue;
        }
        const pending = parseCatchUp(schedule.catchUp);
        const occurrences =
          schedule.cursor >= nowIso
            ? []
            : occurrencesThrough(parseDefinition(schedule.activeDefinition), schedule.cursor, now);
        if (occurrences.length === 0 && pending === null) {
          if (schedule.cursor < nowIso) {
            store.workflowSchedules.updateCursorWithoutMisses(
              schedule.projectId,
              schedule.name,
              nowIso,
            );
          }
          continue;
        }
        candidates.push({
          definition: parseDefinition(schedule.activeDefinition),
          occurrences,
          pending,
          schedule,
        });
      }

      candidates.sort((left, right) => {
        const leftTime = left.pending?.earliest ?? left.occurrences[0] ?? nowIso;
        const rightTime = right.pending?.earliest ?? right.occurrences[0] ?? nowIso;
        return (
          leftTime.localeCompare(rightTime) || left.schedule.name.localeCompare(right.schedule.name)
        );
      });

      const results: Array<unknown> = [];
      for (const candidate of candidates) {
        const { definition, schedule } = candidate;
        if (schedule.definitionFingerprint === null) continue;
        if (definition.missedTimePolicy === "skip" && candidate.occurrences.length > 1) {
          commitWithoutStart(schedule, {
            catchUp: null,
            cursor: candidate.occurrences.at(-2) ?? schedule.cursor ?? nowIso,
            occurrences: candidate.occurrences.slice(0, -1),
            outcome: "Skipped",
            reason: "MissedTimePolicySkip",
          });
        }
        const startOccurrences =
          definition.missedTimePolicy === "skip"
            ? candidate.occurrences.slice(-1)
            : candidate.occurrences;
        const catchUp =
          definition.missedTimePolicy === "catch-up-once"
            ? mergeCatchUp(candidate.pending, startOccurrences)
            : null;
        const occurrence = catchUp?.earliest ?? startOccurrences[0];
        if (occurrence === undefined) continue;
        const cursor = candidate.occurrences.at(-1) ?? schedule.cursor ?? nowIso;
        const trigger = {
          ...(catchUp === null ? {} : { catchUp }),
          occurrence,
          scheduleName: schedule.name,
          scheduledAt: catchUp?.latest ?? occurrence,
          type: "Scheduled" as const,
        };
        const evaluation = {
          catchUp: catchUp === null ? null : JSON.stringify(catchUp),
          cursor,
          details: JSON.stringify({ catchUp, occurrences: startOccurrences, trigger }),
          expectedDefinitionFingerprint: schedule.definitionFingerprint,
          occurrences: startOccurrences,
          outcome: "Started" as const,
          projectId: schedule.projectId,
          recordedAt: new Date().toISOString(),
          scheduleName: schedule.name,
        };
        try {
          results.push(
            await workflowRuns.startScheduled(
              {
                input: definition.input,
                projectId: schedule.projectId,
                workflowName: definition.workflow,
              } satisfies Omit<WorkflowStartRequest, "fromCheckout">,
              evaluation,
              trigger,
            ),
          );
        } catch (error) {
          commitWithoutStart(schedule, {
            catchUp,
            cursor,
            occurrences: startOccurrences,
            outcome: "PreflightFailed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },
    inspect,
    list: (projectId?: string) => store.workflowSchedules.list(projectId),
  };
};
