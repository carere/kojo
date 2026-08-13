#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

/**
 * Holds the write lock on a file that is **not** in WAL mode, from another process.
 *
 * The sibling of `holdWriteLock`, and the difference is the whole point. That one opens the file
 * through Kojo's own client, so the file is already WAL by the time the lock is taken and a second
 * client's `journal_mode = WAL` is a no-op. This one leaves the file on its rollback journal, so a
 * client that opens it next **must** change the journal mode — which needs the exclusive lock this
 * process is holding.
 *
 * That is the one moment the driver's own ordering costs a process its life: it asks for WAL with a
 * bare `db.run` before any busy timeout is set, and does not catch what that throws.
 *
 * No Effect and no Kojo layer here, deliberately: the subject under test is what a client does when
 * it opens a locked file, so the thing holding the lock must not be that client.
 */
const [database, marker, millis] = process.argv.slice(2);

const db = new Database(database ?? "", { create: true });
db.run("PRAGMA journal_mode = DELETE");
db.run("create table if not exists held (id integer primary key, note text)");

db.run("begin immediate");
db.run("insert into held (note) values ('holder')");

// The marker is written after the insert, which is what actually takes the lock, so a test that
// sees the marker knows the lock is held rather than merely asked for.
writeFileSync(marker ?? "", "held");

await Bun.sleep(Number(millis ?? "400"));
db.run("commit");
db.close();
