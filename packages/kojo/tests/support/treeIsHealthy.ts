import { Effect, Option } from "effect";
import type { WorkspaceError } from "../../src/contexts/sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../src/contexts/sandbox/ports/Workspace.ts";

/** What the check below reports. Small on purpose: it has to be comparable across two adapters. */
export interface HealthReport {
  readonly kind: "file" | "directory" | "other" | "absent";
  readonly declaresOk: boolean;
  readonly clean: boolean;
}

/** The one answer both adapters must give for the same tree. */
export const healthy: HealthReport = { kind: "file", declaresOk: true, clean: true };

/**
 * One check, written against the port and nothing else.
 *
 * This module is the ticket's proof: the unit test runs it against a seeded object, the
 * integration test runs it against a real git worktree in a temporary directory, and neither
 * touches a character of it. A check that needed two versions would be a check that grades
 * whichever tree is nearest, which is the failure the port exists to remove.
 */
export const treeIsHealthy: Effect.Effect<HealthReport, WorkspaceError, Workspace> = Effect.gen(
  function* () {
    const workspace = yield* Workspace;

    const stat = yield* workspace.stat("src/health.ts");
    const kind = Option.match(stat, {
      onNone: () => "absent" as const,
      onSome: (found) => found.kind,
    });
    const declaresOk = Option.isNone(stat)
      ? false
      : (yield* workspace.read("src/health.ts")).includes("export const ok = true");

    // A non-zero exit is read, not caught: `git status` answering "dirty" is the check's subject.
    const status = yield* workspace.git(["status", "--porcelain"]);

    return { kind, declaresOk, clean: status.succeeded && status.stdout.trim() === "" };
  },
);
