#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { lockOf, readyMarkOf } from "../../src/contexts/shared/adapters/SqliteDatabase.ts";

/**
 * Holds the first-run lock from another process, and reports what it saw while it held it.
 *
 * Raw `bun:sqlite`, no Effect and no Kojo client, for the same reason `holdRollbackLock` is: the
 * subject under test is what Kojo does when the lock is already taken, so the thing taking it must
 * not be that code. `lockOf` and `readyMarkOf` are imported all the same — they are string functions
 * with no SQL in them, and holding or marking a *different* file would make a test that passes while
 * doing nothing.
 *
 * **The sighting is the real assertion.** SQLite's busy handler sleeps the calling thread, so a test
 * process waiting for this lock cannot run a timer and look at the directory halfway through. This
 * process can: it is inside the window by definition. What it writes is whether the database
 * existed while the lock was held — and `nothing` is the whole claim of the guard, seen from the
 * one place it can be seen.
 *
 * With `ready` as its fourth argument it also *finishes* a first run before it lets go: it makes the
 * database and writes the mark, exactly as `firstRun` does, so the process that was waiting wakes to
 * a file somebody else has already readied. That is the only way to reach the second `ready` check
 * on purpose rather than by luck.
 */
const [database, marker, millis, ready] = process.argv.slice(2);

const lock = new Database(lockOf(database ?? ""), { create: true });
lock.run("PRAGMA busy_timeout = 30000");
lock.run("begin exclusive");

// Written after the transaction has the lock, so a test that sees the marker knows the lock is held
// rather than merely asked for.
writeFileSync(marker ?? "", "held");

await Bun.sleep(Number(millis ?? "400"));

writeFileSync(`${marker}.sighted`, existsSync(database ?? "") ? "database" : "nothing");

if (ready === "ready") {
  const readied = new Database(database ?? "", { create: true });
  readied.run("create table if not exists readied_by_the_holder (note text)");
  readied.close();
  // Last, like `firstRun` writes it: the mark is only true after the schema is there.
  writeFileSync(readyMarkOf(database ?? ""), "readied by the holder\n");
}

lock.run("commit");
lock.close();
