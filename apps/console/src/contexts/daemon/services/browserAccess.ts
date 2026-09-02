import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type {
  AskingSnapshot,
  RecordVerdictRequest,
  RecordVerdictResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ClientRequestSnapshot,
  ProjectLocationResult,
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type {
  CancelRunResult,
  RetryUncertainActionResult,
  RunDocument,
  RunSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  StartTriggerWorkflowResult,
  StopWorkflowResult,
  WorkflowSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { problemOf } from "../../shared/services/api.ts";
import {
  beginDaemonRead,
  daemonMutationsAllowed,
  noteDaemonReadFailure,
  noteDaemonReadSuccess,
} from "./connectionState.ts";

interface StoredSession {
  readonly credential: string;
  readonly expiresAt: string;
  readonly instanceId: string;
}

const storageKey = "kojo.browser-session.v1";
const requestSignal = (): AbortSignal => AbortSignal.timeout(5_000);

export class ConsoleAccessError extends Error {
  readonly code: "access-required" | "api-refused";

  constructor(code: "access-required" | "api-refused", message: string) {
    super(message);
    this.name = "ConsoleAccessError";
    this.code = code;
  }
}

const launchGrant = (): string | undefined => {
  const grant = new URLSearchParams(window.location.hash.slice(1)).get("grant") ?? undefined;
  if (window.location.hash.length > 0) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return grant;
};

const storedSession = (): StoredSession | undefined => {
  const value = window.sessionStorage.getItem(storageKey);
  if (value === null) return undefined;
  try {
    const session = JSON.parse(value) as Partial<StoredSession>;
    if (
      typeof session.credential !== "string" ||
      typeof session.expiresAt !== "string" ||
      typeof session.instanceId !== "string"
    ) {
      throw new Error("invalid browser session");
    }
    return {
      credential: session.credential,
      expiresAt: session.expiresAt,
      instanceId: session.instanceId,
    };
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return undefined;
  }
};

const compatibility = async (): Promise<BootstrapResponse> => {
  const response = await fetch("/_kojo/compat", {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: requestSignal(),
  });
  if (!response.ok) throw new ConsoleAccessError("api-refused", "The Daemon API is unavailable.");
  return (await response.json()) as BootstrapResponse;
};

let access: Promise<StoredSession> | undefined;

const currentAccess = (): Promise<StoredSession> => {
  access ??= (async () => {
    const grant = launchGrant();
    const bootstrap = await compatibility();
    const existing = storedSession();
    if (
      grant === undefined &&
      existing !== undefined &&
      existing.instanceId === bootstrap.instanceId &&
      Date.now() < Date.parse(existing.expiresAt)
    ) {
      return existing;
    }
    window.sessionStorage.removeItem(storageKey);
    if (grant === undefined) {
      throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
    }

    const body: BrowserSessionRequest = { grant };
    const response = await fetch("/_kojo/session", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: requestSignal(),
    });
    if (!response.ok) {
      throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
    }
    const session = (await response.json()) as BrowserSessionResponse;
    if (
      session.instanceId !== bootstrap.instanceId ||
      Date.now() >= Date.parse(session.expiresAt)
    ) {
      throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
    }
    const next: StoredSession = {
      credential: session.credential,
      expiresAt: session.expiresAt,
      instanceId: session.instanceId,
    };
    window.sessionStorage.setItem(storageKey, JSON.stringify(next));
    return next;
  })();
  return access;
};

const activeReads = new Map<string, Promise<unknown>>();

const performAuthorizedRead = async <A>(path: string): Promise<A> => {
  if (!beginDaemonRead(path)) {
    throw new ConsoleAccessError("api-refused", "Reconnect before you refresh a snapshot.");
  }
  const session = await currentAccess();
  let response: Response;
  try {
    response = await fetch(path, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.credential}`,
      },
      cache: "no-store",
      signal: requestSignal(),
    });
  } catch (cause) {
    noteDaemonReadFailure(path);
    throw cause;
  }
  if (response.status === 401 || response.status === 403) {
    window.sessionStorage.removeItem(storageKey);
    access = undefined;
    throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
  }
  if (!response.ok) {
    if (response.status >= 500) noteDaemonReadFailure(path);
    else noteDaemonReadSuccess(path);
    throw await problemOf(path, response);
  }
  const result = (await response.json()) as A;
  noteDaemonReadSuccess(path);
  return result;
};

const authorizedRead = <A>(path: string): Promise<A> => {
  const current = activeReads.get(path);
  if (current !== undefined) return current as Promise<A>;
  const read = performAuthorizedRead<A>(path).finally(() => {
    if (activeReads.get(path) === read) activeReads.delete(path);
  });
  activeReads.set(path, read);
  return read;
};

const authorizedWrite = async <A>(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<A> => {
  if (!daemonMutationsAllowed()) {
    throw new ConsoleAccessError("api-refused", "Reconnect before you send a mutation.");
  }
  const session = await currentAccess();
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: requestSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    window.sessionStorage.removeItem(storageKey);
    access = undefined;
    throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      readonly message?: string;
      readonly problem?: { readonly diagnostic?: string; readonly remedy?: string };
    };
    throw new ConsoleAccessError(
      "api-refused",
      [problem.problem?.diagnostic, problem.problem?.remedy].filter(Boolean).join(" ") ||
        problem.message ||
        "The Daemon refused the mutation.",
    );
  }
  return (await response.json()) as A;
};

const authorizedMutation = <A>(path: string, body: unknown): Promise<A> =>
  authorizedWrite<A>(path, "POST", body);

const prepareAndMutate = async <A>(path: string, request: MutationEnvelope): Promise<A> => {
  await authorizedWrite(
    `/api/v1/client-requests/${encodeURIComponent(request.requestId)}`,
    "PUT",
    request,
  );
  return authorizedMutation<A>(path, request);
};

export const readDaemon = (): Promise<DaemonDocument> =>
  authorizedRead<DaemonDocument>("/api/v1/daemon");

export const openDaemonNotifications = async (signal: AbortSignal): Promise<Response> => {
  const session = await currentAccess();
  const response = await fetch("/api/v1/notifications", {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${session.credential}`,
    },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await problemOf("/api/v1/notifications", response);
  return response;
};

export const readProjects = (): Promise<ProjectSnapshot> =>
  authorizedRead<ProjectSnapshot>("/api/v1/projects");

export const readRecentClientRequests = (): Promise<ClientRequestSnapshot> =>
  authorizedRead<ClientRequestSnapshot>("/api/v1/client-requests");

export const changeProjectLocation = async (
  projectId: string,
  action: "relocate" | "archive" | "restore",
  location?: string,
): Promise<ProjectLocationResult> => {
  const bootstrap = await compatibility();
  const requestId = crypto.randomUUID();
  const receipt = await prepareAndMutate<OperationReceipt>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/actions/${action}`,
    {
      mutationVersion: 1,
      requestId,
      dataIdentity: bootstrap.dataIdentity,
      operation: `${action}Project`,
      target: { identityVersion: 1, kind: "project", parts: [projectId] },
      arguments: { ...(location === undefined ? {} : { location }) },
      preconditions: { confirm: true },
    },
  );
  return receipt.result as unknown as ProjectLocationResult;
};

export const readWorkflows = (projectId?: string): Promise<WorkflowSnapshot> =>
  authorizedRead<WorkflowSnapshot>(
    projectId === undefined
      ? "/api/v1/workflows"
      : `/api/v1/projects/${encodeURIComponent(projectId)}/workflows`,
  );

export const readRuns = (): Promise<RunSnapshot> => authorizedRead<RunSnapshot>("/api/v1/runs");

export const readRun = (runId: string): Promise<RunDocument> =>
  authorizedRead<RunDocument>(`/api/v1/runs/${encodeURIComponent(runId)}`);

export interface PublishedArtifactContent {
  readonly artifactId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
}

export const readPublishedArtifact = (
  runId: string,
  artifactId: string,
): Promise<PublishedArtifactContent> =>
  authorizedRead<PublishedArtifactContent>(
    `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );

export const downloadPublishedArtifact = async (
  runId: string,
  artifactId: string,
  name: string,
): Promise<void> => {
  const session = await currentAccess();
  const response = await fetch(
    `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}?download=1`,
    {
      headers: { authorization: `Bearer ${session.credential}` },
      cache: "no-store",
      signal: requestSignal(),
    },
  );
  if (!response.ok) throw new ConsoleAccessError("api-refused", "The Artifact download failed.");
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.txt";
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
};

const workflowMutation = async <A>(
  projectId: string,
  workflowName: string,
  action: "start" | "stop",
  payload?: JsonValue,
  force = false,
): Promise<A> => {
  const bootstrap = await compatibility();
  const reviewed =
    action === "start"
      ? (await readWorkflows(projectId)).workflows.find(
          (workflow) => workflow.projectId === projectId && workflow.workflowName === workflowName,
        )
      : undefined;
  if (action === "start" && reviewed?.currentRevisionId === undefined)
    throw new ConsoleAccessError(
      "api-refused",
      "The selected Workflow has no current reviewed revision.",
    );
  const requestId = crypto.randomUUID();
  return prepareAndMutate<A>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/actions/${action}`,
    {
      mutationVersion: 1,
      requestId,
      dataIdentity: bootstrap.dataIdentity,
      operation: `${action}Workflow`,
      target: { identityVersion: 1, kind: "workflow", parts: [projectId, workflowName] },
      arguments: { ...(payload === undefined ? {} : { payload }), ...(force ? { force } : {}) },
      preconditions:
        action === "start" && reviewed !== undefined
          ? {
              mode: reviewed.trigger.state === "not-declared" ? "no-trigger" : "trigger",
              revisionId: reviewed.currentRevisionId as string,
            }
          : {},
    },
  );
};

export const startTriggerWorkflow = (
  projectId: string,
  workflowName: string,
): Promise<StartTriggerWorkflowResult> => workflowMutation(projectId, workflowName, "start");

export const startManualWorkflow = (
  projectId: string,
  workflowName: string,
  payload: JsonValue,
): Promise<{ readonly runId: string }> =>
  workflowMutation(projectId, workflowName, "start", payload);

export const stopWorkflow = (
  projectId: string,
  workflowName: string,
): Promise<StopWorkflowResult> => workflowMutation(projectId, workflowName, "stop");

export const forceStopWorkflow = (
  projectId: string,
  workflowName: string,
): Promise<StopWorkflowResult> =>
  workflowMutation(projectId, workflowName, "stop", undefined, true);

export const cancelRun = async (runId: string): Promise<CancelRunResult> => {
  const bootstrap = await compatibility();
  const requestId = crypto.randomUUID();
  return prepareAndMutate<CancelRunResult>(
    `/api/v1/runs/${encodeURIComponent(runId)}/actions/cancel`,
    {
      mutationVersion: 1,
      requestId,
      dataIdentity: bootstrap.dataIdentity,
      operation: "cancelRun",
      target: { identityVersion: 1, kind: "run", parts: [runId] },
      arguments: {},
      preconditions: {},
    },
  );
};

export const retryUncertainAction = async (options: {
  readonly runId: string;
  readonly actionId: string;
  readonly reason: string;
  readonly possibleDuplicationAcknowledged: true;
}): Promise<RetryUncertainActionResult> => {
  const bootstrap = await compatibility();
  const requestId = crypto.randomUUID();
  return prepareAndMutate<RetryUncertainActionResult>(
    `/api/v1/runs/${encodeURIComponent(options.runId)}/actions/retry-uncertain`,
    {
      mutationVersion: 1,
      requestId,
      dataIdentity: bootstrap.dataIdentity,
      operation: "retryUncertainAction",
      target: { identityVersion: 1, kind: "runAction", parts: [options.runId, options.actionId] },
      arguments: { reason: options.reason },
      preconditions: { possibleDuplicationAcknowledged: true },
    },
  );
};

export const readAskings = (): Promise<AskingSnapshot> =>
  authorizedRead<AskingSnapshot>("/api/v1/askings");

/** The Console omits Answerer. The Daemon records the current OS user. */
export const recordGateVerdict = (
  request: Omit<RecordVerdictRequest, "answerer">,
): Promise<RecordVerdictResult> =>
  prepareAndMutate<RecordVerdictResult>("/api/v1/gate-answers", {
    mutationVersion: 1,
    requestId: request.requestId,
    dataIdentity: request.dataIdentity,
    operation: "recordGateVerdict",
    target: { identityVersion: 1, kind: "gate", parts: [request.requestId] },
    arguments: { token: request.token, choice: request.choice, reason: request.reason },
    preconditions: {},
  });
