import { dlopen, FFIType } from "bun:ffi";
import { createPublicKey, verify } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { PurgePlan, PurgeResult, PurgeSafetyEvidence } from "../models/Purge.ts";
import type { LifecycleJournalRepository } from "../ports/LifecycleJournalRepository.ts";
import type { NativeService } from "../ports/NativeService.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

export interface PurgeGateHandle {
  readonly release: () => void;
}

interface PurgeReceipt {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly plan: PurgePlan;
  readonly evidence: PurgeSafetyEvidence;
  readonly stage: "prepared" | "quarantined" | "completed";
  readonly updatedAt: string;
}

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

const hash = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const gatePath = (paths: DaemonPaths): string =>
  join(paths.configurationRoot, "lifecycle-gate.lock");
const receiptDirectory = (paths: DaemonPaths): string =>
  join(paths.configurationRoot, "purge-control", "receipts");
const receiptPath = (paths: DaemonPaths, dataIdentity: string): string =>
  join(receiptDirectory(paths), `${hash(dataIdentity)}.json`);

const quarantinePath = (paths: DaemonPaths, dataIdentity: string): string =>
  join(
    dirname(resolve(paths.dataRoot)),
    `.${basename(resolve(paths.dataRoot))}.purge-${hash(dataIdentity).slice(0, 24)}`,
  );

const validPlan = (plan: PurgePlan): boolean =>
  plan.formatVersion === 1 &&
  plan.kind === "purge" &&
  /^[a-f0-9]{64}$/.test(plan.planId) &&
  /^[a-f0-9]{64}$/.test(plan.requestHash) &&
  plan.dataIdentity.length > 0 &&
  plan.evidenceId.length > 0 &&
  Array.isArray(plan.affectedScope) &&
  Array.isArray(plan.resourceRisks) &&
  Number.isFinite(Date.parse(plan.issuedAt)) &&
  Number.isFinite(Date.parse(plan.expiresAt)) &&
  plan.planId === hash(canonical({ ...plan, planId: undefined }));

const verifyEvidence = (paths: DaemonPaths, evidence: PurgeSafetyEvidence): void => {
  const keyId = hash(evidence.dataIdentity).slice(0, 32);
  const publicKeyPath = join(
    paths.configurationRoot,
    "purge-control",
    "public-keys",
    `${keyId}.der`,
  );
  if (!existsSync(publicKeyPath)) {
    throw new LifecycleError(
      "PURGE_RESTRICTED_RECOVERY_REQUIRED",
      "the sole Daemon owner verification key is missing; use restricted recovery",
    );
  }
  assertPrivateNode(publicKeyPath, "file");
  let accepted = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(readFileSync(publicKeyPath, "utf8"), "base64"),
      format: "der",
      type: "spki",
    });
    accepted = verify(
      null,
      Buffer.from(canonical({ ...evidence, seal: undefined })),
      publicKey,
      Buffer.from(evidence.seal, "base64url"),
    );
  } catch {
    accepted = false;
  }
  if (
    evidence.formatVersion !== 1 ||
    !accepted ||
    evidence.dataIdentity.length === 0 ||
    evidence.evidenceId.length === 0 ||
    !Array.isArray(evidence.ownedScope) ||
    !Array.isArray(evidence.resourceRisks) ||
    evidence.owner.runnerInstanceIds.length !== 0 ||
    evidence.ownerProcessState.daemon !== "sole-owner-finalizing" ||
    evidence.ownerProcessState.runners !== "stopped" ||
    !Number.isFinite(Date.parse(evidence.issuedAt)) ||
    !Number.isFinite(Date.parse(evidence.expiresAt))
  ) {
    throw new LifecycleError(
      "PURGE_EVIDENCE_DAMAGED",
      "sealed Daemon safety evidence is invalid or not authored by the sole Daemon owner",
    );
  }
};

const readReceiptAt = (paths: DaemonPaths, path: string): PurgeReceipt => {
  assertPrivateNode(path, "file");
  const value = JSON.parse(readFileSync(path, "utf8")) as PurgeReceipt;
  if (
    value.formatVersion !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value.operationId) ||
    value.dataIdentity.length === 0 ||
    path !== receiptPath(paths, value.dataIdentity) ||
    !["prepared", "quarantined", "completed"].includes(value.stage) ||
    !validPlan(value.plan) ||
    value.plan.dataIdentity !== value.dataIdentity ||
    value.evidence.dataIdentity !== value.dataIdentity ||
    value.plan.evidenceId !== value.evidence.evidenceId ||
    value.operationId !== `purge_${value.plan.planId}` ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "the stable purge receipt is invalid");
  }
  verifyEvidence(paths, value.evidence);
  return value;
};

const readReceipt = (paths: DaemonPaths, dataIdentity: string): PurgeReceipt | undefined => {
  const path = receiptPath(paths, dataIdentity);
  if (!existsSync(path)) return undefined;
  return readReceiptAt(paths, path);
};

const pendingReceipt = (paths: DaemonPaths): PurgeReceipt | undefined => {
  const directory = receiptDirectory(paths);
  if (!existsSync(directory)) return undefined;
  assertPrivateNode(directory, "directory");
  const pending = readdirSync(directory)
    .map((name) => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) {
        throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "the purge receipt path is invalid");
      }
      return readReceiptAt(paths, join(directory, name));
    })
    .filter((receipt) => receipt.stage !== "completed");
  if (pending.length > 1) {
    throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "more than one purge is pending");
  }
  return pending[0];
};

const acquireGate = (paths: DaemonPaths): PurgeGateHandle => {
  ensurePrivateDirectory(paths.configurationRoot);
  const path = gatePath(paths);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(descriptor, 0o600);
  const stat = fstatSync(descriptor);
  if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    closeSync(descriptor);
    throw new LifecycleError("PURGE_GATE_UNSAFE", "the stable start and purge gate is unsafe");
  }
  const libraryName = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const library = dlopen(libraryName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (library.symbols.flock(descriptor, 2 | 4) !== 0) {
    library.close();
    closeSync(descriptor);
    throw new LifecycleError(
      "PURGE_GATE_HELD",
      "another Daemon start or purge transition owns the stable lifecycle gate",
    );
  }
  return {
    release: () => {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    },
  };
};

/** Acquire this before any start path creates or opens a Daemon data root. */
export const acquireDaemonStartGate = (paths: DaemonPaths): PurgeGateHandle => {
  const gate = acquireGate(paths);
  try {
    const receipt = pendingReceipt(paths);
    if (receipt !== undefined && receipt.stage !== "completed") {
      throw new LifecycleError(
        "PURGE_IN_PROGRESS",
        `purge operation ${receipt.operationId} must finish before a Daemon can start`,
      );
    }
    return gate;
  } catch (cause) {
    gate.release();
    throw cause;
  }
};

const writeReceipt = (paths: DaemonPaths, receipt: PurgeReceipt): void => {
  atomicPrivateFile(receiptPath(paths, receipt.dataIdentity), `${JSON.stringify(receipt)}\n`);
};

export const readVerifiedPurgeSafetyEvidence = (paths: DaemonPaths): PurgeSafetyEvidence => {
  const path = join(paths.dataRoot, "lifecycle", "purge-safety.json");
  if (!existsSync(path)) {
    throw new LifecycleError(
      "PURGE_RESTRICTED_RECOVERY_REQUIRED",
      "sealed Daemon safety evidence is missing; use restricted recovery to produce it",
    );
  }
  assertPrivateNode(path, "file");
  const evidence = JSON.parse(readFileSync(path, "utf8")) as PurgeSafetyEvidence;
  verifyEvidence(paths, evidence);
  return evidence;
};

const decodePlan = (token: string, evidence: PurgeSafetyEvidence): PurgePlan => {
  const [encoded, suppliedSeal, extra] = token.split(".");
  if (encoded === undefined || suppliedSeal === undefined || extra !== undefined) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan token is invalid");
  }
  let plan: PurgePlan;
  try {
    plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PurgePlan;
  } catch (cause) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan token is invalid", cause);
  }
  if (
    plan.formatVersion !== 1 ||
    plan.kind !== "purge" ||
    suppliedSeal !== hash(`${canonical(plan)}\0${evidence.seal}`) ||
    plan.planId !== hash(canonical({ ...plan, planId: undefined }))
  ) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan token is invalid");
  }
  return plan;
};

const untrustedPlanIdentity = (token: string): string | undefined => {
  const [encoded, _suppliedSeal, extra] = token.split(".");
  if (encoded === undefined || extra !== undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      readonly dataIdentity?: unknown;
    };
    return typeof value.dataIdentity === "string" && value.dataIdentity.length <= 1_024
      ? value.dataIdentity
      : undefined;
  } catch {
    return undefined;
  }
};

const secureTree = (root: string): ReadonlyMap<string, Stats> => {
  assertPrivateNode(root, "directory");
  const selected = new Map<string, Stats>();
  const owner = process.getuid?.() ?? -1;
  const visit = (path: string): void => {
    const stat: Stats = lstatSync(path);
    const inside = relative(root, path).split(sep).join("/");
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith("../") ||
      stat.isSymbolicLink() ||
      stat.uid !== owner ||
      (stat.mode & 0o077) !== 0 ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
    ) {
      throw new LifecycleError(
        "PURGE_SCOPE_UNSAFE",
        "Daemon data contains an unowned, public, linked, or special node",
      );
    }
    selected.set(inside, stat);
    if (stat.isDirectory())
      for (const child of readdirSync(path).toSorted()) visit(join(path, child));
  };
  for (const child of readdirSync(root).toSorted()) visit(join(root, child));
  return selected;
};

const validateScopeAt = (
  rootPath: string,
  evidence: PurgeSafetyEvidence,
): ReadonlyArray<string> => {
  const root = resolve(rootPath);
  const actual = secureTree(root);
  const planned = new Map(evidence.ownedScope.map((entry) => [entry.relativePath, entry]));
  const topLevel = new Set<string>();
  for (const [relativePath, stat] of actual) {
    const first = relativePath.split("/", 1)[0];
    if (first === undefined) throw new LifecycleError("PURGE_SCOPE_UNSAFE", "purge scope is empty");
    topLevel.add(first);
    const expected = planned.get(relativePath);
    if (relativePath === "lifecycle" || relativePath.startsWith("lifecycle/")) continue;
    if (
      expected === undefined ||
      expected.device !== stat.dev ||
      expected.inode !== stat.ino ||
      expected.kind !== (stat.isDirectory() ? "directory" : "file") ||
      (stat.isFile() &&
        expected.sha256 !==
          new Bun.CryptoHasher("sha256")
            .update(readFileSync(join(root, relativePath)))
            .digest("hex"))
    ) {
      throw new LifecycleError(
        "PURGE_PLAN_STALE",
        `Daemon data path ${relativePath} is new or changed since the sole owner sealed the plan`,
      );
    }
  }
  const plannedTopLevel = new Set(
    evidence.ownedScope.map((entry) => entry.relativePath.split("/", 1)[0]),
  );
  if ([...topLevel].some((entry) => !plannedTopLevel.has(entry))) {
    throw new LifecycleError("PURGE_PLAN_STALE", "Daemon data has an unplanned owned root");
  }
  return [...topLevel].toSorted();
};

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const deleteTree = (path: string): void => {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== (process.getuid?.() ?? -1) ||
    (stat.mode & 0o077) !== 0 ||
    (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
  ) {
    throw new LifecycleError(
      "PURGE_SCOPE_UNSAFE",
      "the quarantined Daemon data changed to an unsafe node before deletion",
    );
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) deleteTree(join(path, child));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
};

export class DaemonDataPurger {
  readonly #paths: DaemonPaths;
  readonly #journal: LifecycleJournalRepository | undefined;
  readonly #nativeService: NativeService;
  readonly #now: () => number;
  readonly #boundary: (stage: string) => void;

  constructor(options: {
    readonly paths: DaemonPaths;
    readonly journal?: LifecycleJournalRepository;
    readonly nativeService: NativeService;
    readonly now?: () => number;
    readonly boundary?: (stage: string) => void;
  }) {
    this.#paths = options.paths;
    this.#journal = options.journal;
    this.#nativeService = options.nativeService;
    this.#now = options.now ?? Date.now;
    this.#boundary = options.boundary ?? (() => undefined);
  }

  #time(): string {
    return new Date(this.#now()).toISOString();
  }

  readonly check = (): { readonly plan: PurgePlan; readonly planToken: string } => {
    const evidence = readVerifiedPurgeSafetyEvidence(this.#paths);
    if (Date.parse(evidence.expiresAt) <= this.#now()) {
      throw new LifecycleError(
        "PURGE_RESTRICTED_RECOVERY_REQUIRED",
        "sealed safety evidence is stale; use restricted recovery before purge",
      );
    }
    const native = this.#nativeService.inspect();
    const issuedAt = this.#time();
    const expiresAt = new Date(
      Math.min(this.#now() + 10 * 60_000, Date.parse(evidence.expiresAt)),
    ).toISOString();
    const requestHash = hash(
      canonical({
        operation: "purge",
        dataIdentity: evidence.dataIdentity,
        evidenceId: evidence.evidenceId,
      }),
    );
    const withoutId = {
      formatVersion: 1,
      kind: "purge",
      dataIdentity: evidence.dataIdentity,
      requestHash,
      affectedScope: [
        ...new Set(
          evidence.ownedScope.map((entry) => entry.relativePath.split("/", 1)[0] as string),
        ),
      ].toSorted(),
      expectedStateVersion: evidence.stateVersion,
      expectedCorrectnessFingerprint: evidence.correctnessFingerprint,
      evidenceId: evidence.evidenceId,
      issuedAt,
      expiresAt,
      correctness: evidence.correctness,
      resourceRisks: evidence.resourceRisks,
      observed: { automaticStart: native.automaticStart, process: native.process },
    } as const;
    const plan: PurgePlan = {
      ...withoutId,
      planId: hash(canonical({ ...withoutId, planId: undefined })),
    };
    const encoded = Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
    return { plan, planToken: `${encoded}.${hash(`${canonical(plan)}\0${evidence.seal}`)}` };
  };

  readonly confirm = (planToken: string): PurgeResult => {
    const gate = acquireGate(this.#paths);
    try {
      const pending = pendingReceipt(this.#paths);
      if (pending !== undefined) {
        const repeated = decodePlan(planToken, pending.evidence);
        if (canonical(repeated) !== canonical(pending.plan)) {
          throw new LifecycleError(
            "PURGE_REPLAY_CONFLICT",
            "the pending purge must be resumed with its exact original plan",
          );
        }
        return this.#finish(pending);
      }
      const namedIdentity = untrustedPlanIdentity(planToken);
      if (namedIdentity !== undefined) {
        const completed = readReceipt(this.#paths, namedIdentity);
        if (completed?.stage === "completed") {
          const currentIdentityPath = join(this.#paths.dataRoot, "lifecycle", "data-identity");
          if (existsSync(currentIdentityPath)) {
            assertPrivateNode(currentIdentityPath, "file");
            if (readFileSync(currentIdentityPath, "utf8").trim() !== completed.dataIdentity) {
              throw new LifecycleError(
                "PURGE_PLAN_INVALID",
                "the old purge plan belongs to a completed prior Daemon data lifetime",
              );
            }
          }
          const repeated = decodePlan(planToken, completed.evidence);
          if (canonical(repeated) !== canonical(completed.plan)) {
            throw new LifecycleError(
              "PURGE_REPLAY_CONFLICT",
              "a completed purge cannot accept a different plan",
            );
          }
          return this.#finish(completed);
        }
      }
      const evidence = readVerifiedPurgeSafetyEvidence(this.#paths);
      const plan = decodePlan(planToken, evidence);
      const priorReceipt = readReceipt(this.#paths, plan.dataIdentity);
      if (priorReceipt !== undefined) {
        if (priorReceipt.stage === "completed") {
          return {
            outcome: "purged",
            operationId: priorReceipt.operationId,
            dataIdentity: priorReceipt.dataIdentity,
            completedAt: priorReceipt.updatedAt,
          };
        }
        throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "a completed purge became pending");
      }
      if (
        plan.dataIdentity !== evidence.dataIdentity ||
        plan.evidenceId !== evidence.evidenceId ||
        plan.expectedStateVersion !== evidence.stateVersion ||
        plan.expectedCorrectnessFingerprint !== evidence.correctnessFingerprint ||
        Date.parse(plan.expiresAt) <= this.#now() ||
        Date.parse(evidence.expiresAt) <= this.#now()
      ) {
        throw new LifecycleError("PURGE_PLAN_STALE", "the purge plan or safety evidence is stale");
      }
      if (evidence.resourceRisks.length > 0) {
        throw new LifecycleError(
          "PURGE_RESOURCE_RISK",
          `${evidence.resourceRisks.length} Resource lease(s) are not confirmed released`,
        );
      }
      const native = this.#nativeService.inspect();
      if (native.process !== "stopped" || native.automaticStart !== "disabled") {
        throw new LifecycleError(
          "PURGE_SERVICE_UNSAFE",
          "purge requires confirmed stopped ownership and disabled automatic start",
        );
      }
      if (this.#journal === undefined) {
        throw new LifecycleError(
          "PURGE_JOURNAL_UNAVAILABLE",
          "the original lifecycle journal is missing before purge authorization",
        );
      }
      const current = this.#journal.current();
      if (current !== undefined && current.outcome === undefined) {
        throw new LifecycleError(
          "LIFECYCLE_OPERATION_PENDING",
          `lifecycle operation ${current.operationId} is still ${current.stage}`,
        );
      }
      validateScopeAt(this.#paths.dataRoot, evidence);
      const operationId = `purge_${plan.planId}`;
      const operation = this.#journal.begin({
        operationId,
        dataIdentity: evidence.dataIdentity,
        originalRequestHash: plan.requestHash,
        kind: "purge",
        sourceReleaseId: "removed",
        startedAt: this.#time(),
      });
      this.#journal.advance({
        operationId,
        expectedRevision: operation.stageRevision,
        stage: "purge-authorized",
        updatedAt: this.#time(),
        changes: { purgeSafetyEvidenceId: evidence.evidenceId },
      });
      const receipt: PurgeReceipt = {
        formatVersion: 1,
        operationId,
        dataIdentity: evidence.dataIdentity,
        plan,
        evidence,
        stage: "prepared",
        updatedAt: this.#time(),
      };
      writeReceipt(this.#paths, receipt);
      this.#boundary("prepared");
      return this.#finish(receipt);
    } finally {
      gate.release();
    }
  };

  #finish(receipt: PurgeReceipt): PurgeResult {
    if (receipt.stage === "completed") {
      return {
        outcome: "purged",
        operationId: receipt.operationId,
        dataIdentity: receipt.dataIdentity,
        completedAt: receipt.updatedAt,
      };
    }
    if (existsSync(this.#paths.dataRoot)) {
      if (this.#journal === undefined) {
        throw new LifecycleError(
          "PURGE_JOURNAL_UNAVAILABLE",
          "the original lifecycle journal is missing before quarantine",
        );
      }
      validateScopeAt(this.#paths.dataRoot, receipt.evidence);
      const operation = this.#journal.read(receipt.operationId);
      if (operation !== undefined && operation.stage === "purge-authorized") {
        this.#journal.advance({
          operationId: receipt.operationId,
          expectedRevision: operation.stageRevision,
          stage: "data-deletion-started",
          updatedAt: this.#time(),
        });
      }
      this.#boundary("deleting");
      const quarantine = quarantinePath(this.#paths, receipt.dataIdentity);
      if (existsSync(quarantine)) {
        throw new LifecycleError(
          "PURGE_QUARANTINE_CONFLICT",
          "the exact identity-bound purge quarantine already exists",
        );
      }
      renameSync(this.#paths.dataRoot, quarantine);
      syncDirectory(dirname(quarantine));
      this.#boundary("renamed");
      writeReceipt(this.#paths, { ...receipt, stage: "quarantined", updatedAt: this.#time() });
      this.#boundary("quarantined");
    }
    const quarantine = quarantinePath(this.#paths, receipt.dataIdentity);
    if (existsSync(quarantine)) {
      validateScopeAt(quarantine, receipt.evidence);
      deleteTree(quarantine);
      syncDirectory(dirname(quarantine));
    }
    const completedAt = this.#time();
    writeReceipt(this.#paths, { ...receipt, stage: "completed", updatedAt: completedAt });
    this.#boundary("completed");
    return {
      outcome: "purged",
      operationId: receipt.operationId,
      dataIdentity: receipt.dataIdentity,
      completedAt,
    };
  }
}
