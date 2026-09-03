import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  PurgeSafetyRecoveryCheck,
  PurgeSafetyRecoveryPlan,
  PurgeSafetyRecoveryResult,
} from "../models/Purge.ts";
import type { LifecycleJournalRepository } from "../ports/LifecycleJournalRepository.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { assertPrivateNode, atomicPrivateFile } from "../services/secureHostPath.ts";
import { readVerifiedPurgeSafetyEvidence } from "./DaemonDataPurger.ts";
import {
  type PurgeRecoveryCapsuleAuthorization,
  purgeRecoveryCapsuleAuthorizationPath,
  readPurgeRecoveryCapsule,
} from "./PurgeRecoveryCapsule.ts";

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

const planKeyPath = (paths: DaemonPaths): string =>
  join(paths.configurationRoot, "purge-control", "recovery-plan.key");

const authorizationPath = (paths: DaemonPaths, planId: string): string =>
  join(paths.configurationRoot, "purge-control", "recovery-authorizations", `${planId}.json`);

const dataIdentityAt = (paths: DaemonPaths): string => {
  const path = join(paths.dataRoot, "lifecycle", "data-identity");
  assertPrivateNode(path, "file");
  const identity = readFileSync(path, "utf8").trim();
  if (identity.length === 0) {
    throw new LifecycleError("DAEMON_DATA_IDENTITY_DAMAGED", "the retained data identity is empty");
  }
  return identity;
};

const recoverySource = (
  paths: DaemonPaths,
  dataIdentity: string,
): { readonly sourceReleaseId: string; readonly bun: string; readonly launcher: string } => {
  const capsule = readPurgeRecoveryCapsule(paths, dataIdentity);
  try {
    const evidence = readVerifiedPurgeSafetyEvidence(paths);
    if (evidence.dataIdentity !== dataIdentity) {
      throw new LifecycleError(
        "PURGE_RECOVERY_CAPSULE_DAMAGED",
        "the signed capsule binding names another Daemon data identity",
      );
    }
    for (const [relativePath, path] of [
      ["lifecycle/purge-recovery-capsule/runtime/bun", capsule.bun],
      ["lifecycle/purge-recovery-capsule/launcher.js", capsule.launcher],
      ["lifecycle/purge-recovery-capsule/manifest.json", capsule.manifest],
    ] as const) {
      const expected = evidence.ownedScope.find((entry) => entry.relativePath === relativePath);
      const actual = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
      if (expected?.kind !== "file" || expected.sha256 !== actual) {
        throw new LifecycleError(
          "PURGE_RECOVERY_CAPSULE_DAMAGED",
          "the restricted recovery capsule does not match its signed Daemon evidence",
        );
      }
    }
  } catch {
    const authorizationPath = purgeRecoveryCapsuleAuthorizationPath(paths);
    assertPrivateNode(authorizationPath, "file");
    const authorization = JSON.parse(
      readFileSync(authorizationPath, "utf8"),
    ) as PurgeRecoveryCapsuleAuthorization;
    const allowed = [
      "formatVersion",
      "kind",
      "dataIdentity",
      "sourceReleaseId",
      "bunSha256",
      "launcherSha256",
      "manifestSha256",
      "seal",
    ];
    const publicKeyPath = join(
      paths.configurationRoot,
      "purge-control",
      "public-keys",
      `${hash(dataIdentity).slice(0, 32)}.der`,
    );
    if (
      authorization === null ||
      typeof authorization !== "object" ||
      Array.isArray(authorization)
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_CAPSULE_DAMAGED",
        "the restricted recovery capsule authorization is invalid",
      );
    }
    assertPrivateNode(publicKeyPath, "file");
    let accepted = false;
    try {
      accepted = verify(
        null,
        Buffer.from(canonical({ ...authorization, seal: undefined })),
        createPublicKey({
          key: Buffer.from(readFileSync(publicKeyPath, "utf8"), "base64"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(authorization.seal, "base64url"),
      );
    } catch {
      accepted = false;
    }
    if (
      Object.keys(authorization).length !== allowed.length ||
      Object.keys(authorization).some((key) => !allowed.includes(key)) ||
      authorization.formatVersion !== 1 ||
      authorization.kind !== "purge-recovery-capsule" ||
      authorization.dataIdentity !== dataIdentity ||
      authorization.sourceReleaseId !== capsule.sourceReleaseId ||
      authorization.bunSha256 !== capsule.bunSha256 ||
      authorization.launcherSha256 !== capsule.launcherSha256 ||
      authorization.manifestSha256 !== capsule.manifestSha256 ||
      !accepted
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_CAPSULE_DAMAGED",
        "the restricted recovery capsule has no valid signed identity authorization",
      );
    }
  }
  return {
    sourceReleaseId: capsule.sourceReleaseId,
    bun: capsule.bun,
    launcher: capsule.launcher,
  };
};

const planSeal = (paths: DaemonPaths, encoded: string): string => {
  const path = planKeyPath(paths);
  assertPrivateNode(path, "file");
  const key = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_KEY_DAMAGED",
      "the restricted recovery plan key is damaged",
    );
  }
  return createHmac("sha256", Buffer.from(key, "hex")).update(encoded).digest("hex");
};

export const decodePurgeSafetyRecoveryPlan = (
  paths: DaemonPaths,
  token: string,
): PurgeSafetyRecoveryPlan => {
  const [encoded, suppliedSeal, extra] = token.split(".");
  if (
    encoded === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    suppliedSeal === undefined ||
    extra !== undefined ||
    !/^[a-f0-9]{64}$/.test(suppliedSeal)
  ) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan token is invalid",
    );
  }
  const expectedSeal = planSeal(paths, encoded);
  if (!timingSafeEqual(Buffer.from(suppliedSeal, "hex"), Buffer.from(expectedSeal, "hex"))) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan token is invalid",
    );
  }
  let plan: PurgeSafetyRecoveryPlan;
  try {
    plan = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as PurgeSafetyRecoveryPlan;
  } catch (cause) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan token is invalid",
      cause,
    );
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan is invalid",
    );
  }
  const keys = Object.keys(plan);
  const expectedKeys = [
    "formatVersion",
    "kind",
    "planId",
    "dataIdentity",
    "sourceReleaseId",
    "issuedAt",
    "expiresAt",
    "expected",
    ...(plan.lifecycleOperationId === undefined ? [] : ["lifecycleOperationId"]),
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key)) ||
    plan.expected === null ||
    typeof plan.expected !== "object" ||
    Array.isArray(plan.expected) ||
    Object.keys(plan.expected).length !== 2 ||
    !Object.keys(plan.expected).every((key) => ["automaticStart", "process"].includes(key)) ||
    plan.formatVersion !== 1 ||
    plan.kind !== "purge-safety-recovery" ||
    typeof plan.planId !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.planId) ||
    plan.planId !== hash(canonical({ ...plan, planId: undefined })) ||
    typeof plan.dataIdentity !== "string" ||
    plan.dataIdentity.length === 0 ||
    plan.dataIdentity.length > 1_024 ||
    (plan.lifecycleOperationId !== undefined &&
      (typeof plan.lifecycleOperationId !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(plan.lifecycleOperationId))) ||
    typeof plan.sourceReleaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(plan.sourceReleaseId) ||
    plan.expected.automaticStart !== "disabled" ||
    plan.expected.process !== "stopped" ||
    typeof plan.issuedAt !== "string" ||
    typeof plan.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(plan.issuedAt)) ||
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    Date.parse(plan.expiresAt) - Date.parse(plan.issuedAt) !== 10 * 60_000
  ) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan is invalid",
    );
  }
  return plan;
};

export const authorizePurgeSafetyRecoveryChild = (
  paths: DaemonPaths,
  plan: PurgeSafetyRecoveryPlan,
  operationId: string,
  now: number,
): string => {
  const capability = crypto.getRandomValues(new Uint8Array(32)).toHex();
  atomicPrivateFile(
    authorizationPath(paths, plan.planId),
    `${JSON.stringify({
      formatVersion: 1,
      planId: plan.planId,
      dataIdentity: plan.dataIdentity,
      operationId,
      capabilityHash: hash(capability),
      issuedAt: new Date(now).toISOString(),
      expiresAt: plan.expiresAt,
    })}\n`,
  );
  return capability;
};

export const consumePurgeSafetyRecoveryAuthorization = (
  paths: DaemonPaths,
  planToken: string,
  operationId: string,
  capability: string,
  now: number,
): PurgeSafetyRecoveryPlan => {
  const plan = decodePurgeSafetyRecoveryPlan(paths, planToken);
  if (Date.parse(plan.expiresAt) <= now) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_STALE",
      "the exact purge safety recovery plan is stale",
    );
  }
  const path = authorizationPath(paths, plan.planId);
  assertPrivateNode(path, "file");
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const expectedKeys = [
    "formatVersion",
    "planId",
    "dataIdentity",
    "operationId",
    "capabilityHash",
    "issuedAt",
    "expiresAt",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expectedKeys.includes(key)) ||
    value.formatVersion !== 1 ||
    value.planId !== plan.planId ||
    value.dataIdentity !== plan.dataIdentity ||
    value.operationId !== operationId ||
    value.capabilityHash !== hash(capability) ||
    value.expiresAt !== plan.expiresAt ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt))
  ) {
    throw new LifecycleError(
      "PURGE_RECOVERY_AUTHORIZATION_INVALID",
      "the restricted recovery child has no exact one-use authorization",
    );
  }
  unlinkSync(path);
  return plan;
};

export class PurgeSafetyRecovery {
  readonly #paths: DaemonPaths;
  readonly #journal: LifecycleJournalRepository;
  readonly #nativeService: NativeService;
  readonly #now: () => number;
  readonly #launchRestrictedRecovery: (input: {
    readonly bun: string;
    readonly launcher: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Promise<void>;

  constructor(options: {
    readonly paths: DaemonPaths;
    readonly journal: LifecycleJournalRepository;
    readonly nativeService: NativeService;
    readonly now?: () => number;
    readonly launchRestrictedRecovery?: (input: {
      readonly bun: string;
      readonly launcher: string;
      readonly env: Readonly<Record<string, string>>;
    }) => Promise<void>;
  }) {
    this.#paths = options.paths;
    this.#journal = options.journal;
    this.#nativeService = options.nativeService;
    this.#now = options.now ?? Date.now;
    this.#launchRestrictedRecovery =
      options.launchRestrictedRecovery ??
      (async ({ bun, launcher, env }) => {
        const child = Bun.spawn([bun, launcher], {
          env: { ...process.env, ...env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await child.exited;
        if (exitCode !== 0) {
          throw new LifecycleError(
            "PURGE_RECOVERY_FAILED",
            `the restricted retained Daemon release exited with code ${exitCode}: ${await new Response(child.stderr).text()}`,
          );
        }
      });
  }

  #assertStoppedDisabled(): void {
    const observed = this.#nativeService.inspect();
    if (observed.process !== "stopped" || observed.automaticStart !== "disabled") {
      throw new LifecycleError(
        "PURGE_RECOVERY_SERVICE_UNSAFE",
        "restricted purge recovery requires stopped ownership and disabled automatic start",
      );
    }
  }

  readonly check = (): PurgeSafetyRecoveryCheck => {
    this.#assertStoppedDisabled();
    const dataIdentity = dataIdentityAt(this.#paths);
    const source = recoverySource(this.#paths, dataIdentity);
    const current = this.#journal.current();
    if (
      current !== undefined &&
      current.outcome === undefined &&
      (current.kind !== "remove" || current.stage !== "prepared")
    ) {
      throw new LifecycleError(
        "LIFECYCLE_OPERATION_PENDING",
        `lifecycle operation ${current.operationId} is still ${current.stage}`,
      );
    }
    if (current?.outcome === "repair-required") {
      throw new LifecycleError(
        "LIFECYCLE_REPAIR_REQUIRED",
        `lifecycle operation ${current.operationId} requires its own repair first`,
      );
    }
    if (
      current !== undefined &&
      current.outcome === undefined &&
      current.dataIdentity !== dataIdentity
    ) {
      throw new LifecycleError(
        "DAEMON_DATA_IDENTITY_CONFLICT",
        "the pending removal does not name the retained data identity",
      );
    }
    const now = this.#now();
    const issuedAt = new Date(now).toISOString();
    const withoutId = {
      formatVersion: 1,
      kind: "purge-safety-recovery",
      dataIdentity,
      ...(current === undefined || current.outcome !== undefined
        ? {}
        : { lifecycleOperationId: current.operationId }),
      sourceReleaseId: source.sourceReleaseId,
      issuedAt,
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
      expected: { automaticStart: "disabled", process: "stopped" },
    } as const;
    const plan: PurgeSafetyRecoveryPlan = {
      ...withoutId,
      planId: hash(canonical({ ...withoutId, planId: undefined })),
    };
    const encoded = Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
    return { plan, planToken: `${encoded}.${planSeal(this.#paths, encoded)}` };
  };

  readonly apply = async (planToken: string): Promise<PurgeSafetyRecoveryResult> => {
    const plan = decodePurgeSafetyRecoveryPlan(this.#paths, planToken);
    if (Date.parse(plan.expiresAt) <= this.#now()) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the exact purge safety recovery plan is stale",
      );
    }
    this.#assertStoppedDisabled();
    if (dataIdentityAt(this.#paths) !== plan.dataIdentity) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the retained Daemon data identity changed after the recovery check",
      );
    }
    const source = recoverySource(this.#paths, plan.dataIdentity);
    if (source.sourceReleaseId !== plan.sourceReleaseId) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the active managed release changed after the recovery check",
      );
    }
    const existingOperationId = plan.lifecycleOperationId ?? `purge_recovery_${plan.planId}`;
    const existing = this.#journal.read(existingOperationId);
    if (existing?.purgeSafetyEvidenceId !== undefined) {
      const evidencePath = join(this.#paths.dataRoot, "lifecycle", "purge-safety.json");
      assertPrivateNode(evidencePath, "file");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        readonly evidenceId?: string;
        readonly dataIdentity?: string;
        readonly operationId?: string;
      };
      if (
        evidence.evidenceId !== existing.purgeSafetyEvidenceId ||
        evidence.dataIdentity !== plan.dataIdentity ||
        evidence.operationId !== existing.operationId
      ) {
        throw new LifecycleError(
          "PURGE_RECOVERY_FAILED",
          "the recorded purge safety result does not match its exact retained evidence",
        );
      }
      return {
        outcome: "recovered",
        dataIdentity: plan.dataIdentity,
        evidenceId: existing.purgeSafetyEvidenceId,
        lifecycleOperationId: existing.operationId,
      };
    }
    let operation =
      plan.lifecycleOperationId === undefined
        ? this.#journal.begin({
            operationId: `purge_recovery_${plan.planId}`,
            dataIdentity: plan.dataIdentity,
            originalRequestHash: plan.planId,
            kind: "purge-recovery",
            sourceReleaseId: plan.sourceReleaseId,
            startedAt: new Date(this.#now()).toISOString(),
          })
        : this.#journal.read(plan.lifecycleOperationId);
    if (
      operation === undefined ||
      operation.dataIdentity !== plan.dataIdentity ||
      (plan.lifecycleOperationId !== undefined &&
        (operation.kind !== "remove" ||
          operation.stage !== "prepared" ||
          operation.outcome !== undefined))
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the lifecycle operation changed after the recovery check",
      );
    }
    const capability = authorizePurgeSafetyRecoveryChild(
      this.#paths,
      plan,
      operation.operationId,
      this.#now(),
    );
    await this.#launchRestrictedRecovery({
      bun: source.bun,
      launcher: source.launcher,
      env: {
        KOJO_DAEMON_CHILD: "1",
        KOJO_PURGE_SAFETY_RECOVERY_OPERATION: operation.operationId,
        KOJO_PURGE_SAFETY_RECOVERY_PLAN: planToken,
        KOJO_PURGE_SAFETY_RECOVERY_CAPABILITY: capability,
        KOJO_MANAGED_INSTALLATION: this.#paths.installationRoot,
        KOJO_DAEMON_DATA: this.#paths.dataRoot,
        KOJO_DAEMON_RUNTIME: this.#paths.runtimeRoot,
        KOJO_DAEMON_CONFIG: this.#paths.configurationRoot,
        KOJO_DAEMON_CACHE: this.#paths.cacheRoot,
      },
    });
    this.#assertStoppedDisabled();
    const evidencePath = join(this.#paths.dataRoot, "lifecycle", "purge-safety.json");
    assertPrivateNode(evidencePath, "file");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      readonly evidenceId?: string;
      readonly dataIdentity?: string;
      readonly operationId?: string;
    };
    if (
      typeof evidence.evidenceId !== "string" ||
      evidence.dataIdentity !== plan.dataIdentity ||
      evidence.operationId !== operation.operationId
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_FAILED",
        "the restricted Daemon release did not produce exact safety evidence",
      );
    }
    operation = this.#journal.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: plan.lifecycleOperationId === undefined ? "completed" : operation.stage,
      updatedAt: new Date(this.#now()).toISOString(),
      changes: {
        purgeSafetyEvidenceId: evidence.evidenceId,
        ...(plan.lifecycleOperationId === undefined ? { outcome: "succeeded" as const } : {}),
      },
    });
    return {
      outcome: "recovered",
      dataIdentity: plan.dataIdentity,
      evidenceId: evidence.evidenceId,
      lifecycleOperationId: operation.operationId,
    };
  };
}
