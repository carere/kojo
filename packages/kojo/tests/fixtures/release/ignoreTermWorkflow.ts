export {};

process.on("SIGTERM", () => undefined);

await Bun.sleep(60_000);
