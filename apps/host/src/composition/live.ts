import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { defaultSocketPath } from "@kojo/control/local-client";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeFileProjectIndexRepositoryLayer } from "../contexts/workflow-authoring/projects/repositories/file-project-index-repository";
import { GitProjectLayoutLive } from "../contexts/workflow-authoring/projects/services/git-project-layout";
import { SubprocessProjectDefinitionLoaderLive } from "../contexts/workflow-authoring/projects/services/subprocess-project-definition-loader";
import { loadHostIdentity } from "../contexts/workflow-execution/control/repositories/host-identity-repository";
import { makeHostDiagnosticLoggerLayer } from "../contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  makeKojoControlServerLayer,
  startKojoHost,
} from "../contexts/workflow-execution/control/services/local-host";
import {
  DrizzleProjectRepositoryLive,
  DrizzleWorkflowRunRepositoryLive,
  DrizzleWorkflowScheduleRepositoryLive,
} from "../contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { makeLocalWorkflowBackendLayer } from "../contexts/workflow-execution/projects/services/local-workflow-backend";
import { ProjectRuntimeLive } from "../contexts/workflow-execution/projects/services/project-runtime";
import { ScheduleClockLive } from "../contexts/workflow-execution/schedules/services/schedule-clock";
import { WorkflowScheduleSupervisorLive } from "../contexts/workflow-execution/schedules/services/workflow-schedule-supervisor";

export const startLiveKojoHost = async () => {
  const socketPath = process.env.KOJO_HOST_SOCKET ?? defaultSocketPath();
  const hostStorePath = process.env.KOJO_HOST_STORE ?? join(homedir(), ".kojo", "host");
  const diagnosticPath = join(hostStorePath, "diagnostics.jsonl");
  const projectIndex = makeFileProjectIndexRepositoryLayer(join(hostStorePath, "projects.json"));
  const projectLayout = GitProjectLayoutLive.pipe(
    Layer.provide(SubprocessProjectDefinitionLoaderLive),
  );
  const hostIdentity = await loadHostIdentity(join(hostStorePath, "identity"));
  const diagnostics = makeHostDiagnosticLoggerLayer({ path: diagnosticPath, hostIdentity });
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const workflowBackend = makeLocalWorkflowBackendLayer(hostIdentity);
  const projectRuntime = ProjectRuntimeLive.pipe(
    Layer.provide([DrizzleProjectRepositoryLive, workflowBackend, diagnostics]),
  );
  const runtimeDependencies = Layer.mergeAll(
    projectIndex,
    projectLayout,
    DrizzleWorkflowRunRepositoryLive,
    DrizzleWorkflowScheduleRepositoryLive,
    ScheduleClockLive,
    workflowBackend,
    projectRuntime,
  );
  const scheduleSupervisor = WorkflowScheduleSupervisorLive.pipe(
    Layer.provide(runtimeDependencies),
  );
  const serverLayer = makeKojoControlServerLayer(protocol, diagnostics, hostIdentity).pipe(
    Layer.provide(Layer.merge(runtimeDependencies, scheduleSupervisor)),
  ) as Layer.Layer<never, unknown>;

  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};
