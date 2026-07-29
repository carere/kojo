import { defaultSocketPath } from "@kojo/control/local-client";
import { startKojoHost } from "../contexts/workflow-execution/control/services/local-host";

export const startLiveKojoHost = () =>
  startKojoHost({ socketPath: process.env.KOJO_HOST_SOCKET ?? defaultSocketPath() });
