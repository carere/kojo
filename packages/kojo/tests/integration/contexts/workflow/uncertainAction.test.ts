import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteExternalActionRepository } from "../../../../src/contexts/workflow/adapters/SqliteExternalActionRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import type { RunAuthority } from "../../../../src/contexts/workflow/models/DaemonRun.ts";
import {
  externalActionId,
  externalActionInputHash,
} from "../../../../src/contexts/workflow/services/externalActionIdentity.ts";

const fixture = () => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  new SqliteProjectRepository(database);
  database.run(
    `INSERT INTO projects (
       project_id, location, project_state, factory_state, refresh_state,
       registered_at, refreshed_at, fault, remedy
     ) VALUES ('project', '/tmp/project', 'available', 'available', 'current', 'now', 'now', NULL, NULL)`,
  );
  database.run(
    "INSERT INTO workflow_revisions VALUES ('revision', 'graph', ?, '/retained', 'now')",
    [JSON.stringify({ entrySource: "workflows/review.ts" })],
  );
  database.run(
    "INSERT INTO project_workflows VALUES ('project', 'review', 'active', 'available', 'workflows/review.ts', NULL, NULL, 'revision', NULL, 'not-declared', 'now', 'not-declared', 'now')",
  );
  const runs = new SqliteRunRepository(database);
  const actions = new SqliteExternalActionRepository(database);
  return { database, runs, actions };
};

const admitAndClaim = (runs: SqliteRunRepository, key: string, runner: string, at: number) =>
  Effect.gen(function* () {
    const admission = yield* runs.admit({
      dataIdentity: "data",
      requestId: `admit-${key}`,
      canonicalRequest: JSON.stringify(["admit", key]),
      projectId: "project",
      workflowName: "review",
      idempotencyKey: key,
      payload: { key },
      revisionId: "revision",
      packageGraphId: "graph",
      admittedAt: new Date(at).toISOString(),
    });
    return {
      run: admission.run,
      authority: yield* runs.claim(admission.run.runId, runner, new Date(at + 1).toISOString()),
    };
  });

const intent = (
  runId: string,
  authority: RunAuthority,
  policy: "safe-repetition" | "unresolved" = "unresolved",
) => {
  const inputHash = externalActionInputHash({ command: ["controlled-effect"] });
  return {
    authority,
    actionId: externalActionId({
      runId,
      revisionId: "revision",
      phasePath: "publish",
      attempt: 1,
      inputHash,
    }),
    phasePath: "publish",
    attempt: 1,
    inputHash,
    recoveryPolicy: policy,
    intendedAt: new Date(2).toISOString(),
  } as const;
};

const performControlledEffect = async (counter: string): Promise<number> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `const p=process.argv[1];const n=Number(await Bun.file(p).text().catch(()=>"0"))+1;await Bun.write(p,String(n));console.log(JSON.stringify({count:n}))`,
      counter,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  return (JSON.parse(output) as { readonly count: number }).count;
};

const phaseResult = (count: number) => ({
  phasePath: "publish",
  attempt: 1,
  kind: "code" as const,
  outcome: "succeeded" as const,
  description: "Publish the controlled effect",
  startedAt: new Date(2).toISOString(),
  endedAt: new Date(6).toISOString(),
  encodedResult: { count },
});

describe("uncertain external actions", () => {
  it.effect(
    "holds an arbitrary action after its effect result is lost and consumes one exact retry authorization",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "kojo-uncertain-"));
        const counter = join(root, "count");
        writeFileSync(counter, "0");
        const { database, runs, actions } = fixture();
        try {
          const first = yield* admitAndClaim(runs, "unresolved", "runner-1", 0);
          const request = intent(first.run.runId, first.authority);
          expect((yield* actions.begin(request)).kind).toBe("perform");
          expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(1);

          const held = yield* actions.holdOpen(
            first.run.runId,
            "the controlled process result was lost",
            new Date(3).toISOString(),
          );
          expect(held[0]).toMatchObject({ state: "unresolved", uncertaintyRevision: 1 });
          expect(yield* runs.read(first.run.runId)).toMatchObject({ state: "held" });
          expect(readFileSync(counter, "utf8")).toBe("1");
          yield* actions.settleAfterRunnerTermination(first.authority, new Date(4).toISOString());

          const wrongAction = yield* Effect.result(
            actions.authorizeRetry({
              dataIdentity: "data",
              requestId: "retry-wrong",
              canonicalRequest: "wrong",
              runId: first.run.runId,
              actionId: "action_wrong",
              reason: "wrong action",
              possibleDuplicationAcknowledged: true,
              authorizedAt: new Date(4).toISOString(),
            }),
          );
          expect(Result.isFailure(wrongAction)).toBe(true);

          const authorized = yield* actions.authorizeRetry({
            dataIdentity: "data",
            requestId: "retry-exact",
            canonicalRequest: "retry-exact-content",
            runId: first.run.runId,
            actionId: request.actionId,
            reason: "The destination has no query API; retry this exact publish.",
            possibleDuplicationAcknowledged: true,
            authorizedAt: new Date(5).toISOString(),
          });
          expect(authorized.retryAuthorization).toMatchObject({
            possibleDuplicationAcknowledged: true,
            uncertaintyRevision: 1,
          });
          const secondAuthority = yield* runs.claim(
            first.run.runId,
            "runner-2",
            new Date(6).toISOString(),
          );
          expect((yield* actions.begin({ ...request, authority: secondAuthority })).kind).toBe(
            "perform",
          );
          expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(2);
          yield* actions.holdOpen(
            first.run.runId,
            "the authorized retry also lost its result",
            new Date(7).toISOString(),
          );
          expect((yield* actions.current(first.run.runId))?.uncertaintyRevision).toBe(2);
          expect(
            Result.isFailure(
              yield* Effect.result(
                actions.recordEvidence(
                  request.actionId,
                  1,
                  { kind: "not-performed", detail: "a stale recovery check completed late" },
                  new Date(8).toISOString(),
                ),
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                actions.authorizeRetry({
                  dataIdentity: "data",
                  requestId: "retry-exact",
                  canonicalRequest: "retry-exact-content",
                  runId: first.run.runId,
                  actionId: request.actionId,
                  reason: "The destination has no query API; retry this exact publish.",
                  possibleDuplicationAcknowledged: true,
                  authorizedAt: new Date(8).toISOString(),
                }),
              ),
            ),
          ).toBe(true);
          expect(readFileSync(counter, "utf8")).toBe("2");
        } finally {
          database.close(false);
          rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "uses accepted result or not-performed evidence without duplicating the controlled effect",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "kojo-evidence-"));
        const counter = join(root, "count");
        writeFileSync(counter, "0");
        const { database, runs, actions } = fixture();
        try {
          const original = yield* admitAndClaim(runs, "original", "runner-a", 0);
          const originalIntent = intent(original.run.runId, original.authority);
          yield* actions.begin(originalIntent);
          expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(1);
          yield* actions.holdOpen(original.run.runId, "lost result", new Date(3).toISOString());
          yield* actions.settleAfterRunnerTermination(
            original.authority,
            new Date(4).toISOString(),
          );
          yield* actions.recordEvidence(
            originalIntent.actionId,
            1,
            {
              kind: "original-result",
              detail: "the provider query returned the original-contract result",
              result: { count: 1 },
            },
            new Date(4).toISOString(),
          );
          const originalReplay = yield* runs.claim(
            original.run.runId,
            "runner-b",
            new Date(5).toISOString(),
          );
          expect(
            yield* actions.begin({ ...originalIntent, authority: originalReplay }),
          ).toMatchObject({
            kind: "reuse-result",
            result: { count: 1 },
          });
          expect(readFileSync(counter, "utf8")).toBe("1");
          yield* runs.completeRun(originalReplay, "succeeded", new Date(6).toISOString());

          const absent = yield* admitAndClaim(runs, "absent", "runner-c", 6);
          const absentIntent = intent(absent.run.runId, absent.authority);
          yield* actions.begin(absentIntent);
          yield* actions.holdOpen(
            absent.run.runId,
            "lost before launch",
            new Date(8).toISOString(),
          );
          yield* actions.settleAfterRunnerTermination(absent.authority, new Date(9).toISOString());
          yield* actions.recordEvidence(
            absentIntent.actionId,
            1,
            { kind: "not-performed", detail: "the provider proved the idempotency key is absent" },
            new Date(9).toISOString(),
          );
          const absentReplay = yield* runs.claim(
            absent.run.runId,
            "runner-d",
            new Date(10).toISOString(),
          );
          expect((yield* actions.begin({ ...absentIntent, authority: absentReplay })).kind).toBe(
            "perform",
          );
          expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(2);
          expect(readFileSync(counter, "utf8")).toBe("2");
        } finally {
          database.close(false);
          rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect("automatically repeats only a declared safe action and fences the stale holder", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kojo-safe-repeat-"));
      const counter = join(root, "count");
      writeFileSync(counter, "0");
      const { database, runs, actions } = fixture();
      try {
        const first = yield* admitAndClaim(runs, "safe", "runner-old", 0);
        const request = intent(first.run.runId, first.authority, "safe-repetition");
        yield* actions.begin(request);
        expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(1);
        const recovery = yield* actions.holdOpen(
          first.run.runId,
          "the result was lost",
          new Date(3).toISOString(),
        );
        expect(recovery[0]).toMatchObject({ state: "repetition-safe" });
        expect(yield* runs.read(first.run.runId)).toMatchObject({ state: "held" });
        expect(
          Result.isFailure(
            yield* Effect.result(
              runs.claim(first.run.runId, "runner-too-early", new Date(4).toISOString()),
            ),
          ),
        ).toBe(true);
        yield* actions.settleAfterRunnerTermination(first.authority, new Date(4).toISOString());
        expect(yield* runs.read(first.run.runId)).toMatchObject({ state: "queued" });
        const replacement = yield* runs.claim(
          first.run.runId,
          "runner-new",
          new Date(4).toISOString(),
        );
        expect((yield* actions.begin({ ...request, authority: replacement })).kind).toBe("perform");
        expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(2);
        expect(
          Result.isFailure(
            yield* Effect.result(
              actions.confirmResult(
                first.authority,
                request.actionId,
                phaseResult(1),
                "stale output",
                new Date(5).toISOString(),
              ),
            ),
          ),
        ).toBe(true);
        yield* actions.confirmResult(
          replacement,
          request.actionId,
          phaseResult(2),
          "replacement result",
          new Date(6).toISOString(),
        );
        expect(yield* runs.phases(first.run.runId)).toEqual([phaseResult(2)]);
        expect(readFileSync(counter, "utf8")).toBe("2");
      } finally {
        database.close(false);
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not infer process safety from a replacement Claim", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kojo-replacement-"));
      const counter = join(root, "count");
      writeFileSync(counter, "0");
      const { database, runs, actions } = fixture();
      try {
        const first = yield* admitAndClaim(runs, "replacement", "runner-old", 0);
        const request = intent(first.run.runId, first.authority, "safe-repetition");
        yield* actions.begin(request);
        expect(yield* Effect.promise(() => performControlledEffect(counter))).toBe(1);

        yield* runs.recoverInterruptedExecutions(new Date(3).toISOString());
        const replacement = yield* runs.claim(
          first.run.runId,
          "runner-new",
          new Date(4).toISOString(),
        );
        expect(yield* actions.begin({ ...request, authority: replacement })).toMatchObject({
          kind: "hold",
          action: { state: "unresolved", uncertaintyRevision: 1 },
        });
        expect(readFileSync(counter, "utf8")).toBe("1");
      } finally {
        database.close(false);
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps unresolved action evidence when the held Run is cancelled", () =>
    Effect.gen(function* () {
      const { database, runs, actions } = fixture();
      try {
        const first = yield* admitAndClaim(runs, "cancelled", "runner-cancel", 0);
        const request = intent(first.run.runId, first.authority);
        yield* actions.begin(request);
        yield* actions.holdOpen(
          first.run.runId,
          "the external result is not known",
          new Date(3).toISOString(),
        );
        yield* actions.settleAfterRunnerTermination(first.authority, new Date(4).toISOString());

        yield* runs.requestCancellation(
          first.run.runId,
          "cancel-held-action",
          new Date(4).toISOString(),
        );

        expect(yield* runs.read(first.run.runId)).toMatchObject({ state: "cancelled" });
        expect(yield* actions.current(first.run.runId)).toMatchObject({
          actionId: request.actionId,
          state: "unresolved",
          uncertaintyRevision: 1,
          evidence: {
            kind: "unresolved",
            detail: "the external result is not known",
          },
        });
      } finally {
        database.close(false);
      }
    }),
  );
});
