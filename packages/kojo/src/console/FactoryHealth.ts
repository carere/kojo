import { Schema } from "effect";
import { live, type RunnerRegistration } from "../contexts/workflow/models/RunnerRegistration.ts";

/**
 * Is there a factory on this path at all?
 *
 * A repository with no `.kojo/…db` is the ordinary state of a repository nobody has run `kojo init`
 * in, and console.md §10 says what that must look like: a message, not an error page. So it is a
 * state the health document reports rather than a failure the Console meets on its first request.
 */
export const FactoryPresence = Schema.Literals(["present", "absent"]);
export type FactoryPresence = typeof FactoryPresence.Type;

/**
 * The trace schema on disk, against the one this build of Kojo knows.
 *
 * **The asymmetry is the point** (console.md §10). A file migrated *further* than this Console is
 * fine and stays silent, because the migrations are additive and a column this build does not select
 * cannot hurt it. A file migrated *less* far is the dangerous direction — this build's reader selects
 * a table or a column that is not there — and it is said loudly.
 */
export const SchemaStanding = Schema.Literals([
  /** The file has every migration this build has, and no more. */
  "current",
  /** The file has been migrated further than this build. Additive, so it is ignored in silence. */
  "newer",
  /** The file is behind this build. The reader may ask for something that is not there. */
  "older",
  /** No ledger at all: nothing has ever migrated this file. */
  "unwritten",
]);
export type SchemaStanding = typeof SchemaStanding.Type;

/**
 * Is anybody able to apply an answer right now?
 *
 * Read from `cluster_runners.last_heartbeat` with its thirty-five second window, and **never** from
 * `RunnerHealth`, whose noop reports every address alive — the *"approved ✓ that means nothing"*
 * adr/gate/0001 exists to prevent. No rows is `none`, which is the normal idle state of a factory
 * whose watcher was stopped cleanly.
 */
export const RunnerPresence = Schema.Literals(["live", "none"]);
export type RunnerPresence = typeof RunnerPresence.Type;

/**
 * What `GET /api/health` answers: where this Console is reading, what it is, and whether an answer
 * given now would move a run.
 *
 * Every field is something a person cannot get any other way from a browser. The database path
 * because one Console serves one factory and the whole page is meaningless if it is the wrong file;
 * the versions because a Console and the factory under it are upgraded separately; and the runner
 * because a gate card must say *recorded* rather than *applied* when nothing is running.
 */
export class FactoryHealth extends Schema.Class<FactoryHealth>("FactoryHealth")({
  /** The SQLite file this Console reads, exactly as the command was given it. */
  database: Schema.String,
  factory: FactoryPresence,
  /** The version of Kojo serving this Console. */
  version: Schema.String,
  /** The commit it was built from — `development` from a working tree, which is true. */
  commit: Schema.String,
  schema: SchemaStanding,
  /** The highest migration the file has applied. Zero when no ledger has ever been written. */
  schemaApplied: Schema.Finite,
  /** The highest migration this build has. */
  schemaExpected: Schema.Finite,
  runner: RunnerPresence,
  /**
   * What to put in front of a person, when there is something to say.
   *
   * Absent on a healthy factory, so the Console has nothing to decide: a notice is present exactly
   * when a banner belongs on screen.
   */
  notice: Schema.optionalKey(Schema.String),
}) {}

/** Where the file stands against this build. `unwritten` is separated out because it is not a fault. */
export const standingOf = (applied: number, expected: number): SchemaStanding => {
  if (applied === 0) return "unwritten";
  if (applied < expected) return "older";
  return applied > expected ? "newer" : "current";
};

/**
 * The one line worth interrupting a person with, or nothing.
 *
 * Ordered by which fact makes the others irrelevant: a repository with no factory has no schema
 * worth reporting, and a schema this Console cannot read makes every run on screen suspect.
 */
export const noticeFor = (options: {
  readonly factory: FactoryPresence;
  readonly standing: SchemaStanding;
  readonly applied: number;
  readonly expected: number;
}): string | undefined => {
  if (options.factory === "absent") return "No factory in this repo. Run `kojo init`.";
  if (options.standing === "older") {
    return (
      `This factory's trace schema is older than the Console: the file has migration ${options.applied} ` +
      `and this build expects ${options.expected}. Parts of a run may fail to load until a command ` +
      "that migrates — `kojo run` or `kojo watch` — has been run against it."
    );
  }
  return undefined;
};

/**
 * The whole document from the four things that have to be measured, and nothing else.
 *
 * Pure on purpose: every derived answer here — the standing, the notice, the staleness filter over
 * the registrations — is a rule a test can grade without a database, an HTTP server or a clock.
 */
export const healthOf = (options: {
  readonly database: string;
  readonly factory: FactoryPresence;
  readonly version: string;
  readonly commit: string;
  readonly applied: number;
  readonly expected: number;
  readonly runners: ReadonlyArray<RunnerRegistration>;
}): FactoryHealth => {
  const standing = standingOf(options.applied, options.expected);
  const notice = noticeFor({
    factory: options.factory,
    standing,
    applied: options.applied,
    expected: options.expected,
  });

  return new FactoryHealth({
    database: options.database,
    factory: options.factory,
    version: options.version,
    commit: options.commit,
    schema: standing,
    schemaApplied: options.applied,
    schemaExpected: options.expected,
    runner: live(options.runners).length === 0 ? "none" : "live",
    // **Omitted rather than set to `undefined`, and the difference is visible on the wire.** A key
    // that is never set encodes to nothing; a key set to `undefined` encodes to an explicit `null`.
    // Every other optional field the Console serves — a run's outcome, an asking's verdict — is
    // built the first way, so this one is too, and a consumer has one absence to recognise.
    ...(notice === undefined ? {} : { notice }),
  });
};
