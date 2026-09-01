import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type { ProjectSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type {
  RunDocument,
  RunSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { WorkflowSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";

interface StoredSession {
  readonly credential: string;
  readonly expiresAt: string;
  readonly instanceId: string;
}

const storageKey = "kojo.browser-session.v1";

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

const authorizedRead = async <A>(path: string): Promise<A> => {
  const session = await currentAccess();
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.credential}`,
    },
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) {
    window.sessionStorage.removeItem(storageKey);
    access = undefined;
    throw new ConsoleAccessError("access-required", "Run `kojo ui` again to open this Console.");
  }
  if (!response.ok) throw new ConsoleAccessError("api-refused", "The Daemon API refused the read.");
  return (await response.json()) as A;
};

export const readDaemon = (): Promise<DaemonDocument> =>
  authorizedRead<DaemonDocument>("/api/v1/daemon");

export const readProjects = (): Promise<ProjectSnapshot> =>
  authorizedRead<ProjectSnapshot>("/api/v1/projects");

export const readWorkflows = (projectId?: string): Promise<WorkflowSnapshot> =>
  authorizedRead<WorkflowSnapshot>(
    projectId === undefined
      ? "/api/v1/workflows"
      : `/api/v1/projects/${encodeURIComponent(projectId)}/workflows`,
  );

export const readRuns = (): Promise<RunSnapshot> => authorizedRead<RunSnapshot>("/api/v1/runs");

export const readRun = (runId: string): Promise<RunDocument> =>
  authorizedRead<RunDocument>(`/api/v1/runs/${encodeURIComponent(runId)}`);
