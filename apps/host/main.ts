#!/usr/bin/env bun

import { startLiveKojoHost } from "./src/composition/live";

if (import.meta.main) {
  const server = await startLiveKojoHost();
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => undefined);
}
