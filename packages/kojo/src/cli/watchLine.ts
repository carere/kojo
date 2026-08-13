import { Duration } from "effect";
import type { WatchNotice } from "../contexts/trigger/models/WatchNotice.ts";
import {
  live,
  type RunnerRegistration,
  staleAfter,
} from "../contexts/workflow/models/RunnerRegistration.ts";
import { humanMillis } from "./gateTable.ts";
import { describeStop } from "./stopLine.ts";

/** The command that answers an asking, printed in full because it is the reader's next step. */
const answerWith = (token: string, choices: ReadonlyArray<string>): string =>
  `  kojo gate answer ${token} --choice ${choices[0] ?? "approve"} --reason "<why>"`;

/**
 * One line of a watcher's day.
 *
 * The suspension line is `describeStop`'s, deliberately: a person reading a watcher's output and a
 * person reading `kojo run` should not have to learn two ways of being told the same thing. What is
 * added here is the run id, because a watcher is talking about many runs and a command is talking
 * about one.
 */
export const describeNotice = (notice: WatchNotice, now: number): string => {
  switch (notice._tag) {
    case "started":
      return `${notice.source} ${notice.key} → run ${notice.runId}`;

    case "waiting":
      return `run ${notice.gate.request.runId} ${describeStop(
        { _tag: "suspended", gate: notice.gate },
        now,
      )}`;

    case "overdue": {
      const request = notice.gate.request;
      return [
        `OVERDUE run ${request.runId} — gate "${request.gate}" has waited ${humanMillis(
          notice.gate.waitedMillis(now),
        )} on ${request.actor}, ${humanMillis(-notice.gate.remainingMillis(now))} past its deadline`,
        answerWith(request.token, request.choices),
      ].join("\n");
    }

    case "ended":
      return `run ${notice.runId} ${notice.status}`;

    case "refused":
      return (
        `run ${notice.locked.runId} is already being driven by ${notice.locked.holder} — ` +
        "refused rather than raced, and this watcher left it alone"
      );
  }
};

/**
 * Who else is driving runs on this database, read before this process becomes a runner itself.
 *
 * **Read first, or it reads itself.** Every runner under the default sharding configuration
 * registers at the same address, so a watcher that asked after building its engine would find its
 * own row and report itself as company.
 *
 * It warns and does not refuse. Two runners on one file contend for the same shard locks, which is
 * worth saying out loud — but `kojo run` and `kojo gate answer` are runners too, for the seconds
 * they live, and a daemon that refused to start because somebody was answering a gate would be
 * wrong far more often than it was right.
 */
export const describeRunners = (registrations: ReadonlyArray<RunnerRegistration>): string => {
  const running = live(registrations);
  if (running.length > 0) {
    return running
      .map(
        (registration) =>
          `warning: a runner is already registered at ${registration.address} ` +
          `(heartbeat ${humanMillis(registration.heartbeatAgeMillis)} ago). ` +
          "Two runners on one database contend for the same shard locks.",
      )
      .join("\n");
  }

  // A stale row is a runner that died rather than one that stopped, and saying so is the whole
  // difference between the two. It clears itself, so this is a note and not a problem to solve.
  const stale = registrations.filter((registration) => !registration.isLive());
  if (stale.length > 0) {
    return stale
      .map(
        (registration) =>
          `note: a runner at ${registration.address} stopped answering ` +
          `${humanMillis(registration.heartbeatAgeMillis)} ago; its registration is stale and ` +
          `ages out ${Duration.toSeconds(staleAfter)} seconds after its last heartbeat.`,
      )
      .join("\n");
  }

  // Sharding unregisters on graceful shutdown, so an empty table is a factory at rest.
  return "no runner is registered on this database";
};
