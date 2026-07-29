import { sep } from "node:path";
import type {
  ProjectIdentity,
  ProjectMutationResult,
  ProjectSelector,
  ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectRuntime } from "../../../workflow-execution/projects/services/project-runtime";
import { ProjectIndexStore, successfulMutation } from "../services/project-index-store";
import { mutationFailure, replay, requestConflict } from "./project-operation-results";
import {
  projectMutationFingerprint as fingerprint,
  recordProjectMutation as record,
} from "./project-receipts";

const selectorInput = (selector: ProjectSelector) => JSON.stringify(selector);
const forgetInput = (identity: ProjectIdentity, selector: ProjectSelector) =>
  JSON.stringify({ identity, selector });
const selectorLookupKey = (selector: ProjectSelector) =>
  fingerprint("forget", selectorInput(selector));

const selectorMatchesProject = (selector: ProjectSelector, project: ProjectSnapshot) =>
  selector.kind === "identity"
    ? selector.identity === project.identity
    : selector.path === project.path || selector.path.startsWith(`${project.path}${sep}`);
type ForgetResolution =
  | { readonly _tag: "project"; readonly project: ProjectSnapshot }
  | { readonly _tag: "result"; readonly result: ProjectMutationResult };
export const forgetProject = (
  identity: ProjectIdentity,
  selector: ProjectSelector,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectIndexStore | ProjectRuntime> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const runtime = yield* ProjectRuntime;
    const state = yield* store.read;
    const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
    const input = forgetInput(identity, selector);
    const requestFingerprint = fingerprint("forget", input);
    if (receipt !== undefined) {
      return receipt.operation === "forget" && receipt.fingerprint === requestFingerprint
        ? replay(receipt.result)
        : requestConflict(requestKey);
    }
    const resolveCurrentProject: Effect.Effect<ForgetResolution> = Effect.suspend(() =>
      store.update<ForgetResolution>((latest) =>
        Effect.sync(() => {
          const currentReceipt = latest.receipts.find(
            (candidate) => candidate.requestKey === requestKey,
          );
          if (currentReceipt !== undefined) {
            return {
              state: latest,
              result: {
                _tag: "result" as const,
                result:
                  currentReceipt.operation === "forget" &&
                  currentReceipt.fingerprint === requestFingerprint
                    ? replay(currentReceipt.result)
                    : requestConflict(requestKey),
              },
            };
          }
          const currentProject = latest.projects.find(
            (candidate) => candidate.identity === identity,
          );
          if (currentProject !== undefined && selectorMatchesProject(selector, currentProject)) {
            return {
              state: latest,
              result: { _tag: "project" as const, project: currentProject },
            };
          }
          const result = mutationFailure(
            requestKey,
            "project-not-found",
            "Kojo Project was not found in the Project Index.",
            "Choose a listed Project Identity.",
            { kind: "project", identity },
            [],
          );
          return {
            state: record(latest, requestKey, "forget", input, result, selectorLookupKey(selector)),
            result: { _tag: "result" as const, result },
          };
        }),
      ),
    );

    return yield* runtime.coordinateForget(identity, resolveCurrentProject, (project, blockers) =>
      store
        .update((latest) =>
          Effect.gen(function* () {
            const currentReceipt = latest.receipts.find(
              (candidate) => candidate.requestKey === requestKey,
            );
            if (currentReceipt !== undefined) {
              return {
                state: latest,
                result:
                  currentReceipt.operation === "forget" &&
                  currentReceipt.fingerprint === requestFingerprint
                    ? replay(currentReceipt.result)
                    : requestConflict(requestKey),
              };
            }
            const currentProject = latest.projects.find(
              (candidate) => candidate.identity === identity,
            );
            if (currentProject === undefined || !selectorMatchesProject(selector, currentProject)) {
              const result = mutationFailure(
                requestKey,
                "project-not-found",
                "Kojo Project was not found in the Project Index.",
                "Choose a listed Project Identity.",
                { kind: "project", identity },
                [],
              );
              return {
                state: record(
                  latest,
                  requestKey,
                  "forget",
                  input,
                  result,
                  selectorLookupKey(selector),
                ),
                result,
              };
            }

            if (blockers.assessment === "unavailable") {
              const result = mutationFailure(
                requestKey,
                "project-forget-blocked",
                "Kojo could not verify that Project execution state is safe to forget.",
                "Restore Project database readiness and retry.",
                { kind: "project", identity },
                ["store.open-failed"],
              );
              return {
                state: record(
                  latest,
                  requestKey,
                  "forget",
                  input,
                  result,
                  selectorLookupKey(selector),
                ),
                result,
              };
            }
            if (blockers.enabledScheduleKeys.length > 0 || blockers.nonFinalRunIds.length > 0) {
              const result = mutationFailure(
                requestKey,
                "project-forget-blocked",
                "Kojo Project cannot be forgotten while it has enabled Workflow Schedules or non-final Workflow Runs.",
                "Disable every Workflow Schedule and finish or stop every non-final Workflow Run, then retry.",
                { kind: "project", identity },
                [],
              );
              return {
                state: record(
                  latest,
                  requestKey,
                  "forget",
                  input,
                  result,
                  selectorLookupKey(selector),
                ),
                result,
              };
            }

            const result = successfulMutation(requestKey, project, false);
            const nextState = record(
              {
                ...latest,
                projects: latest.projects.filter((candidate) => candidate.identity !== identity),
              },
              requestKey,
              "forget",
              input,
              result,
              selectorLookupKey(selector),
            );
            return { state: nextState, result };
          }),
        )
        .pipe(Effect.map((result) => ({ deactivate: result.ok, result }))),
    );
  });

export const replayForgetProject = (
  selector: ProjectSelector,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectIndexStore> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const state = yield* store.read;
    const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
    if (
      receipt === undefined ||
      receipt.operation !== "forget" ||
      receipt.selectorLookupKey !== selectorLookupKey(selector)
    ) {
      return requestConflict(requestKey);
    }
    return replay(receipt.result);
  });
