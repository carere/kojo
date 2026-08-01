import { Context, Layer } from "effect";

export interface DeletionClockShape {
  readonly now: () => number;
}

export class DeletionClock extends Context.Service<DeletionClock, DeletionClockShape>()(
  "kojo/host/DeletionClock",
) {}

export const DeletionClockLive = Layer.succeed(DeletionClock, { now: () => Date.now() });
