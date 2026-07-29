import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { defaultSocketPath } from "@kojo/control/local-client";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeFileProjectIndexStoreLayer } from "../contexts/workflow-authoring/projects/adapters/file-project-index-store";
import { GitProjectLayoutLive } from "../contexts/workflow-authoring/projects/adapters/git-project-layout";
import { makeHostDiagnosticLoggerLayer } from "../contexts/workflow-execution/control/services/host-diagnostic-logger";
import { loadHostIdentity } from "../contexts/workflow-execution/control/services/host-identity-store";
import {
  makeKojoControlServerLayer,
  startKojoHost,
} from "../contexts/workflow-execution/control/services/local-host";

export const startLiveKojoHost = async () => {
  const socketPath = process.env.KOJO_HOST_SOCKET ?? defaultSocketPath();
  const hostStorePath = process.env.KOJO_HOST_STORE ?? join(homedir(), ".kojo", "host");
  const diagnosticPath = join(hostStorePath, "diagnostics.jsonl");
  const projectIndex = makeFileProjectIndexStoreLayer(join(hostStorePath, "projects.json"));
  const hostIdentity = await loadHostIdentity(join(hostStorePath, "identity"));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    hostIdentity,
  ).pipe(Layer.provide([projectIndex, GitProjectLayoutLive]));

  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};
