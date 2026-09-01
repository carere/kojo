import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
import { activeConsoleRelease } from "../services/activeConsoleRelease.ts";
import { assertPrivateNode, atomicPrivateFile } from "../services/secureHostPath.ts";
import { readVerifiedPurgeSafetyEvidence } from "./DaemonDataPurger.ts";
import { readCheckedManagedRelease } from "./ManagedInstallation.ts";
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

const planPath = (paths: DaemonPaths): string =>
  join(paths.configurationRoot, "purge-control", "recovery-plan.json");

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
  try {
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
  } catch (capsuleCause) {
    try {
      const release = activeConsoleRelease(paths);
      readCheckedManagedRelease(paths, release.releaseId);
      const releaseRoot = join(paths.installationRoot, "releases", release.releaseId);
      return {
        sourceReleaseId: release.releaseId,
        bun: join(releaseRoot, "runtime", "bun"),
        launcher: join(releaseRoot, "launcher.js"),
      };
    } catch {
      throw capsuleCause;
    }
  }
};

const decodePlan = (token: string): PurgeSafetyRecoveryPlan => {
  let plan: PurgeSafetyRecoveryPlan;
  try {
    plan = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as PurgeSafetyRecoveryPlan;
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
    !/^[a-f0-9]{64}$/.test(plan.planId) ||
    plan.planId !== hash(canonical({ ...plan, planId: undefined })) ||
    plan.dataIdentity.length === 0 ||
    (plan.lifecycleOperationId !== undefined &&
      (typeof plan.lifecycleOperationId !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(plan.lifecycleOperationId))) ||
    !/^[A-Za-z0-9._-]+$/.test(plan.sourceReleaseId) ||
    plan.expected.automaticStart !== "disabled" ||
    plan.expected.process !== "stopped" ||
    !Number.isFinite(Date.parse(plan.issuedAt)) ||
    !Number.isFinite(Date.parse(plan.expiresAt))
  ) {
    throw new LifecycleError(
      "PURGE_RECOVERY_PLAN_INVALID",
      "the purge safety recovery plan is invalid",
    );
  }
  return plan;
};

export class PurgeSafetyRecovery {
  readonly #paths: DaemonPaths;
  readonly #journal: LifecycleJournalRepository;
  readonly #nativeService: NativeService;
  readonly #now: () => number;

  constructor(options: {
    readonly paths: DaemonPaths;
    readonly journal: LifecycleJournalRepository;
    readonly nativeService: NativeService;
    readonly now?: () => number;
  }) {
    this.#paths = options.paths;
    this.#journal = options.journal;
    this.#nativeService = options.nativeService;
    this.#now = options.now ?? Date.now;
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
    const issuedAt = new Date(this.#now()).toISOString();
    const withoutId = {
      formatVersion: 1,
      kind: "purge-safety-recovery",
      dataIdentity,
      ...(current === undefined || current.outcome !== undefined
        ? {}
        : { lifecycleOperationId: current.operationId }),
      sourceReleaseId: source.sourceReleaseId,
      issuedAt,
      expiresAt: new Date(this.#now() + 10 * 60_000).toISOString(),
      expected: { automaticStart: "disabled", process: "stopped" },
    } as const;
    const plan: PurgeSafetyRecoveryPlan = {
      ...withoutId,
      planId: hash(canonical({ ...withoutId, planId: undefined })),
    };
    atomicPrivateFile(planPath(this.#paths), `${JSON.stringify(plan)}\n`);
    return { plan, planToken: Buffer.from(JSON.stringify(plan), "utf8").toString("base64url") };
  };

  readonly apply = async (planToken: string): Promise<PurgeSafetyRecoveryResult> => {
    const plan = decodePlan(planToken);
    const path = planPath(this.#paths);
    if (!existsSync(path)) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the exact purge safety recovery plan is not retained",
      );
    }
    assertPrivateNode(path, "file");
    const retained = JSON.parse(readFileSync(path, "utf8")) as PurgeSafetyRecoveryPlan;
    if (canonical(retained) !== canonical(plan) || Date.parse(plan.expiresAt) <= this.#now()) {
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
    const child = Bun.spawn([source.bun, source.launcher], {
      env: {
        ...process.env,
        KOJO_DAEMON_CHILD: "1",
        KOJO_PURGE_SAFETY_RECOVERY_OPERATION: operation.operationId,
        KOJO_MANAGED_INSTALLATION: this.#paths.installationRoot,
        KOJO_DAEMON_DATA: this.#paths.dataRoot,
        KOJO_DAEMON_RUNTIME: this.#paths.runtimeRoot,
        KOJO_DAEMON_CONFIG: this.#paths.configurationRoot,
        KOJO_DAEMON_CACHE: this.#paths.cacheRoot,
      },
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
