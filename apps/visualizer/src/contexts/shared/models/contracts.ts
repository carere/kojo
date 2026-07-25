import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Health = Rpc.make("Health", {
  success: Schema.Struct({
    service: Schema.Literal("visualizer"),
    status: Schema.Literal("ok"),
  }),
});

export const VisualizerApi = RpcGroup.make(Health);
