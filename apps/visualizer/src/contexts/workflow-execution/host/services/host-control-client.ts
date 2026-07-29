import type { HostOverview } from "@kojo/control";
import {
  defaultSocketPath,
  type IncompatibleProtocolError,
  type LocalTransportError,
  makeDefaultLocalClient,
} from "@kojo/control/local-client";
import { Context, Effect, Layer } from "effect";

export interface HostControlClientShape {
  readonly getHostOverview: Effect.Effect<
    HostOverview,
    LocalTransportError | IncompatibleProtocolError
  >;
}

export class HostControlClient extends Context.Service<HostControlClient, HostControlClientShape>()(
  "kojo/visualizer/HostControlClient",
) {}

export const HostControlClientLive = Layer.succeed(HostControlClient, {
  getHostOverview: Effect.suspend(
    () =>
      makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath()).getHostOverview,
  ),
});
