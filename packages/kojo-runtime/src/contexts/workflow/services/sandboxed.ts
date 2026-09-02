import { Cause, Clock, Effect, Exit, Layer, Option, Scope } from "effect";
import {
  providerResourceEnvironment,
  resourceLeaseId,
} from "../../project/models/ProviderResource.ts";
import { ResourceLeaseClient } from "../../project/ports/ResourceLeaseClient.ts";
import { workspaceIsReachable, workspaceProbe } from "../../sandbox/guards/workspaceIsReachable.ts";
import { worktreeIsUsable } from "../../sandbox/guards/worktreeIsUsable.ts";
import type { SandboxError } from "../../sandbox/models/SandboxError.ts";
import type { SandboxHandle } from "../../sandbox/models/SandboxHandle.ts";
import type { SandboxConfig, SandboxRequest } from "../../sandbox/models/SandboxRequest.ts";
import type { WorkspaceReach } from "../../sandbox/models/WorkspaceReach.ts";
import { WorkspaceUnreachable } from "../../sandbox/models/WorkspaceUnreachable.ts";
import type { WorktreeUnusable } from "../../sandbox/models/WorktreeUnusable.ts";
import { Sandbox } from "../../sandbox/ports/Sandbox.ts";
import { SandboxSource } from "../../sandbox/ports/SandboxSource.ts";
import type { Workspace } from "../../sandbox/ports/Workspace.ts";
import { acquisitionAttempt, correlationEnvironment } from "../../shared/models/Correlation.ts";
import { makeSandboxId, nextAcquisition } from "../../shared/models/SandboxId.ts";
import { SandboxRecord } from "../../trace/models/SandboxRecord.ts";
import { Tracer } from "../../trace/ports/Tracer.ts";
import { factoryOwnPaths } from "../models/PermissionPolicy.ts";
import { CurrentRun } from "./CurrentRun.ts";

/** One container, plus what it answered when it was asked whether its workspace is there. */
interface Attempt {
  readonly sandbox: SandboxHandle;
  readonly reach: WorkspaceReach;
}

/**
 * Acquire one sandbox, record it, and prove both the workspace and the tree it was built on.
 *
 * The order of the four is deliberate.
 *
 * The record's finalizer is registered **after** the container exists and **before** anything is
 * graded, so an acquisition that is then rejected still leaves a row: it happened, it cost what it
 * cost, and a trace that hid it because a check failed afterwards would be a trace that omits
 * exactly the runs somebody is investigating.
 *
 * The workspace is probed **before** the worktree is read, and that is not an optimisation. The
 * probe finds a fault the caller can *recover* from; the worktree read finds faults it cannot. Ask
 * the terminal question first and a recoverable run gets reported as something else — worse, when
 * the workspace is genuinely gone, host git in that same directory fails too, so the run would die
 * naming `git rev-parse` instead of the workspace. That is the message this whole file exists to
 * stop, in a different accent.
 */
const acquireOnce = (config: SandboxConfig) =>
  Effect.gen(function* () {
    const source = yield* SandboxSource;
    const resources = yield* ResourceLeaseClient;
    const tracer = yield* Tracer;
    const run = yield* CurrentRun;

    const acquiredAt = yield* Clock.currentTimeMillis;
    // The clock says *when*, the sequence says *which* — see `makeSandboxId`. Read here rather than
    // inside it so the id stays a pure function of its parts.
    const sequence = yield* Effect.sync(nextAcquisition);
    const id = makeSandboxId(run.runId, config.name, acquiredAt, sequence);

    // The correlation is built here, from the run and this acquisition, and nothing downstream may
    // invent it. `KOJO_PHASE_ID` carries the sandbox id because at this moment there is no phase —
    // a sandbox is a scope around phases — and the row the container's own output belongs to is the
    // sandbox row. An agent invocation inside the scope overwrites the phase half with its own.
    const environment = correlationEnvironment({
      runId: run.runId,
      phaseId: id,
      attempt: acquisitionAttempt,
    });

    // The default is resolved here and nowhere else. `factoryOwnPaths` is the workflow context's
    // list — it is what `withPermissions` protects after the fact — and the sandbox context must not
    // learn about it, so the one place that knows both is the scope that joins them. An author who
    // writes nothing gets the roster, the workflows, the envelopes, the checks, the commands and the
    // prompts taken out of the tree the agent works in; `hidden: []` is how a factory says otherwise,
    // out loud and greppably. See architecture.md §8, edge 5.
    const sandboxAcquisitionKey = `${id}/sandbox`;
    const worktreeAcquisitionKey = `${id}/worktree`;
    const sandboxLeaseId = resourceLeaseId(sandboxAcquisitionKey);
    const worktreeLeaseId = resourceLeaseId(worktreeAcquisitionKey);
    const [sandboxResource, worktreeResource] = yield* Effect.all([
      resources.beginAcquisition({
        leaseId: sandboxLeaseId,
        kind: "sandbox",
        acquisitionKey: sandboxAcquisitionKey,
        detail: { branch: config.branch, scope: config.name },
      }),
      resources.beginAcquisition({
        leaseId: worktreeLeaseId,
        kind: "worktree",
        acquisitionKey: worktreeAcquisitionKey,
        detail: { branch: config.branch, scope: config.name },
      }),
    ]);
    const request: SandboxRequest = {
      ...config,
      id,
      environment: {
        ...environment,
        ...providerResourceEnvironment(sandboxResource),
        KOJO_WORKTREE_ACQUISITION_KEY: worktreeResource.acquisitionKey,
        KOJO_WORKTREE_PROVIDER_IDENTITY: worktreeResource.providerIdentity,
        KOJO_WORKTREE_INSPECTION_FILE: worktreeResource.inspectionLocator,
      },
      hidden: config.hidden ?? factoryOwnPaths,
      resources: { sandbox: sandboxResource, worktree: worktreeResource },
    };
    const acquired = yield* source
      .acquire(request, {
        acquired: (sandbox) =>
          Effect.all([
            resources.confirmAcquired(sandboxLeaseId, {
              providerIdentity: sandboxResource.providerIdentity,
              locator: sandbox.worktreePath,
            }),
            resources.confirmAcquired(worktreeLeaseId, {
              providerIdentity: worktreeResource.providerIdentity,
              locator: sandbox.worktreePath,
            }),
          ]).pipe(Effect.asVoid),
        releaseIntent: Effect.all([
          resources.beginRelease(sandboxLeaseId),
          resources.beginRelease(worktreeLeaseId),
        ]).pipe(Effect.asVoid),
        released: (kind, evidence) =>
          resources.confirmReleased(
            kind === "sandbox" ? sandboxLeaseId : worktreeLeaseId,
            evidence,
          ),
        preserved: (kind, reason) =>
          resources.preserve(kind === "sandbox" ? sandboxLeaseId : worktreeLeaseId, reason),
        unresolved: (kind, reason) =>
          resources.unresolved(kind === "sandbox" ? sandboxLeaseId : worktreeLeaseId, reason),
      })
      .pipe(
        Effect.tapError(() =>
          Effect.all([
            resources.unresolved(sandboxLeaseId, "the provider did not return a sandbox identity"),
            resources.unresolved(
              worktreeLeaseId,
              "the provider did not return a worktree identity",
            ),
          ]).pipe(Effect.asVoid),
        ),
      );
    const sandbox: SandboxHandle = { ...acquired, id, environment };

    // The one trace write in Kojo that is deliberately **outside** an activity. Everywhere else
    // that would be a bug — replay re-runs it and one phase leaves four rows. Here re-running is
    // the requirement: a second entry is a second container, and it is owed a second row.
    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        const releasedAt = yield* Clock.currentTimeMillis;
        yield* tracer.sandbox(
          new SandboxRecord({
            runId: run.runId,
            sandboxId: id,
            name: config.name,
            provider: sandbox.provider,
            kind: sandbox.capabilities.kind,
            branch: sandbox.branch,
            worktreePath: sandbox.worktreePath,
            environment,
            acquiredAt,
            releasedAt,
            // A suspension arrives as an ordinary interrupt, so this is the outcome a gate leaves
            // behind, and it is not a fault.
            outcome:
              exit._tag === "Success"
                ? "released"
                : Cause.hasInterrupts(exit.cause)
                  ? "interrupted"
                  : "failed",
          }),
        );
      }),
    );

    // Asked through the sandbox's own `exec`, which is the one door every provider has: a bind mount
    // answers from the container, an isolated provider from its copy, `no-sandbox` from the host.
    // A non-zero exit and a command that never ran are the same fact here, so `Effect.result` hands
    // both shapes to one reading.
    const reach = workspaceIsReachable(yield* Effect.result(sandbox.exec(workspaceProbe)));
    if (!reach.reached) return { sandbox, reach } satisfies Attempt;

    const state = yield* source.worktree(acquired);
    const unusable = worktreeIsUsable({
      branch: config.branch,
      worktreePath: sandbox.worktreePath,
      state,
      policy: config.worktree,
    });
    if (Option.isSome(unusable)) return yield* unusable.value;

    return { sandbox, reach } satisfies Attempt;
  });

/**
 * How many containers one entry into a scope may build before it gives up. Three.
 *
 * Small, because each one is a real container and a run that builds them in a loop is worse than a
 * run that stops. Greater than one, because the fault is a *transient* disagreement about a path
 * that was just deleted and recreated — ticket 19 measured it at 1 in 6 acquisitions under `/Users`
 * and 3 in 4 under `$TMPDIR`, never at 1 in 1. Three independent draws is the argument for the
 * number, and it is an argument rather than a measurement: nothing here proves a rebuild clears it
 * in the wild, only that a rebuild is what a run should do about it.
 */
const containerLimit = 3;

/**
 * Build a sandbox, and build another one when the workspace it comes back with is unusable.
 *
 * **Recovered from, not reported.** Nothing about the run is wrong when this happens: the branch
 * carries the work, the recorded phases stay recorded, the human's answer is still in the gate
 * store. What is wrong is one container, and the answer to one bad container is another container.
 *
 * Each attempt gets a **forked scope of its own**, and that is what makes the rebuild honest rather
 * than a leak. A discarded container is released the moment it is discarded — `Scope.close` detaches
 * the child from its parent and runs its finalizers — so a scope that builds three never holds more
 * than one, and each of the three leaves its own trace row with its own cost. The close carries a
 * failure exit, so the discarded acquisition is recorded `failed`, exactly like an acquisition the
 * worktree check rejects: the container's life ended because it was not usable.
 *
 * A scope that never has to rebuild forks once, and the child closes with its parent — which is what
 * keeps `interrupted` on the row when a gate suspends the run.
 */
const acquire = (
  config: SandboxConfig,
  built = 1,
): Effect.Effect<
  SandboxHandle,
  SandboxError | WorktreeUnusable | WorkspaceUnreachable,
  Scope.Scope | SandboxSource | Tracer | CurrentRun | ResourceLeaseClient
> =>
  Effect.gen(function* () {
    const parent = yield* Scope.Scope;
    const scope = yield* Scope.fork(parent);

    const attempt = yield* acquireOnce(config).pipe(Scope.provide(scope));
    if (attempt.reach.reached) return attempt.sandbox;

    const unreachable = new WorkspaceUnreachable({
      branch: config.branch,
      worktreePath: attempt.sandbox.worktreePath,
      containers: built,
      reach: attempt.reach,
    });
    yield* Scope.close(scope, Exit.fail(unreachable));

    return built >= containerLimit ? yield* unreachable : yield* acquire(config, built + 1);
  });

/** The sandbox, and the workspace that sandbox says a phase should act through. */
const layers = (config: SandboxConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const source = yield* SandboxSource;
      const sandbox = yield* Sandbox;
      return source.workspace(sandbox);
    }),
  ).pipe(Layer.provideMerge(Layer.effect(Sandbox, acquire(config))));

/**
 * A region of a workflow that runs inside a sandbox. Setup on the host, risk inside, merge outside.
 *
 * **The scope is local, and it sits outside every phase.** Both halves are load-bearing, and each
 * has a way of being wrong that only shows up on the first suspension:
 *
 * - *Local, not workflow-lifetime.* `Workflow.scope` closes only when an execution fully completes —
 *   `intoResult` calls `Scope.close` on failure and on Complete, and the Suspended branch returns
 *   `Effect.void`. A sandbox acquired there is held for the whole of a two-day gate, which is the
 *   opposite of the decision this design rests on. `Effect.provide` builds this layer in a scope of
 *   its own, and `Workflow.suspend` interrupts the fiber, so an ordinary interrupt unwinds it: the
 *   container stops and the branch stays.
 * - *Outside every phase.* `Activity.make` wraps its body in `retryOnInterrupt` — it retries while
 *   the cause has interrupts, ten times, and then dies with "interrupted and retry attempts
 *   exhausted". Suspension **is** an interrupt, so a sandbox acquired inside a phase turns a gate
 *   into a defect. Tear-down-and-rebuild works precisely because this is a scope *around* phases.
 *
 * Re-entry on replay is what rebuilds it. Completed phases return their recorded results without
 * running again, so the replay reaches here in milliseconds and the container is built from the
 * branch alone (§4, rule 2) — nothing about the previous container is remembered, because nothing
 * about it was state.
 *
 * `{ local: true }` builds the layer against a memo map of its own, so a second entry can never
 * reuse the first container. **It is a guard, not a load-bearing line, and no test grades it**:
 * `MemoMapImpl` keys on layer *object identity* and `layers(config)` below constructs a fresh
 * `Layer` on every call, so a shared memo map has nothing to match. Measured — removing the option
 * leaves the whole unit tier green. Keep it: it is what stops a later hoist of `layers(config)` out
 * of this function from silently handing a released container back to a resumed run.
 *
 * Sandboxes **nest**: the body may open another, and the inner scope shadows `Sandbox` and
 * `Workspace` for its own region only. Two lanes of a factory can want different images, different
 * mounts and different hooks, and they get them as branches of the graph rather than as one wrapper
 * around the run.
 *
 * **A container whose workspace is unusable is rebuilt, not reported** — see `acquire`. It is the
 * one fault in this file that does not belong to the run, and `WorkspaceUnreachable` is what an
 * author declares for the case where three of them in a row say the same thing.
 */
/** @public */
export const sandboxed = <A, E, R>(
  config: SandboxConfig,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | SandboxError | WorktreeUnusable | WorkspaceUnreachable,
  Exclude<R, Sandbox | Workspace> | SandboxSource | Tracer | CurrentRun | ResourceLeaseClient
> => Effect.provide(body, layers(config), { local: true });
