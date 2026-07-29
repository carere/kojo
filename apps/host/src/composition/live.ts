import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { defaultSocketPath } from "@kojo/control/local-client";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { DrizzleProjectStoreLive } from "../adapters/projects/drizzle-project-store";
import { makeFileProjectIndexStoreLayer } from "../adapters/projects/file-project-index-store";
import { GitProjectLayoutLive } from "../adapters/projects/git-project-layout";
import { SubprocessProjectDefinitionLoaderLive } from "../adapters/projects/subprocess-project-definition-loader";
import { makeHostDiagnosticLoggerLayer } from "../contexts/workflow-execution/control/services/host-diagnostic-logger";
import { loadHostIdentity } from "../contexts/workflow-execution/control/services/host-identity-store";
import {
  makeKojoControlServerLayer,
  startKojoHost,
} from "../contexts/workflow-execution/control/services/local-host";
import { ProjectRuntimeLive } from "../contexts/workflow-execution/projects/services/project-runtime";

export const startLiveKojoHost = async () => {
  const socketPath = process.env.KOJO_HOST_SOCKET ?? defaultSocketPath();
  const hostStorePath = process.env.KOJO_HOST_STORE ?? join(homedir(), ".kojo", "host");
  const diagnosticPath = join(hostStorePath, "diagnostics.jsonl");
  const projectIndex = makeFileProjectIndexStoreLayer(join(hostStorePath, "projects.json"));
  const projectLayout = GitProjectLayoutLive.pipe(
    Layer.provide(SubprocessProjectDefinitionLoaderLive),
  );
  const hostIdentity = await loadHostIdentity(join(hostStorePath, "identity"));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    hostIdentity,
  ).pipe(
    Layer.provide([
      projectIndex,
      projectLayout,
      ProjectRuntimeLive.pipe(Layer.provide(DrizzleProjectStoreLive)),
    ]),
  );

  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};
