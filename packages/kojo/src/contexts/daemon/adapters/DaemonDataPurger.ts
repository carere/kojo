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

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
};

const safeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const correctnessOf = (value: unknown): PurgeSafetyEvidence["correctness"] => {
  const correctness = record(value);
  const recordsByTable = record(correctness?.recordsByTable);
  if (
    correctness === undefined ||
    !exactKeys(correctness, [
      "projects",
      "runs",
      "clientRequests",
      "askings",
      "artifacts",
      "recordsByTable",
    ]) ||
    !safeCount(correctness.projects) ||
    !safeCount(correctness.runs) ||
    !safeCount(correctness.clientRequests) ||
    !safeCount(correctness.askings) ||
    !safeCount(correctness.artifacts) ||
    recordsByTable === undefined ||
    Object.entries(recordsByTable).some(
      ([name, count]) => !/^[A-Za-z0-9_]+$/.test(name) || !safeCount(count),
    )
  ) {
    throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "the purge correctness summary is invalid");
  }
  return correctness as unknown as PurgeSafetyEvidence["correctness"];
};

const resourceRisksOf = (value: unknown): PurgeSafetyEvidence["resourceRisks"] => {
  if (!Array.isArray(value)) {
    throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "the purge Resource risks are invalid");
  }
  for (const selected of value) {
    const risk = record(selected);
    const keys = [
      "leaseId",
      "projectId",
      "runId",
      "kind",
      "state",
      ...(risk?.reason === undefined ? [] : ["reason"]),
    ] as const;
    if (
      risk === undefined ||
      !exactKeys(risk, keys) ||
      [risk.leaseId, risk.projectId, risk.runId, risk.kind, risk.state].some(
        (field) => typeof field !== "string" || field.length === 0,
      ) ||
      (risk.reason !== undefined && typeof risk.reason !== "string")
    ) {
      throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "a purge Resource risk is invalid");
    }
  }
  return value as PurgeSafetyEvidence["resourceRisks"];
};

const ownedScopeOf = (value: unknown): PurgeSafetyEvidence["ownedScope"] => {
  if (!Array.isArray(value)) {
    throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "the purge owned scope is invalid");
  }
  const names = new Set<string>();
  for (const selected of value) {
    const entry = record(selected);
    const isFile = entry?.kind === "file";
    if (
      entry === undefined ||
      !exactKeys(entry, [
        "relativePath",
        "kind",
        "device",
        "inode",
        ...(isFile ? ["sha256"] : []),
      ]) ||
      typeof entry.relativePath !== "string" ||
      entry.relativePath.length === 0 ||
      entry.relativePath.startsWith("/") ||
      entry.relativePath
        .split("/")
        .some((part) => part.length === 0 || part === "." || part === "..") ||
      names.has(entry.relativePath) ||
      (entry.kind !== "directory" && entry.kind !== "file") ||
      !safeCount(entry.device) ||
      !safeCount(entry.inode) ||
      (isFile && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)))
    ) {
      throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "a purge owned-scope entry is invalid");
    }
    names.add(entry.relativePath);
  }
  return value as PurgeSafetyEvidence["ownedScope"];
};

export const decodePurgeSafetyEvidence = (value: unknown): PurgeSafetyEvidence => {
  const evidence = record(value);
  const owner = record(evidence?.owner);
  const ownerState = record(evidence?.ownerProcessState);
  if (
    evidence === undefined ||
    !exactKeys(evidence, [
      "formatVersion",
      "evidenceId",
      "operationId",
      "dataIdentity",
      "stateVersion",
      "correctnessFingerprint",
      "correctness",
      "resourceRisks",
      "ownedScope",
      "owner",
      "ownerProcessState",
      "issuedAt",
      "expiresAt",
      "seal",
    ]) ||
    evidence.formatVersion !== 1 ||
    typeof evidence.evidenceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.evidenceId) ||
    typeof evidence.operationId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.operationId) ||
    typeof evidence.dataIdentity !== "string" ||
    evidence.dataIdentity.length === 0 ||
    evidence.dataIdentity.length > 1_024 ||
    typeof evidence.stateVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.stateVersion) ||
    typeof evidence.correctnessFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.correctnessFingerprint) ||
    owner === undefined ||
    !exactKeys(owner, ["daemonInstanceId", "runnerInstanceIds", "recordedAt"]) ||
    typeof owner.daemonInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(owner.daemonInstanceId) ||
    !Array.isArray(owner.runnerInstanceIds) ||
    !owner.runnerInstanceIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) ||
    typeof owner.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(owner.recordedAt)) ||
    ownerState === undefined ||
    !exactKeys(ownerState, ["daemon", "runners"]) ||
    ownerState.daemon !== "sole-owner-finalizing" ||
    ownerState.runners !== "stopped" ||
    typeof evidence.issuedAt !== "string" ||
    typeof evidence.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.issuedAt)) ||
    !Number.isFinite(Date.parse(evidence.expiresAt)) ||
    Date.parse(evidence.expiresAt) <= Date.parse(evidence.issuedAt) ||
    typeof evidence.seal !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.seal) ||
    Buffer.from(evidence.seal, "base64url").byteLength !== 64
  ) {
    throw new LifecycleError("PURGE_EVIDENCE_DAMAGED", "sealed Daemon safety evidence is invalid");
  }
  correctnessOf(evidence.correctness);
  resourceRisksOf(evidence.resourceRisks);
  ownedScopeOf(evidence.ownedScope);
  return evidence as unknown as PurgeSafetyEvidence;
};

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

const planOf = (value: unknown): PurgePlan => {
  const plan = record(value);
  const observed = record(plan?.observed);
  if (
    plan === undefined ||
    !exactKeys(plan, [
      "formatVersion",
      "planId",
      "kind",
      "dataIdentity",
      "requestHash",
      "affectedScope",
      "expectedStateVersion",
      "expectedCorrectnessFingerprint",
      "evidenceId",
      "issuedAt",
      "expiresAt",
      "correctness",
      "resourceRisks",
      "observed",
    ]) ||
    plan.formatVersion !== 1 ||
    plan.kind !== "purge" ||
    typeof plan.planId !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.planId) ||
    typeof plan.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.requestHash) ||
    typeof plan.dataIdentity !== "string" ||
    plan.dataIdentity.length === 0 ||
    plan.dataIdentity.length > 1_024 ||
    typeof plan.evidenceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(plan.evidenceId) ||
    !Array.isArray(plan.affectedScope) ||
    !plan.affectedScope.every(
      (path) => typeof path === "string" && path.length > 0 && !path.includes("/"),
    ) ||
    new Set(plan.affectedScope).size !== plan.affectedScope.length ||
    typeof plan.expectedStateVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.expectedStateVersion) ||
    typeof plan.expectedCorrectnessFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.expectedCorrectnessFingerprint) ||
    typeof plan.issuedAt !== "string" ||
    typeof plan.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(plan.issuedAt)) ||
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    Date.parse(plan.expiresAt) <= Date.parse(plan.issuedAt) ||
    observed === undefined ||
    !exactKeys(observed, ["automaticStart", "process"]) ||
    !["enabled", "disabled", "unknown"].includes(String(observed.automaticStart)) ||
    !["running", "stopped", "unknown"].includes(String(observed.process))
  ) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan is invalid");
  }
  correctnessOf(plan.correctness);
  resourceRisksOf(plan.resourceRisks);
  const decoded = plan as unknown as PurgePlan;
  if (decoded.planId !== hash(canonical({ ...decoded, planId: undefined }))) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan identity is invalid");
  }
  return decoded;
};

const verifyEvidence = (paths: DaemonPaths, value: unknown): PurgeSafetyEvidence => {
  const evidence = decodePurgeSafetyEvidence(value);
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
  if (!accepted || evidence.owner.runnerInstanceIds.length !== 0) {
    throw new LifecycleError(
      "PURGE_EVIDENCE_DAMAGED",
      "sealed Daemon safety evidence is invalid or not authored by the sole Daemon owner",
    );
  }
  return evidence;
};

const readReceiptAt = (paths: DaemonPaths, path: string): PurgeReceipt => {
  assertPrivateNode(path, "file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const selected = record(parsed);
  if (
    selected === undefined ||
    !exactKeys(selected, [
      "formatVersion",
      "operationId",
      "dataIdentity",
      "plan",
      "evidence",
      "stage",
      "updatedAt",
    ])
  ) {
    throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "the stable purge receipt is invalid");
  }
  const plan = planOf(selected.plan);
  const evidence = verifyEvidence(paths, selected.evidence);
  const value = { ...selected, plan, evidence } as unknown as PurgeReceipt;
  if (
    value.formatVersion !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value.operationId) ||
    value.dataIdentity.length === 0 ||
    path !== receiptPath(paths, value.dataIdentity) ||
    !["prepared", "quarantined", "completed"].includes(value.stage) ||
    value.plan.dataIdentity !== value.dataIdentity ||
    value.evidence.dataIdentity !== value.dataIdentity ||
    value.plan.evidenceId !== value.evidence.evidenceId ||
    value.operationId !== `purge_${value.plan.planId}` ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new LifecycleError("PURGE_RECEIPT_DAMAGED", "the stable purge receipt is invalid");
  }
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
  return verifyEvidence(paths, JSON.parse(readFileSync(path, "utf8")));
};

const decodePlan = (token: string, evidence: PurgeSafetyEvidence): PurgePlan => {
  const [encoded, suppliedSeal, extra] = token.split(".");
  if (encoded === undefined || suppliedSeal === undefined || extra !== undefined) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan token is invalid");
  }
  let plan: PurgePlan;
  try {
    plan = planOf(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch (cause) {
    throw new LifecycleError("PURGE_PLAN_INVALID", "the purge plan token is invalid", cause);
  }
  if (
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

interface ScopeValidationOptions {
  readonly mutableOperationIds?: ReadonlyArray<string>;
  readonly allowMissing?: boolean;
}

const validMutableLifecycleEntry = (
  root: string,
  relativePath: string,
  evidence: PurgeSafetyEvidence,
  operationIds: ReadonlySet<string>,
): boolean => {
  if (relativePath === "lifecycle/purge-safety.json") {
    try {
      const selected = decodePurgeSafetyEvidence(
        JSON.parse(readFileSync(join(root, relativePath), "utf8")),
      );
      return canonical(selected) === canonical(evidence);
    } catch {
      return false;
    }
  }
  if (relativePath === "lifecycle/current-operation") {
    return operationIds.has(readFileSync(join(root, relativePath), "utf8").trim());
  }
  const operation = /^lifecycle\/operations\/([A-Za-z0-9_-]+)(?:\/(\d+)\.json)?$/.exec(
    relativePath,
  );
  if (operation?.[1] !== undefined && operationIds.has(operation[1])) {
    if (operation[2] === undefined) return lstatSync(join(root, relativePath)).isDirectory();
    try {
      const selected = record(JSON.parse(readFileSync(join(root, relativePath), "utf8")));
      return (
        selected !== undefined &&
        selected.formatVersion === 1 &&
        selected.operationId === operation[1] &&
        selected.dataIdentity === evidence.dataIdentity &&
        Number(selected.stageRevision) === Number(operation[2]) &&
        (selected.kind === "remove" ||
          selected.kind === "purge" ||
          selected.kind === "purge-recovery") &&
        (selected.purgeSafetyEvidenceId === undefined ||
          selected.purgeSafetyEvidenceId === evidence.evidenceId)
      );
    } catch {
      return false;
    }
  }
  const secret = /^lifecycle\/control-secrets\/([A-Za-z0-9_-]+)$/.exec(relativePath)?.[1];
  return (
    secret !== undefined &&
    operationIds.has(secret) &&
    /^[a-f0-9]{64}$/.test(readFileSync(join(root, relativePath), "utf8").trim())
  );
};

const validateScopeAt = (
  rootPath: string,
  evidence: PurgeSafetyEvidence,
  options: ScopeValidationOptions = {},
): ReadonlyArray<string> => {
  const root = resolve(rootPath);
  const actual = secureTree(root);
  const planned = new Map(evidence.ownedScope.map((entry) => [entry.relativePath, entry]));
  const mutableOperationIds = new Set([
    evidence.operationId,
    ...(options.mutableOperationIds ?? []),
  ]);
  const topLevel = new Set<string>();
  for (const [relativePath, stat] of actual) {
    const first = relativePath.split("/", 1)[0];
    if (first === undefined) throw new LifecycleError("PURGE_SCOPE_UNSAFE", "purge scope is empty");
    topLevel.add(first);
    const expected = planned.get(relativePath);
    if (
      validMutableLifecycleEntry(root, relativePath, evidence, mutableOperationIds) &&
      (expected === undefined ||
        relativePath === "lifecycle/current-operation" ||
        relativePath === "lifecycle/purge-safety.json")
    ) {
      continue;
    }
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
  if (!options.allowMissing) {
    for (const relativePath of planned.keys()) {
      if (!actual.has(relativePath)) {
        throw new LifecycleError(
          "PURGE_PLAN_STALE",
          `Daemon data path ${relativePath} is missing since the sole owner sealed the plan`,
        );
      }
    }
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

const deleteTree = (path: string, afterDelete: () => void = () => undefined): void => {
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
    for (const child of readdirSync(path)) deleteTree(join(path, child), afterDelete);
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
  afterDelete();
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
    validateScopeAt(this.#paths.dataRoot, evidence);
    const native = this.#nativeService.inspect();
    const issuedAt = evidence.issuedAt;
    const expiresAt = evidence.expiresAt;
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
      const expectedAffectedScope = [
        ...new Set(
          evidence.ownedScope.map((entry) => entry.relativePath.split("/", 1)[0] as string),
        ),
      ].toSorted();
      const expectedRequestHash = hash(
        canonical({
          operation: "purge",
          dataIdentity: evidence.dataIdentity,
          evidenceId: evidence.evidenceId,
        }),
      );
      const native = this.#nativeService.inspect();
      if (
        plan.dataIdentity !== evidence.dataIdentity ||
        plan.evidenceId !== evidence.evidenceId ||
        plan.requestHash !== expectedRequestHash ||
        canonical(plan.affectedScope) !== canonical(expectedAffectedScope) ||
        plan.expectedStateVersion !== evidence.stateVersion ||
        plan.expectedCorrectnessFingerprint !== evidence.correctnessFingerprint ||
        canonical(plan.correctness) !== canonical(evidence.correctness) ||
        canonical(plan.resourceRisks) !== canonical(evidence.resourceRisks) ||
        plan.issuedAt !== evidence.issuedAt ||
        plan.expiresAt !== evidence.expiresAt ||
        canonical(plan.observed) !==
          canonical({ automaticStart: native.automaticStart, process: native.process }) ||
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
      validateScopeAt(this.#paths.dataRoot, receipt.evidence, {
        mutableOperationIds: [receipt.operationId],
      });
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
      validateScopeAt(quarantine, receipt.evidence, {
        mutableOperationIds: [receipt.operationId],
        allowMissing: true,
      });
      deleteTree(quarantine, () => this.#boundary("delete-node"));
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
