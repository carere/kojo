import { HostOverview as HostOverviewSchema } from "@kojo/control";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Health = Rpc.make("Health", {
  success: Schema.Struct({
    service: Schema.Literal("visualizer"),
    status: Schema.Literal("ok"),
  }),
});

export const HostOverview = Rpc.make("HostOverview", {
  success: HostOverviewSchema,
});

export const VisualizerApi = RpcGroup.make(Health, HostOverview);
