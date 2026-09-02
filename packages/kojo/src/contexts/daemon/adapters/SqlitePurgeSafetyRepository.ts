import type { Database } from "bun:sqlite";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";
import type {
  PurgeCorrectnessSummary,
  PurgeOwnedScope,
  PurgeResourceRisk,
  PurgeSafetyEvidence,
} from "../models/Purge.ts";
import type { PurgeSafetyRepository } from "../ports/PurgeSafetyRepository.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";
import {
  purgeRecoveryCapsuleAuthorizationPath,
  readPurgeRecoveryCapsule,
} from "./PurgeRecoveryCapsule.ts";

const failure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "PURGE_SAFETY_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, selected) => {
    if (selected === null || typeof selected !== "object" || Array.isArray(selected))
      return selected;
    return Object.fromEntries(
      Object.entries(selected as Record<string, unknown>).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

/** SQLite is read only from this Daemon-owned adapter. The controller only reads its sealed file. */
export class SqlitePurgeSafetyRepository implements PurgeSafetyRepository {
  readonly #database: Database;
  readonly #dataIdentity: string;
  readonly #dataRoot: string;
  readonly #evidencePath: string;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;
  readonly #prepareScope: () => void;

  constructor(
    database: Database,
    dataIdentity: string,
    dataRoot: string,
    configurationRoot: string,
    prepareScope: () => void = () => undefined,
  ) {
    this.#database = database;
    this.#dataIdentity = dataIdentity;
    this.#dataRoot = resolve(dataRoot);
    this.#evidencePath = join(this.#dataRoot, "lifecycle", "purge-safety.json");
    this.#prepareScope = prepareScope;
    const keyName = "purge_safety_ed25519_private_key";
    const existing = database
      .query<{ readonly value: string }, [string]>(
        "SELECT value FROM daemon_metadata WHERE name = ?",
      )
      .get(keyName);
    if (existing === null) {
      const pair = generateKeyPairSync("ed25519");
      const encoded = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
      database.run("INSERT INTO daemon_metadata (name, value) VALUES (?, ?)", [keyName, encoded]);
      this.#privateKey = pair.privateKey;
    } else {
      this.#privateKey = createPrivateKey({
        key: Buffer.from(existing.value, "base64"),
        format: "der",
        type: "pkcs8",
      });
    }
    const publicKey = createPublicKey(this.#privateKey).export({ format: "der", type: "spki" });
    const keyId = new Bun.CryptoHasher("sha256").update(dataIdentity).digest("hex").slice(0, 32);
    const publicKeyPath = join(configurationRoot, "purge-control", "public-keys", `${keyId}.der`);
    if (existsSync(publicKeyPath)) {
      assertPrivateNode(publicKeyPath, "file");
      if (!Buffer.from(readFileSync(publicKeyPath, "utf8"), "base64").equals(publicKey)) {
        throw new LifecycleError(
          "PURGE_SIGNING_IDENTITY_CONFLICT",
          "the offline purge verification key does not match the sole Daemon owner",
        );
      }
    } else {
      atomicPrivateFile(publicKeyPath, publicKey.toString("base64"));
    }
    this.#authorizeRecoveryCapsule();
  }

  #table(name: string): boolean {
    return (
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== null
    );
  }

  #count(table: string): number {
    if (!this.#table(table)) return 0;
    return (
      this.#database
        .query<{ readonly count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()?.count ?? 0
    );
  }

  #correctness(): PurgeCorrectnessSummary {
    const recordsByTable = Object.fromEntries(
      this.#database
        .query<{ readonly name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => [name, this.#count(name)]),
    );
    return {
      projects: this.#count("projects"),
      runs: this.#count("workflow_runs"),
      clientRequests:
        this.#count("project_mutation_receipts") +
        this.#count("workflow_admission_receipts") +
        this.#count("gate_answer_receipts"),
      askings: this.#count("gate_askings"),
      artifacts: this.#count("retained_artifacts"),
      recordsByTable,
    };
  }

  #fingerprint(): string {
    const hasher = new Bun.CryptoHasher("sha256");
    const tables = this.#database
      .query<{ readonly name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    for (const { name } of tables) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new LifecycleError(
          "PURGE_SAFETY_DAMAGED",
          "the Daemon database has an unsafe table name",
        );
      }
      const rows = this.#database
        .query<Record<string, unknown>, []>(`SELECT * FROM ${name}`)
        .all()
        .map(canonical)
        .toSorted();
      hasher.update(`${name}\0${JSON.stringify(rows)}\n`);
    }
    return hasher.digest("hex");
  }

  #resourceRisks(): ReadonlyArray<PurgeResourceRisk> {
    if (!this.#table("project_resource_leases")) return [];
    return this.#database
      .query<
        {
          readonly lease_id: string;
          readonly project_id: string;
          readonly run_id: string;
          readonly resource_kind: string;
          readonly state: string;
          readonly reason: string | null;
        },
        []
      >(
        `SELECT lease_id, project_id, run_id, resource_kind, state, reason
           FROM project_resource_leases WHERE state <> 'released' ORDER BY lease_id`,
      )
      .all()
      .map((row) => ({
        leaseId: row.lease_id,
        projectId: row.project_id,
        runId: row.run_id,
        kind: row.resource_kind,
        state: row.state,
        ...(row.reason === null ? {} : { reason: row.reason }),
      }));
  }

  #finalizeDatabaseBytes(): void {
    const checkpoint = this.#database
      .query<{ readonly busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (checkpoint !== null && checkpoint.busy !== 0) {
      throw new LifecycleError(
        "PURGE_SAFETY_BUSY",
        "the sole Daemon owner could not checkpoint all accepted SQLite state",
      );
    }
    const journal = this.#database
      .query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode = DELETE")
      .get();
    if (journal?.journal_mode.toLowerCase() !== "delete") {
      throw new LifecycleError(
        "PURGE_SAFETY_BUSY",
        "the sole Daemon owner could not seal stable final SQLite bytes",
      );
    }
    this.#database.run("PRAGMA synchronous = FULL");
    for (const sidecar of ["kojo.db-wal", "kojo.db-shm"]) {
      const path = join(this.#dataRoot, sidecar);
      if (!existsSync(path)) continue;
      assertPrivateNode(path, "file");
      unlinkSync(path);
    }
  }

  #scope(): ReadonlyArray<PurgeOwnedScope> {
    assertPrivateNode(this.#dataRoot, "directory");
    const owner = process.getuid?.() ?? -1;
    const selected: PurgeOwnedScope[] = [];
    const visit = (path: string): void => {
      const stat = lstatSync(path);
      const inside = relative(this.#dataRoot, path);
      if (
        inside === "" ||
        inside.startsWith(`..${sep}`) ||
        inside === ".." ||
        stat.isSymbolicLink() ||
        stat.uid !== owner ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new LifecycleError(
          "PURGE_SCOPE_UNSAFE",
          `Daemon data contains an unowned, public, or symbolic-link node at ${inside.split(sep).join("/")}`,
        );
      }
      if (stat.isDirectory()) {
        selected.push({
          relativePath: inside.split(sep).join("/"),
          kind: "directory",
          device: stat.dev,
          inode: stat.ino,
        });
        for (const child of readdirSync(path).toSorted()) visit(join(path, child));
        return;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new LifecycleError(
          "PURGE_SCOPE_UNSAFE",
          "Daemon data contains a special or hard-linked node",
        );
      }
      selected.push({
        relativePath: inside.split(sep).join("/"),
        kind: "file",
        device: stat.dev,
        inode: stat.ino,
        sha256: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
      });
    };
    for (const child of readdirSync(this.#dataRoot).toSorted()) {
      if (child === "kojo.db-wal" || child === "kojo.db-shm") continue;
      visit(join(this.#dataRoot, child));
    }
    return selected;
  }

  #authorizeRecoveryCapsule(): void {
    const root = join(this.#dataRoot, "lifecycle", "purge-recovery-capsule");
    if (!existsSync(root)) return;
    const capsule = readPurgeRecoveryCapsule({ dataRoot: this.#dataRoot }, this.#dataIdentity);
    const unsealed = {
      formatVersion: 1,
      kind: "purge-recovery-capsule",
      dataIdentity: this.#dataIdentity,
      sourceReleaseId: capsule.sourceReleaseId,
      bunSha256: capsule.bunSha256,
      launcherSha256: capsule.launcherSha256,
      manifestSha256: capsule.manifestSha256,
    } as const;
    atomicPrivateFile(
      purgeRecoveryCapsuleAuthorizationPath({
        dataRoot: this.#dataRoot,
      }),
      `${JSON.stringify({
        ...unsealed,
        seal: sign(null, Buffer.from(canonical(unsealed)), this.#privateKey).toString("base64url"),
      })}\n`,
    );
  }

  readonly seal = (
    operationId: string,
    owner: LifecycleRecordedOwner,
    issuedAt: string,
    expiresAt: string,
  ): Effect.Effect<PurgeSafetyEvidence, LifecycleError> =>
    Effect.try({
      try: () => {
        if (owner.runnerInstanceIds.length > 0) {
          throw new LifecycleError(
            "PURGE_OWNER_ACTIVE",
            "purge safety cannot be sealed while a Project Runner still owns execution",
          );
        }
        ensurePrivateDirectory(join(this.#dataRoot, "lifecycle"));
        this.#prepareScope();
        this.#authorizeRecoveryCapsule();
        this.#finalizeDatabaseBytes();
        const correctnessFingerprint = this.#fingerprint();
        if (existsSync(this.#evidencePath)) {
          assertPrivateNode(this.#evidencePath, "file");
          const prior = JSON.parse(readFileSync(this.#evidencePath, "utf8")) as PurgeSafetyEvidence;
          if (
            prior.formatVersion === 1 &&
            prior.operationId === operationId &&
            prior.dataIdentity === this.#dataIdentity &&
            prior.correctnessFingerprint === correctnessFingerprint &&
            verify(
              null,
              Buffer.from(canonical({ ...prior, seal: undefined })),
              createPublicKey(this.#privateKey),
              Buffer.from(prior.seal, "base64url"),
            )
          ) {
            return prior;
          }
        }
        const stateVersion = correctnessFingerprint;
        const unsealed = {
          formatVersion: 1,
          evidenceId: crypto.randomUUID(),
          operationId,
          dataIdentity: this.#dataIdentity,
          stateVersion,
          correctnessFingerprint,
          correctness: this.#correctness(),
          resourceRisks: this.#resourceRisks(),
          ownedScope: this.#scope(),
          owner,
          ownerProcessState: {
            daemon: "sole-owner-finalizing",
            runners: "stopped",
          },
          issuedAt,
          expiresAt,
        } as const;
        const evidence: PurgeSafetyEvidence = {
          ...unsealed,
          seal: sign(null, Buffer.from(canonical(unsealed)), this.#privateKey).toString(
            "base64url",
          ),
        };
        atomicPrivateFile(this.#evidencePath, `${JSON.stringify(evidence)}\n`);
        return evidence;
      },
      catch: failure,
    });
}
