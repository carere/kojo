import type { Stop } from "../contexts/workflow/services/stopped.ts";
import { humanMillis } from "./gateTable.ts";

/**
 * Where a run came to rest, in the words a person needs.
 *
 * **A suspended run is a success, not a hang.** The line says which gate it stopped at, who owes an
 * answer, how long they have, and the token that answers it — because everything a reader has to go
 * and look up somewhere else is a reason the run sits unanswered for another day.
 *
 * `unsettled` is deliberately not phrased as a failure of the run. It is the *watcher* giving up,
 * and the run is durable: it carries on with nobody looking at it.
 */
export const describeStop = (stop: Stop, now: number): string => {
  switch (stop._tag) {
    case "suspended": {
      const request = stop.gate.request;
      const left = stop.gate.remainingMillis(now);
      const deadline =
        left < 0 ? `${humanMillis(-left)} past the deadline` : `${humanMillis(left)} left`;
      return [
        `suspended at gate "${request.gate}" — waiting on ${request.actor}, ${deadline}`,
        `  kojo gate answer ${request.token} --choice ${request.choices[0] ?? "approve"} --reason "<why>"`,
      ].join("\n");
    }
    case "finished":
      return `run ${stop.status}`;
    case "unsettled":
      return `still ${stop.status} when this command stopped watching. The run carries on without it.`;
  }
};
