import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { layer } from "../../../../src/contexts/workflow/adapters/InMemoryRunRepository.ts";
import {
  DEFAULT_DAEMON_EXECUTING_RUNS,
  DEFAULT_DAEMON_NEW_START_QUEUE,
  DEFAULT_PROJECT_EXECUTING_RUNS,
  DEFAULT_PROJECT_NEW_START_QUEUE,
} from "../../../../src/contexts/workflow/models/SchedulingDefaults.ts";
import { RunRepository } from "../../../../src/contexts/workflow/ports/RunRepository.ts";

const admit = (
  repository: RunRepository["Service"],
  projectId: string,
  key: string,
  sequence: number,
) =>
  repository.admit({
    dataIdentity: "data",
    requestId: `${projectId}:${key}`,
    canonicalRequest: JSON.stringify([projectId, key]),
    projectId,
    workflowName: "review",
    idempotencyKey: key,
    payload: { key },
    revisionId: "revision",
    packageGraphId: "graph",
    admittedAt: new Date(sequence).toISOString(),
  });

it("keeps the accepted scheduling limits explicit", () => {
  expect({
    daemonExecutionLimit: DEFAULT_DAEMON_EXECUTING_RUNS,
    projectExecutionLimit: DEFAULT_PROJECT_EXECUTING_RUNS,
    daemonNewStartQueueLimit: DEFAULT_DAEMON_NEW_START_QUEUE,
    projectNewStartQueueLimit: DEFAULT_PROJECT_NEW_START_QUEUE,
  }).toEqual({
    daemonExecutionLimit: 4,
    projectExecutionLimit: 1,
    daemonNewStartQueueLimit: 1_000,
    projectNewStartQueueLimit: 100,
  });
});

it.effect("rotates Projects and enforces four Daemon and one Project execution slots", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    yield* admit(repository, "project-a", "a1", 1);
    yield* admit(repository, "project-a", "a2", 2);
    yield* admit(repository, "project-b", "b1", 3);
    yield* admit(repository, "project-c", "c1", 4);
    yield* admit(repository, "project-d", "d1", 5);
    yield* admit(repository, "project-e", "e1", 6);

    const claimed = [];
    for (let index = 0; index < 4; index += 1) {
      claimed.push(
        yield* repository.claimNext(`runner-${index}`, new Date(10 + index).toISOString()),
      );
    }
    expect(claimed.map((item) => item?.run.projectId)).toEqual([
      "project-a",
      "project-b",
      "project-c",
      "project-d",
    ]);
    expect(yield* repository.claimNext("runner-full", new Date(20).toISOString())).toBeUndefined();
    const first = claimed[0];
    if (first === undefined) throw new Error("the first Project was not claimed");
    yield* repository.completeRun(first.authority, "succeeded", new Date(30).toISOString());
    expect(
      (yield* repository.claimNext("runner-next", new Date(31).toISOString()))?.run.projectId,
    ).toBe("project-e");
  }).pipe(Effect.provide(layer)),
);

it.effect("serves three oldest continuations and then one oldest new Run", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    for (let index = 1; index <= 4; index += 1) {
      const admission = yield* admit(repository, "project-a", `continuation-${index}`, index);
      const authority = yield* repository.claim(
        admission.run.runId,
        `prepare-${index}`,
        new Date(index + 10).toISOString(),
      );
      yield* repository.suspend(authority, new Date(index + 20).toISOString());
      yield* repository.continueRun(admission.run.runId, new Date(index + 30).toISOString());
    }
    yield* admit(repository, "project-a", "new", 100);

    const keys: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const claimed = yield* repository.claimNext(
        `runner-${index}`,
        new Date(200 + index).toISOString(),
      );
      if (claimed === undefined) throw new Error("the scheduled Run was absent");
      keys.push(claimed.run.idempotencyKey);
      yield* repository.completeRun(
        claimed.authority,
        "succeeded",
        new Date(300 + index).toISOString(),
      );
    }
    expect(keys).toEqual(["continuation-1", "continuation-2", "continuation-3", "new"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("releases the Project slot when a Run suspends", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const first = yield* admit(repository, "project-a", "first", 1);
    const second = yield* admit(repository, "project-a", "second", 2);
    const authority = yield* repository.claim(
      first.run.runId,
      "runner-one",
      new Date(3).toISOString(),
    );
    yield* repository.suspend(authority, new Date(4).toISOString());
    const next = yield* repository.claimNext("runner-two", new Date(5).toISOString());
    expect(next?.run.runId).toBe(second.run.runId);
  }).pipe(Effect.provide(layer)),
);
