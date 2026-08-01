import { readFileSync } from "node:fs";
import { Context, Layer } from "effect";

export interface DeletionClockShape {
  readonly now: () => number;
}

export class DeletionClock extends Context.Service<DeletionClock, DeletionClockShape>()(
  "kojo/host/DeletionClock",
) {}

export const DeletionClockLive = Layer.succeed(DeletionClock, {
  now: () => {
    const path = process.env.KOJO_TEST_DELETION_CLOCK_FILE;
    if (path !== undefined) {
      try {
        const value = Number(readFileSync(path, "utf8").trim());
        if (Number.isFinite(value)) return value;
      } catch {
        // Test-only clock files are optional; the Host always has a live clock.
      }
    }
    return Date.now();
  },
});
