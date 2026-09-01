import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeJsonValue,
  decodeSuccess,
} from "../../shared/codecs/json.ts";
import { decodeRunnerIdentity, decodeSha256 } from "../../shared/models/identity.ts";
import {
  decodeArtifactChunkBody,
  decodeBeginArtifactBody,
  decodeFinishArtifactBody,
} from "../contracts/artifact.ts";
import {
  decodeCancelRunBody,
  decodeCommitActionResultBody,
  decodeExecuteRunBody,
  decodeOperationReplyBody,
  decodeReadResultBody,
  decodeRegisterRevisionBody,
} from "../contracts/execution.ts";
import type { RunnerFrame } from "../contracts/frame.ts";
import { decodeHelloBody, decodeWelcomeBody } from "../contracts/handshake.ts";
import { isExecutionMutationKind, isRunnerOperationKind } from "../contracts/operations.ts";
import {
  decodeBeginResourceAcquisitionBody,
  decodeBeginResourceReleaseBody,
  decodeConfirmResourceAcquiredBody,
  decodeConfirmResourceReleasedBody,
  decodePreserveResourceBody,
  decodeReportRecoveryBody,
} from "../contracts/resource.ts";

const prefixIssues = <A>(
  result: DecodeResult<A>,
  prefix: ReadonlyArray<number | string>,
): DecodeResult<A> =>
  result.ok
    ? result
    : {
        ok: false,
        issues: result.issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] })),
      };

export const decodeRunnerFrame = (input: unknown): DecodeResult<RunnerFrame> => {
  const base = decodeClosedRecord(input, [
    "version",
    "kind",
    "requestId",
    "daemonInstanceId",
    "runnerInstanceId",
    "runId",
    "revisionId",
    "claimGeneration",
    "body",
  ]);
  if (!base.ok) return base;
  if (base.value.version !== 1)
    return decodeFailure(["version"], "Expected Runner protocol version 1");
  if (!isRunnerOperationKind(base.value.kind))
    return decodeFailure(["kind"], "Unknown Runner operation kind");

  const requestId = decodeRunnerIdentity(base.value.requestId, ["requestId"]);
  if (!requestId.ok) return requestId;
  const daemonInstanceId = decodeRunnerIdentity(base.value.daemonInstanceId, ["daemonInstanceId"]);
  if (!daemonInstanceId.ok) return daemonInstanceId;
  const runnerInstanceId = decodeRunnerIdentity(base.value.runnerInstanceId, ["runnerInstanceId"]);
  if (!runnerInstanceId.ok) return runnerInstanceId;

  const isExecutionMutation = isExecutionMutationKind(base.value.kind);
  const executionKeys = ["runId", "revisionId", "claimGeneration"] as const;
  if (!isExecutionMutation) {
    const unexpected = executionKeys.find((key) => key in base.value);
    if (unexpected !== undefined)
      return decodeFailure([unexpected], "Unexpected execution mutation field");
  }

  let body: DecodeResult<unknown>;
  if (base.value.kind === "Hello") {
    body = prefixIssues(decodeHelloBody(base.value.body), ["body"]);
  } else if (base.value.kind === "Welcome") {
    body = prefixIssues(decodeWelcomeBody(base.value.body), ["body"]);
  } else if (base.value.kind === "WriteArtifactChunk") {
    body = prefixIssues(decodeArtifactChunkBody(base.value.body), ["body"]);
  } else if (base.value.kind === "BeginArtifact") {
    body = prefixIssues(decodeBeginArtifactBody(base.value.body), ["body"]);
  } else if (base.value.kind === "FinishArtifact") {
    body = prefixIssues(decodeFinishArtifactBody(base.value.body), ["body"]);
  } else if (base.value.kind === "RegisterRevision") {
    body = prefixIssues(decodeRegisterRevisionBody(base.value.body), ["body"]);
  } else if (base.value.kind === "ExecuteRun") {
    body = prefixIssues(decodeExecuteRunBody(base.value.body), ["body"]);
  } else if (base.value.kind === "CancelRun") {
    body = prefixIssues(decodeCancelRunBody(base.value.body), ["body"]);
  } else if (base.value.kind === "ReadResult") {
    body = prefixIssues(decodeReadResultBody(base.value.body), ["body"]);
  } else if (base.value.kind === "CommitActionResult") {
    body = prefixIssues(decodeCommitActionResultBody(base.value.body), ["body"]);
  } else if (base.value.kind === "Ready") {
    body = prefixIssues(decodeOperationReplyBody(base.value.body), ["body"]);
  } else if (base.value.kind === "BeginResourceAcquisition") {
    body = prefixIssues(decodeBeginResourceAcquisitionBody(base.value.body), ["body"]);
  } else if (base.value.kind === "ConfirmResourceAcquired") {
    body = prefixIssues(decodeConfirmResourceAcquiredBody(base.value.body), ["body"]);
  } else if (base.value.kind === "BeginResourceRelease") {
    body = prefixIssues(decodeBeginResourceReleaseBody(base.value.body), ["body"]);
  } else if (base.value.kind === "ConfirmResourceReleased") {
    body = prefixIssues(decodeConfirmResourceReleasedBody(base.value.body), ["body"]);
  } else if (base.value.kind === "PreserveResource") {
    body = prefixIssues(decodePreserveResourceBody(base.value.body), ["body"]);
  } else if (base.value.kind === "ReportRecovery") {
    body = prefixIssues(decodeReportRecoveryBody(base.value.body), ["body"]);
  } else {
    body = prefixIssues(decodeJsonValue(base.value.body), ["body"]);
  }
  if (!body.ok) return body;

  const common = {
    version: 1 as const,
    kind: base.value.kind,
    requestId: requestId.value,
    daemonInstanceId: daemonInstanceId.value,
    runnerInstanceId: runnerInstanceId.value,
    body: body.value,
  };
  if (!isExecutionMutation) return decodeSuccess(common as RunnerFrame);

  const runId = decodeRunnerIdentity(base.value.runId, ["runId"]);
  if (!runId.ok) return runId;
  const revisionId = decodeSha256(base.value.revisionId, ["revisionId"]);
  if (!revisionId.ok) return revisionId;
  const claimGeneration = decodeInteger(base.value.claimGeneration, ["claimGeneration"], {
    minimum: 1,
  });
  if (!claimGeneration.ok) return claimGeneration;
  return decodeSuccess({
    ...common,
    runId: runId.value,
    revisionId: revisionId.value,
    claimGeneration: claimGeneration.value,
  } as RunnerFrame);
};
