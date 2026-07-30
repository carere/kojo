import type { WorkflowScheduleDefinition } from "@kojo/control";
import { expect, it } from "vitest";
import { nextWorkflowScheduleOccurrence } from "../../../../../../src/contexts/workflow-execution/schedules/services/schedule-timing";

const parisSchedule: WorkflowScheduleDefinition = {
  scheduleKey: "paris-morning",
  workflowKey: "report",
  revision: "schedule-v1",
  cron: "30 2 * * *",
  timeZone: "Europe/Paris",
  overlapPolicy: "allow",
  inputRuleRevision: "input-v1",
};

it("uses deterministic time-zone and daylight-saving occurrence calculations", () => {
  expect(
    new Date(
      nextWorkflowScheduleOccurrence(parisSchedule, Date.parse("2026-03-28T12:00:00.000Z")),
    ).toISOString(),
  ).toBe("2026-03-30T00:30:00.000Z");
  expect(
    new Date(
      nextWorkflowScheduleOccurrence(parisSchedule, Date.parse("2026-10-24T12:00:00.000Z")),
    ).toISOString(),
  ).toBe("2026-10-25T00:30:00.000Z");
  expect(
    new Date(
      nextWorkflowScheduleOccurrence(parisSchedule, Date.parse("2026-10-25T00:31:00.000Z")),
    ).toISOString(),
  ).toBe("2026-10-26T01:30:00.000Z");
});
