import { join } from "node:path";
import { decodeProjectRuntimeResult } from "./project-runtime";
import {
  activateStoredProjectSource,
  freezeCheckoutSource,
  materializeRuntimeSourceCheckout,
  type ProjectSourceRevision,
  ProjectSourceValidationError,
  type RuntimeSourceCheckout,
  validatePinnedProjectSource,
} from "./project-source";
import type { SystemStore } from "./storage";
import {
  type PreparedWorkflowRun,
  type WorkflowRuntimeAdapter,
  WorkflowStartError,
} from "./workflow-runs";

interface RuntimeResult {
  readonly encodedInput?: unknown;
  readonly error?: string;
  readonly recoveryTags?: ReadonlyArray<string>;
  readonly state?: "Completed" | "Discarded" | "Failed" | "Suspended";
  readonly status?: "failed" | "validated";
  readonly value?: unknown;
}

const projectLocalCli = async (checkout: string) => {
  const candidates = [
    join(checkout, "node_modules", "@kojo", "cli", "main.ts"),
    join(checkout, "apps", "cli", "main.ts"),
  ];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new WorkflowStartError(
    "INVALID_CONFIGURATION",
    "The immutable runtime source does not contain its project-local Kojo CLI",
  );
};

const invokeRuntime = async (
  checkout: string,
  configPath: string,
  request: {
    readonly attempt?: number;
    readonly endpoint?: string;
    readonly input: unknown;
    readonly leaseGeneration?: number;
    readonly leaseHolder?: string;
    readonly mode: "execute" | "validate";
    readonly projectId?: string;
    readonly recoveryFailure?: unknown;
    readonly rootRunId?: string;
    readonly runId?: string;
    readonly workflowName: string;
  },
) => {
  const cli = await projectLocalCli(checkout);
  const encodedRequest = Buffer.from(JSON.stringify({ configPath, ...request })).toString(
    "base64url",
  );
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "KOJO_HOME" && name !== "KOJO_INTERNAL_SYSTEM",
    ),
  );
  const child = Bun.spawn([process.execPath, "run", cli], {
    cwd: checkout,
    env: {
      ...runtimeEnvironment,
      KOJO_INTERNAL_PROJECT_RUNTIME: "1",
      KOJO_RUNTIME_REQUEST: encodedRequest,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  let result: RuntimeResult;
  try {
    result = decodeProjectRuntimeResult(stdout) as RuntimeResult;
  } catch (error) {
    throw new WorkflowStartError(
      "RUNTIME_START_FAILED",
      stderr.trim() || (error instanceof Error ? error.message : String(error)),
    );
  }
  if (exitCode !== 0 || result.status === "failed") {
    const message = result.error ?? (stderr.trim() || "Project Runtime Process failed");
    throw new WorkflowStartError(
      message.includes("was not found") ? "WORKFLOW_NOT_FOUND" : "INVALID_INPUT",
      message,
    );
  }
  return result;
};

const prepareRevision = async (
  store: SystemStore,
  project: NonNullable<ReturnType<SystemStore["projects"]["findById"]>>,
  fromCheckout: boolean,
) => {
  if (fromCheckout) {
    const frozen = await freezeCheckoutSource(project.path);
    return {
      checkout: frozen.checkout,
      revision: frozen.revision,
      source: frozen.source,
    };
  }
  const policy =
    store.projectSources.findByProjectId(project.id)?.sourcePolicy ?? "LocalWithFreshnessWarning";
  const revision = await activateStoredProjectSource(store, project.id, {
    policy,
    repository: project.path,
  });
  const checkout = await materializeRuntimeSourceCheckout(project.path, revision, {
    installDependencies: true,
  });
  return {
    checkout,
    revision,
    source: {
      commit: revision.commit,
      defaultBranch: revision.provenance.defaultBranch,
      dirty: false,
      kind: "ProjectSourceRevision" as const,
      policy: revision.policy,
      remote: revision.provenance.remote,
    },
  };
};

export const makeProjectWorkflowRuntime = (
  store: SystemStore,
  endpoint: string,
): WorkflowRuntimeAdapter => ({
  prepare: async (request): Promise<PreparedWorkflowRun> => {
    const project = store.projects.findById(request.projectId);
    if (project === undefined) {
      throw new WorkflowStartError(
        "PROJECT_NOT_FOUND",
        `Project ${request.projectId} was not found`,
      );
    }
    if (project.registrationState !== "Enabled") {
      throw new WorkflowStartError(
        "PROJECT_UNAVAILABLE",
        `Project ${request.projectId} must be Enabled before starting a root Workflow Run`,
      );
    }

    let prepared:
      | {
          readonly checkout: RuntimeSourceCheckout;
          readonly revision: ProjectSourceRevision;
          readonly source: PreparedWorkflowRun["revision"]["source"];
        }
      | undefined;
    try {
      prepared = await prepareRevision(store, project, request.fromCheckout);
      const workflow = prepared.revision.workflows.find(
        (candidate) => candidate.name === request.workflowName,
      );
      if (workflow === undefined) {
        throw new WorkflowStartError(
          "WORKFLOW_NOT_FOUND",
          `Developer Workflow '${request.workflowName}' was not found`,
        );
      }
      const validation = await invokeRuntime(prepared.checkout.path, prepared.revision.configPath, {
        input: request.input,
        mode: "validate",
        workflowName: request.workflowName,
      });
      const fixed = prepared;
      return {
        encodedInput: validation.encodedInput,
        execute: async ({ attempt, leaseGeneration, leaseHolder, projectId, rootRunId, runId }) => {
          try {
            const result = await invokeRuntime(fixed.checkout.path, fixed.revision.configPath, {
              attempt,
              endpoint,
              input: validation.encodedInput,
              leaseGeneration,
              leaseHolder,
              mode: "execute",
              projectId,
              rootRunId,
              runId,
              workflowName: request.workflowName,
            });
            if (
              result.state !== "Completed" &&
              result.state !== "Discarded" &&
              result.state !== "Failed" &&
              result.state !== "Suspended"
            ) {
              throw new Error("Project Runtime Process returned no terminal outcome");
            }
            return { state: result.state, value: result.value };
          } finally {
            await fixed.checkout.dispose();
          }
        },
        revision: {
          declaredVersion: workflow.version,
          fingerprint: workflow.fingerprint,
          source: fixed.source,
          stableName: workflow.name,
          workflowAbi: fixed.revision.toolchain.workflowAbi,
        },
        revisionSnapshot: {
          rootWorkflow: workflow.name,
          source: fixed.source,
          workflows: fixed.revision.workflows.map((candidate) => ({
            declaredVersion: candidate.version,
            fingerprint: candidate.fingerprint,
            stableName: candidate.name,
            workflowAbi: fixed.revision.toolchain.workflowAbi,
          })),
        },
      };
    } catch (error) {
      await prepared?.checkout.dispose().catch(() => undefined);
      if (error instanceof WorkflowStartError) throw error;
      if (error instanceof ProjectSourceValidationError) {
        throw new WorkflowStartError(
          "INVALID_CONFIGURATION",
          "The candidate Project Source Revision is invalid",
          error.diagnostics,
        );
      }
      throw new WorkflowStartError(
        "RUNTIME_START_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  prepareResume: async (request) => {
    const project = store.projects.findById(request.projectId);
    if (project === undefined) {
      throw new WorkflowStartError(
        "PROJECT_NOT_FOUND",
        `Project ${request.projectId} was not found`,
      );
    }
    if (project.registrationState !== "Enabled") {
      throw new WorkflowStartError(
        "PROJECT_UNAVAILABLE",
        `Project ${request.projectId} must be Enabled before resuming a Workflow Run`,
      );
    }
    if (request.revision.source.kind !== "ProjectSourceRevision") {
      throw new WorkflowStartError(
        "WORKFLOW_INCOMPATIBLE",
        "The temporary Checkout Source Snapshot required by this Workflow Run is no longer retained",
      );
    }

    let prepared:
      | {
          readonly checkout: RuntimeSourceCheckout;
          readonly revision: ProjectSourceRevision;
          readonly source: PreparedWorkflowRun["revision"]["source"];
        }
      | undefined;
    try {
      const policy = request.revision.source.policy;
      if (policy !== "LocalWithFreshnessWarning" && policy !== "RemoteLatest") {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          "The pinned Workflow Revision has no reproducible Project Source Policy",
        );
      }
      const revision = await validatePinnedProjectSource({
        commit: request.revision.source.commit,
        defaultBranch:
          typeof request.revision.source.defaultBranch === "string"
            ? request.revision.source.defaultBranch
            : undefined,
        policy,
        remote:
          typeof request.revision.source.remote === "string" ||
          request.revision.source.remote === null
            ? request.revision.source.remote
            : undefined,
        repository: project.path,
      });
      prepared = {
        checkout: await materializeRuntimeSourceCheckout(project.path, revision, {
          installDependencies: true,
        }),
        revision,
        source: request.revision.source,
      };
      const workflow = prepared.revision.workflows.find(
        (candidate) => candidate.name === request.revision.stableName,
      );
      const availableSnapshot = {
        rootWorkflow: request.revisionSnapshot.rootWorkflow,
        source: prepared.source,
        workflows: prepared.revision.workflows.map((candidate) => ({
          declaredVersion: candidate.version,
          fingerprint: candidate.fingerprint,
          stableName: candidate.name,
          workflowAbi: prepared?.revision.toolchain.workflowAbi ?? "",
        })),
      };
      if (
        workflow === undefined ||
        workflow.version !== request.revision.declaredVersion ||
        workflow.fingerprint !== request.revision.fingerprint ||
        prepared.revision.toolchain.workflowAbi !== request.revision.workflowAbi ||
        JSON.stringify(availableSnapshot) !== JSON.stringify(request.revisionSnapshot)
      ) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          "The current Workflow Revision does not exactly match the pinned Workflow Revision Snapshot",
        );
      }
      const validation = await invokeRuntime(prepared.checkout.path, prepared.revision.configPath, {
        input: request.input,
        mode: "validate",
        workflowName: request.revision.stableName,
      });
      const failureTag =
        request.state === "Failed" &&
        typeof request.outcome === "object" &&
        request.outcome !== null &&
        "_tag" in request.outcome &&
        typeof request.outcome._tag === "string"
          ? request.outcome._tag
          : undefined;
      if (
        request.state === "Failed" &&
        (failureTag === undefined ||
          failureTag === "Defect" ||
          validation.recoveryTags?.includes(failureTag) !== true)
      ) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          "The Failed Workflow Run has no stable-tagged Recovery Handler",
        );
      }
      const fixed = prepared;
      return {
        execute: async ({ attempt, leaseGeneration, leaseHolder, projectId, rootRunId, runId }) => {
          try {
            const result = await invokeRuntime(fixed.checkout.path, fixed.revision.configPath, {
              attempt,
              endpoint,
              input: validation.encodedInput,
              leaseGeneration,
              leaseHolder,
              mode: "execute",
              projectId,
              ...(request.state === "Failed" ? { recoveryFailure: request.outcome } : {}),
              rootRunId,
              runId,
              workflowName: request.revision.stableName,
            });
            if (
              result.state !== "Completed" &&
              result.state !== "Discarded" &&
              result.state !== "Failed" &&
              result.state !== "Suspended"
            ) {
              throw new Error("Project Runtime Process returned no outcome");
            }
            return { state: result.state, value: result.value };
          } finally {
            await fixed.checkout.dispose();
          }
        },
        leaseAvailability: "Available" as const,
        recoveryPolicy:
          request.state === "Failed" ? ("Available" as const) : ("NotRequired" as const),
        revisionCompatibility: "Compatible" as const,
        runtimeConfigurationCompatibility: "Compatible" as const,
        sourceAvailability: "Available" as const,
      };
    } catch (error) {
      await prepared?.checkout.dispose().catch(() => undefined);
      if (error instanceof WorkflowStartError) throw error;
      if (error instanceof ProjectSourceValidationError) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          "The pinned Project source is unavailable or invalid",
          error.diagnostics,
        );
      }
      throw new WorkflowStartError(
        "RUNTIME_START_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});
