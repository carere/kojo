import { Effect } from "effect";

export const getHealth = Effect.succeed({
  service: "visualizer" as const,
  status: "ok" as const,
});
