import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { DaemonExecutionRepository } from "../ports/DaemonExecutionRepository.ts";

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

/** Durable encoded engine for one exact Workflow Revision in one Project Runner process. */
export const layer = (
  revisionId: string,
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
        state.fiber = yield* state.registration
          .execute(state.payload, executionId)
          .pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, state.instance),
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            Effect.forkIn(state.registration.scope),
          );
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
          if (options.discard) return yield* Effect.void;
          return yield* Fiber.join(state.fiber as Fiber.Fiber<Workflow.Result<unknown, unknown>>);
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
          if (recorded !== undefined)
            return recorded as unknown as Workflow.Result<unknown, unknown>;

          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          const result = yield* activity.executeEncoded.pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
          );
          if (result._tag === "Complete") {
            yield* repository.commitResult(
              instance.executionId,
              revisionId,
              activity.name,
              attempt,
              result as unknown as JsonValue,
            );
          }
          return result;
        }),
        deferredResult: () =>
          Effect.die("Durable Deferreds are not part of the no-Trigger Runner slice"),
        deferredDone: () =>
          Effect.die("Durable Deferreds are not part of the no-Trigger Runner slice"),
        scheduleClock: () =>
          Effect.die("Durable clocks are not part of the no-Trigger Runner slice"),
      });

      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      return engine;
    }),
  );
