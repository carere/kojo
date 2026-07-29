import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { defaultSocketPath } from "@kojo/control/local-client";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeHostDiagnosticLoggerLayer } from "../contexts/shared/services/host-diagnostic-logger";
import {
  makeKojoControlServerLayer,
  startKojoHost,
} from "../contexts/workflow-execution/control/services/local-host";

export const startLiveKojoHost = () => {
  const socketPath = process.env.KOJO_HOST_SOCKET ?? defaultSocketPath();
  const diagnosticPath = join(dirname(socketPath), "diagnostics.jsonl");
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    `host:${createHash("sha256")
      .update(`${hostname()}:${process.getuid?.() ?? 0}`)
      .digest("hex")}`,
  );

  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};
