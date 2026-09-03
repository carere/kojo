import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { ActionRecoveryPolicy } from "../models/ActionRecoveryPolicy.ts";
import { DaemonExecutionRepository } from "../ports/DaemonExecutionRepository.ts";
import {
  externalActionDecision,
  externalActionIdentity,
  recordedReplayDecision,
} from "../services/DaemonWorkflowReplay.ts";

interface Registration {
  readonly workflow: Workflow.Any;
  readonly execute: (
    payload: object,
    executionId: string,
  ) => Effect.Effect<
    unknown,
    unknown,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >;
  readonly scope: Scope.Scope;
}

interface ExecutionState {
  readonly payload: object;
  readonly registration: Registration;
  readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  fiber?: Fiber.Fiber<Workflow.Result<unknown, unknown>>;
}

/** Effect WorkflowEngine adapter for one exact Workflow Revision in one Project Runner process. */
export const layer = <RExecution>(
  revisionId: string,
  executionServices?: Layer.Layer<RExecution, never, never>,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, DaemonExecutionRepository> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const repository = yield* DaemonExecutionRepository;
      const registrations = new Map<string, Registration>();
      const executions = new Map<string, ExecutionState>();

      const resume = Effect.fnUntraced(function* (executionId: string) {
        const state = executions.get(executionId);
        if (state === undefined) return;
        const current = state.fiber?.pollUnsafe();
        if (state.fiber !== undefined && current === undefined) return;
        const execution = state.registration
          .execute(state.payload, executionId)
          .pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, state.instance),
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          );
        state.fiber = yield* (
          executionServices === undefined
            ? execution
            : execution.pipe(Effect.provide(executionServices))
        ).pipe(Effect.forkIn(state.registration.scope));
      });

      const engine = WorkflowEngine.makeUnsafe({
        register: Effect.fnUntraced(function* (workflow, execute) {
          if (registrations.has(workflow._tag)) {
            return yield* Effect.die(
              `Workflow ${workflow._tag} is already registered for ${revisionId}`,
            );
          }
          registrations.set(workflow._tag, { workflow, execute, scope: yield* Effect.scope });
        }),
        execute: Effect.fnUntraced(function* (workflow, options) {
          const registration = registrations.get(workflow._tag);
          if (registration === undefined) {
            return yield* Effect.die(
              `Workflow ${workflow._tag} is not registered for ${revisionId}`,
            );
          }
          let state = executions.get(options.executionId);
          if (state === undefined) {
            state = {
              payload: options.payload,
              registration,
              instance: WorkflowEngine.WorkflowInstance.initial(workflow, options.executionId),
            };
            executions.set(options.executionId, state);
            yield* resume(options.executionId);
          }
          const result = yield* Fiber.join(
            state.fiber as Fiber.Fiber<Workflow.Result<unknown, unknown>>,
          );
          if (options.discard) return yield* Effect.void;
          return result;
        }) as WorkflowEngine.Encoded["execute"],
        poll: (_workflow, executionId) =>
          Effect.sync(() => {
            const state = executions.get(executionId);
            if (state?.fiber === undefined) return Option.none();
            const exit = state.fiber.pollUnsafe();
            if (exit === undefined) return Option.none();
            if (exit._tag === "Failure") throw exit.cause;
            return Option.some(exit.value);
          }),
        interrupt: (_workflow, executionId) =>
          Effect.suspend(() => {
            const state = executions.get(executionId);
            if (state === undefined) return Effect.void;
            state.instance.interrupted = true;
            return resume(executionId);
          }),
        interruptUnsafe: (_workflow, executionId) =>
          Effect.suspend(() => {
            const state = executions.get(executionId);
            if (state?.fiber === undefined) return Effect.void;
            state.instance.interrupted = true;
            return Fiber.interrupt(state.fiber).pipe(Effect.asVoid);
          }),
        resume: (_workflow, executionId) => resume(executionId),
        activityExecute: Effect.fnUntraced(function* (activity, attempt) {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const recorded = yield* repository.readResult(
            instance.executionId,
            revisionId,
            activity.name,
            attempt,
          );
          const replay = recordedReplayDecision(recorded);
          if (replay.kind === "reuse")
            return replay.result as unknown as Workflow.Result<unknown, unknown>;

          const recoveryPolicy = Context.get(activity.annotations, ActionRecoveryPolicy);
          const execution = executions.get(instance.executionId);
          if (execution === undefined)
            return yield* Effect.die(`Execution ${instance.executionId} is not registered`);
          const { actionId, inputHash } = externalActionIdentity({
            runId: instance.executionId,
            revisionId,
            phasePath: activity.name,
            attempt,
            payload: execution.payload,
          });
          if (
            externalActionDecision(recoveryPolicy) === "recoverable-external" &&
            recoveryPolicy !== undefined
          ) {
            const intendedAt = yield* Clock.currentTimeMillis;
            const decision = yield* repository.beginAction(
              actionId,
              activity.name,
              attempt,
              inputHash,
              recoveryPolicy,
              intendedAt,
            );
            if (decision.kind === "reuse-result")
              return decision.result as unknown as Workflow.Result<unknown, unknown>;
            if (decision.kind === "hold") {
              return yield* Effect.die(
                `External action ${decision.actionId} is unresolved and requires accepted evidence or exact retry authorization`,
              );
            }
          }

          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          const startedAt = yield* Clock.currentTimeMillis;
          const result = yield* activity.executeEncoded.pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
          );
          if (result._tag === "Complete") {
            const endedAt = yield* Clock.currentTimeMillis;
            const encoded = JSON.parse(JSON.stringify(result)) as JsonValue;
            yield* repository.commitResult(
              instance.executionId,
              revisionId,
              activity.name,
              attempt,
              encoded,
              { startedAt, endedAt },
              recoveryPolicy === undefined ? undefined : actionId,
            );
          }
          return result;
        }),
        deferredResult: Effect.fnUntraced(function* (deferred) {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const result = yield* repository.readDeferred(instance.executionId, deferred.name);
          return result === undefined
            ? Option.none()
            : Option.some(result as unknown as Exit.Exit<unknown, unknown>);
        }),
        deferredDone: (options) =>
          repository.commitDeferred(
            options.executionId,
            options.deferredName,
            JSON.parse(JSON.stringify(options.exit)) as JsonValue,
          ),
        scheduleClock: (_workflow, options) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              repository.scheduleWakeup(
                options.executionId,
                options.clock.deferred.name,
                now + Duration.toMillis(options.clock.duration),
              ),
            ),
          ),
      });

      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      return engine;
    }),
  );
