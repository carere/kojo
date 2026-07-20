import { Cause, Console, Effect, Exit, Semaphore } from "effect";
import { runText } from "../../shared/process";
import {
  type DeliveryOptions,
  type DeliveryWorkstream,
  PreparedTarget,
  type ReviewedIssue,
} from "../../types/delivery";
import { WorkflowError } from "../../types/errors";
import { finalizeCompletedWorkstream, integrateIssue, recoverIntegratedIssue } from "./integration";
import { discoverWorkstreams } from "./issues";
import { hasSameDeliveryMetadata } from "./metadata";
import { holdDeliveryPullRequestsBeforeDiscovery } from "./pull-request";
import { type DeliveryRepository, resolveDeliveryRepository } from "./repository";
import { DeliveryAgents, DeliveryTracker } from "./services";
import { acquireTargetLock, prepareTarget, releaseTargetLock } from "./target";
import { selectReadyFrontier } from "./workstream";

const processWorkstream = Effect.fn("processWorkstream")(function* (
  repository: DeliveryRepository,
  initial: DeliveryWorkstream,
  options: DeliveryOptions,
) {
  const agents = yield* DeliveryAgents;
  const tracker = yield* DeliveryTracker;
  return yield* Effect.acquireUseRelease(
    acquireTargetLock(repository.rootPath, initial.delivery.targetBranch),
    () =>
      Effect.gen(function* () {
        // 1. Hold any legacy PR before target preparation can fail, then pin the target branch.
        yield* tracker.holdPullRequest(repository, initial);
        if (initial.delivery.destinationBranch !== repository.defaultBranch) {
          return yield* new WorkflowError({
            message: `Delivery destination '${initial.delivery.destinationBranch}' is not the repository default branch '${repository.defaultBranch}'. GitHub only applies Closes references when a PR targets the default branch.`,
            operation: "delivery.processWorkstream",
          });
        }
        const target = yield* prepareTarget(repository.rootPath, initial);
        yield* Console.log(`\n#${initial.root.number} → ${target.branch}`);
        yield* Console.log(`Target worktree: ${target.path}`);

        for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
          // 2. Reload GitHub state before every iteration so stale issue specifications cannot ship.
          const workstream = yield* tracker.loadWorkstream(repository, initial.root.number);
          if (!hasSameDeliveryMetadata(initial.delivery, workstream.delivery)) {
            return yield* new WorkflowError({
              message: `Workstream #${workstream.root.number} changed Delivery metadata`,
              operation: "delivery.processWorkstream",
            });
          }
          if (yield* finalizeCompletedWorkstream(repository, target, workstream)) {
            return;
          }

          // 3. Recover work already merged locally before asking agents to implement anything new.
          const frontier = selectReadyFrontier(workstream.tickets);
          if (frontier.length === 0) {
            return yield* new WorkflowError({
              message: `Workstream #${workstream.root.number} has pending tickets but no ready frontier`,
              operation: "delivery.processWorkstream",
            });
          }
          const recovered = yield* Effect.forEach(
            frontier,
            (issue) => recoverIntegratedIssue(repository, target, workstream, issue),
            { concurrency: 1 },
          );
          if (recovered.some(Boolean)) {
            if (workstream.kind === "standalone") {
              yield* Console.log(
                "Standalone delivery recovered. Target retained for pull request review.",
              );
              return;
            }
            const recoveredWorkstream = yield* tracker.loadWorkstream(
              repository,
              workstream.root.number,
            );
            if (!hasSameDeliveryMetadata(initial.delivery, recoveredWorkstream.delivery)) {
              return yield* new WorkflowError({
                message: `Workstream #${recoveredWorkstream.root.number} changed Delivery metadata`,
                operation: "delivery.processWorkstream",
              });
            }
            if (yield* finalizeCompletedWorkstream(repository, target, recoveredWorkstream)) {
              return;
            }
            continue;
          }
          // 4. Plan a bounded batch, then implement and review its issues concurrently.
          const baseSha = yield* runText(["git", "rev-parse", "HEAD"], target.path);
          const iterationTarget = new PreparedTarget({ ...target, baseSha });
          const selectedIds = yield* agents.plan(
            iterationTarget,
            workstream,
            frontier,
            options.concurrency,
          );
          const selected = yield* Effect.forEach(selectedIds, (id) => {
            const issue = frontier.find(({ number }) => String(number) === id);
            return issue
              ? Effect.succeed(issue)
              : new WorkflowError({
                  message: `Planner selected missing issue #${id}`,
                  operation: "delivery.processWorkstream",
                });
          });
          yield* Console.log(
            `Iteration ${iteration}: ${selected.map(({ number }) => `#${number}`).join(", ")}`,
          );

          const attempts = yield* Effect.forEach(
            selected,
            (issue) =>
              agents
                .implementAndReview(repository.rootPath, iterationTarget, workstream, issue)
                .pipe(Effect.exit),
            { concurrency: "unbounded" },
          );
          const reviewed: Array<ReviewedIssue> = [];
          for (const [index, attempt] of attempts.entries()) {
            if (Exit.isSuccess(attempt)) reviewed.push(attempt.value);
            else {
              yield* Console.error(
                `  ✗ #${selected[index]?.number}: ${Cause.pretty(attempt.cause)}`,
              );
            }
          }
          if (reviewed.length === 0) {
            return yield* new WorkflowError({
              message: "No issue passed implementation and review",
              operation: "delivery.processWorkstream",
            });
          }

          // 5. Integrate reviewed branches serially so every merge sees the exact expected target HEAD.
          let expectedTargetHead = baseSha;
          for (const issue of reviewed) {
            expectedTargetHead = yield* integrateIssue(
              repository,
              iterationTarget,
              workstream,
              issue,
              expectedTargetHead,
            );
          }
          if (workstream.kind === "standalone") {
            yield* Console.log(
              "Standalone delivery complete. Target retained for pull request review.",
            );
            return;
          }

          // 6. Finalize immediately when the batch closed the last child; otherwise start a fresh loop.
          const refreshed = yield* tracker.loadWorkstream(repository, workstream.root.number);
          if (!hasSameDeliveryMetadata(initial.delivery, refreshed.delivery)) {
            return yield* new WorkflowError({
              message: `Workstream #${refreshed.root.number} changed Delivery metadata`,
              operation: "delivery.processWorkstream",
            });
          }
          if (yield* finalizeCompletedWorkstream(repository, target, refreshed)) {
            return;
          }
        }

        return yield* new WorkflowError({
          message: `Workstream #${initial.root.number} reached the iteration limit`,
          operation: "delivery.processWorkstream",
        });
      }),
    (lockPath) => releaseTargetLock(lockPath),
  );
});

export const processWorkstreams = Effect.fn("processWorkstreams")(function* (
  repository: DeliveryRepository,
  workstreams: ReadonlyArray<DeliveryWorkstream>,
  options: DeliveryOptions,
) {
  const agents = yield* DeliveryAgents;
  const capacity = yield* Semaphore.make(options.concurrency);
  const boundedAgents = DeliveryAgents.of({
    implementAndReview: (...arguments_) =>
      capacity.withPermit(agents.implementAndReview(...arguments_)),
    plan: (...arguments_) => capacity.withPermit(agents.plan(...arguments_)),
    repair: (...arguments_) => capacity.withPermit(agents.repair(...arguments_)),
    verify: (...arguments_) => capacity.withPermit(agents.verify(...arguments_)),
  });
  const attempts = yield* Effect.forEach(
    workstreams,
    (workstream) =>
      processWorkstream(repository, workstream, options).pipe(
        Effect.provideService(DeliveryAgents, boundedAgents),
        Effect.exit,
      ),
    { concurrency: "unbounded" },
  );
  const failure = attempts.find(Exit.isFailure);
  if (failure?.cause) return yield* Effect.failCause(failure.cause);
});

export const runDeliveryInRepository = Effect.fn("runDeliveryInRepository")(function* (
  repository: DeliveryRepository,
  options: DeliveryOptions,
) {
  // Neutralize every managed PR in scope before invalid or stale issue metadata can skip it.
  yield* holdDeliveryPullRequestsBeforeDiscovery(repository, options.root);
  const workstreams = yield* discoverWorkstreams(repository, options);
  if (workstreams.length === 0) {
    yield* Console.log("No ready delivery workstreams found.");
    return;
  }
  yield* processWorkstreams(repository, workstreams, options);
});

export const runDelivery = Effect.fn("runDelivery")(function* (options: DeliveryOptions) {
  // Validate the local repository and GitHub session before mutating pull requests.
  const repository = yield* resolveDeliveryRepository();
  yield* runDeliveryInRepository(repository, options);
});
