import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { daemonConfigurationDefaults } from "../models/Configuration.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

export interface DaemonSupervisionPolicy {
  readonly restartDelaysMs: ReadonlyArray<number>;
  readonly healthyResetMs: number;
}

interface SupervisionAttempt {
  readonly attemptId: string;
  readonly phase: "waiting" | "running";
  readonly notBefore: string;
  readonly budgetIndex?: number;
  readonly startedAt?: string;
  readonly readyAt?: string;
  readonly operationSucceededAt?: string;
  readonly healthyResetMs: number;
  readonly planned: boolean;
}

interface FailureDiagnostic {
  readonly attemptId: string;
  readonly failedAt: string;
  readonly detail: string;
}

export interface DaemonSupervisionRepairPlan {
  readonly planId: string;
  readonly expectedState: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DaemonSupervisionRepairReceipt {
  readonly planId: string;
  readonly expectedState: string;
  readonly appliedAt: string;
}

interface StoredSupervisionState {
  readonly formatVersion: 1;
  readonly revision: number;
  readonly policy: DaemonSupervisionPolicy;
  readonly cycleActive: boolean;
  readonly nextRestartIndex: number;
  readonly exhausted: boolean;
  readonly skipNextDelay: boolean;
  readonly attempt?: SupervisionAttempt | undefined;
  readonly lastFailure?: FailureDiagnostic;
  readonly repairedAt?: string | undefined;
  readonly repairPlan?: DaemonSupervisionRepairPlan | undefined;
  readonly lastRepair?: DaemonSupervisionRepairReceipt;
}

export interface DaemonSupervisionStatus {
  readonly formatVersion: 1;
  readonly stateVersion: number;
  readonly state: "idle" | "waiting" | "running" | "exhausted";
  readonly policy: DaemonSupervisionPolicy;
  readonly nextRestartIndex: number;
  readonly restartAttemptsRemaining: number;
  readonly repairRequired: boolean;
  readonly attempt?: SupervisionAttempt;
  readonly lastFailure?: FailureDiagnostic;
  readonly repairedAt?: string;
  readonly repairPlan?: DaemonSupervisionRepairPlan;
  readonly lastRepair?: DaemonSupervisionRepairReceipt;
}

export type PreparedDaemonAttempt =
  | {
      readonly outcome: "scheduled";
      readonly attemptId: string;
      readonly delayMs: number;
    }
  | { readonly outcome: "exhausted"; readonly status: DaemonSupervisionStatus };

interface LockHandle {
  readonly release: () => void;
}

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const hasOnlyKeys = (value: object, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const policyOf = (value: unknown): DaemonSupervisionPolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the Daemon policy is invalid");
  }
  const policy = value as Partial<DaemonSupervisionPolicy>;
  if (
    !hasOnlyKeys(value, ["restartDelaysMs", "healthyResetMs"]) ||
    !Array.isArray(policy.restartDelaysMs) ||
    policy.restartDelaysMs.length === 0 ||
    policy.restartDelaysMs.length > 16 ||
    !policy.restartDelaysMs.every(positiveInteger) ||
    !positiveInteger(policy.healthyResetMs)
  ) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the Daemon policy is invalid");
  }
  return {
    restartDelaysMs: [...policy.restartDelaysMs],
    healthyResetMs: policy.healthyResetMs,
  };
};

const validTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

const attemptOf = (value: unknown): SupervisionAttempt | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the Daemon attempt is invalid");
  }
  const attempt = value as Partial<SupervisionAttempt>;
  if (
    !hasOnlyKeys(value, [
      "attemptId",
      "phase",
      "notBefore",
      "budgetIndex",
      "startedAt",
      "readyAt",
      "operationSucceededAt",
      "healthyResetMs",
      "planned",
    ]) ||
    !validId(attempt.attemptId) ||
    (attempt.phase !== "waiting" && attempt.phase !== "running") ||
    !validTime(attempt.notBefore) ||
    (attempt.budgetIndex !== undefined &&
      (!Number.isSafeInteger(attempt.budgetIndex) || Number(attempt.budgetIndex) < 0)) ||
    (attempt.phase === "running"
      ? !validTime(attempt.startedAt)
      : attempt.startedAt !== undefined) ||
    (attempt.readyAt !== undefined &&
      (attempt.phase !== "running" || !validTime(attempt.readyAt))) ||
    (attempt.operationSucceededAt !== undefined &&
      (attempt.phase !== "running" ||
        attempt.readyAt === undefined ||
        !validTime(attempt.operationSucceededAt))) ||
    !positiveInteger(attempt.healthyResetMs) ||
    typeof attempt.planned !== "boolean"
  ) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the Daemon attempt is invalid");
  }
  return attempt as SupervisionAttempt;
};

const stateOf = (value: unknown): StoredSupervisionState => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the launcher state is invalid");
  }
  const state = value as Partial<StoredSupervisionState>;
  const policy = policyOf(state.policy);
  const attempt = attemptOf(state.attempt);
  if (
    !hasOnlyKeys(value, [
      "formatVersion",
      "revision",
      "policy",
      "cycleActive",
      "nextRestartIndex",
      "exhausted",
      "skipNextDelay",
      "attempt",
      "lastFailure",
      "repairedAt",
      "repairPlan",
      "lastRepair",
    ]) ||
    state.formatVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 1 ||
    typeof state.cycleActive !== "boolean" ||
    !Number.isSafeInteger(state.nextRestartIndex) ||
    Number(state.nextRestartIndex) < 0 ||
    typeof state.exhausted !== "boolean" ||
    typeof state.skipNextDelay !== "boolean" ||
    (!state.cycleActive && Number(state.nextRestartIndex) !== 0) ||
    Number(state.nextRestartIndex) > policy.restartDelaysMs.length ||
    (state.exhausted && Number(state.nextRestartIndex) < policy.restartDelaysMs.length) ||
    (!state.exhausted &&
      Number(state.nextRestartIndex) >= policy.restartDelaysMs.length &&
      attempt === undefined) ||
    (state.exhausted && attempt !== undefined) ||
    (attempt?.budgetIndex !== undefined &&
      (!state.cycleActive || attempt.budgetIndex !== state.nextRestartIndex)) ||
    (attempt !== undefined && state.skipNextDelay) ||
    (state.lastFailure !== undefined &&
      (!hasOnlyKeys(state.lastFailure, ["attemptId", "failedAt", "detail"]) ||
        !validId(state.lastFailure.attemptId) ||
        !validTime(state.lastFailure.failedAt) ||
        typeof state.lastFailure.detail !== "string")) ||
    (state.repairedAt !== undefined && !validTime(state.repairedAt)) ||
    (state.repairPlan !== undefined &&
      (!state.exhausted ||
        !hasOnlyKeys(state.repairPlan, ["planId", "expectedState", "issuedAt", "expiresAt"]) ||
        !validId(state.repairPlan.planId) ||
        !/^[a-f0-9]{64}$/.test(state.repairPlan.expectedState) ||
        !validTime(state.repairPlan.issuedAt) ||
        !validTime(state.repairPlan.expiresAt))) ||
    (state.lastRepair !== undefined &&
      (!hasOnlyKeys(state.lastRepair, ["planId", "expectedState", "appliedAt"]) ||
        !validId(state.lastRepair.planId) ||
        !/^[a-f0-9]{64}$/.test(state.lastRepair.expectedState) ||
        !validTime(state.lastRepair.appliedAt)))
  ) {
    throw new LifecycleError("DAEMON_SUPERVISION_DAMAGED", "the launcher state is invalid");
  }
  return {
    ...(state as StoredSupervisionState),
    policy,
    ...(attempt === undefined ? {} : { attempt }),
  };
};

const initialState = (): StoredSupervisionState => ({
  formatVersion: 1,
  revision: 0,
  policy: {
    restartDelaysMs: [...daemonConfigurationDefaults.daemon.restartDelaysMs],
    healthyResetMs: daemonConfigurationDefaults.daemon.healthyResetMs,
  },
  cycleActive: false,
  nextRestartIndex: 0,
  exhausted: false,
  skipNextDelay: false,
});

const stateIdentity = (state: StoredSupervisionState): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        policy: state.policy,
        cycleActive: state.cycleActive,
        nextRestartIndex: state.nextRestartIndex,
        exhausted: state.exhausted,
        skipNextDelay: state.skipNextDelay,
        attempt: state.attempt,
        lastFailure: state.lastFailure,
        repairedAt: state.repairedAt,
        lastRepair: state.lastRepair,
      }),
    )
    .digest("hex");

const libraryName = (): string => {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no supported advisory file lock");
};

const fileLock = (path: string, nonblocking: boolean): LockHandle => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(descriptor, 0o600);
  const stat = fstatSync(descriptor);
  if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    closeSync(descriptor);
    throw new LifecycleError("UNSAFE_DAEMON_SUPERVISION", "the launcher lock is not private");
  }
  const library = dlopen(libraryName(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (library.symbols.flock(descriptor, 2 | (nonblocking ? 4 : 0)) !== 0) {
    library.close();
    closeSync(descriptor);
    throw new LifecycleError(
      "DAEMON_LAUNCHER_ALREADY_RUNNING",
      "another managed launcher owns this Daemon supervision state",
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

export class ManagedDaemonSupervision {
  readonly #root: string;
  readonly #statePath: string;
  readonly #stateLockPath: string;
  readonly #launcherLockPath: string;
  readonly #now: () => number;
  readonly #readOnly: boolean;

  constructor(
    dataRoot: string,
    options: { readonly now?: () => number; readonly readOnly?: boolean } = {},
  ) {
    this.#root = join(dataRoot, "launcher-supervision");
    this.#statePath = join(this.#root, "state.json");
    this.#stateLockPath = join(this.#root, "state.lock");
    this.#launcherLockPath = join(this.#root, "launcher.lock");
    this.#now = options.now ?? Date.now;
    this.#readOnly = options.readOnly ?? false;
    if (this.#readOnly) {
      if (existsSync(this.#root)) assertPrivateNode(this.#root, "directory");
    } else ensurePrivateDirectory(this.#root);
  }

  readonly acquireLauncherOwnership = (): LockHandle => fileLock(this.#launcherLockPath, true);

  readonly status = (): DaemonSupervisionStatus =>
    this.#readOnly
      ? this.#statusOf(this.#read())
      : this.#withState((state) => ({ state, result: this.#statusOf(state), write: false }));

  readonly prepareAttempt = (): PreparedDaemonAttempt =>
    this.#withState<PreparedDaemonAttempt>((input) => {
      let state = this.#recoverAbandoned(input);
      if (state.exhausted) {
        return {
          state,
          result: { outcome: "exhausted", status: this.#statusOf(state) },
          write: state !== input,
        };
      }
      if (state.attempt?.phase === "waiting") {
        return {
          state,
          result: {
            outcome: "scheduled",
            attemptId: state.attempt.attemptId,
            delayMs: Math.max(0, Date.parse(state.attempt.notBefore) - this.#now()),
          },
          write: state !== input,
        };
      }
      const useBudget = state.cycleActive && !state.skipNextDelay;
      if (useBudget && state.nextRestartIndex >= state.policy.restartDelaysMs.length) {
        state = { ...state, exhausted: true, repairPlan: undefined };
        return {
          state,
          result: { outcome: "exhausted", status: this.#statusOf(state) },
          write: true,
        };
      }
      const budgetIndex = useBudget ? state.nextRestartIndex : undefined;
      const delayMs =
        budgetIndex === undefined ? 0 : (state.policy.restartDelaysMs[budgetIndex] ?? 0);
      const attemptId = crypto.randomUUID();
      state = {
        ...state,
        exhausted: false,
        skipNextDelay: false,
        repairPlan: undefined,
        attempt: {
          attemptId,
          phase: "waiting",
          notBefore: new Date(this.#now() + delayMs).toISOString(),
          ...(budgetIndex === undefined ? {} : { budgetIndex }),
          healthyResetMs: state.policy.healthyResetMs,
          planned: false,
        },
      };
      return { state, result: { outcome: "scheduled", attemptId, delayMs }, write: true };
    });

  readonly startAttempt = (attemptId: string): void =>
    this.#changeAttempt(attemptId, (attempt) => {
      if (attempt.phase !== "waiting" || this.#now() < Date.parse(attempt.notBefore)) {
        throw new LifecycleError(
          "DAEMON_ATTEMPT_NOT_READY",
          "the managed Daemon attempt is not ready to start",
        );
      }
      return { ...attempt, phase: "running", startedAt: new Date(this.#now()).toISOString() };
    });

  readonly recordReady = (attemptId: string): void =>
    this.#changeAttempt(attemptId, (attempt) => {
      if (attempt.phase !== "running") {
        throw new LifecycleError("DAEMON_ATTEMPT_NOT_RUNNING", "the Daemon attempt is not running");
      }
      return { ...attempt, readyAt: attempt.readyAt ?? new Date(this.#now()).toISOString() };
    });

  readonly recordOperationSuccess = (attemptId: string): void =>
    this.#changeAttempt(attemptId, (attempt) => {
      if (attempt.phase !== "running" || attempt.readyAt === undefined) {
        throw new LifecycleError(
          "DAEMON_ATTEMPT_NOT_READY",
          "a ready managed Daemon attempt must own the successful operation",
        );
      }
      return {
        ...attempt,
        operationSucceededAt: attempt.operationSucceededAt ?? new Date(this.#now()).toISOString(),
      };
    });

  readonly recordPlannedStop = (attemptId: string): void =>
    this.#changeAttempt(attemptId, (attempt) => ({ ...attempt, planned: true }));

  readonly activatePolicy = (attemptId: string, policy: DaemonSupervisionPolicy): void => {
    const checked = policyOf(policy);
    this.#withState((state) => {
      if (state.attempt?.attemptId !== attemptId || state.attempt.phase !== "running") {
        throw new LifecycleError(
          "DAEMON_ATTEMPT_MISMATCH",
          "the active Daemon attempt does not own policy activation",
        );
      }
      const mappedIndex = Math.min(
        state.nextRestartIndex,
        state.attempt.budgetIndex === undefined
          ? checked.restartDelaysMs.length
          : checked.restartDelaysMs.length - 1,
      );
      return {
        state: {
          ...state,
          policy: checked,
          nextRestartIndex: mappedIndex,
          attempt: {
            ...state.attempt,
            ...(state.attempt.budgetIndex === undefined ? {} : { budgetIndex: mappedIndex }),
          },
          repairPlan: undefined,
        },
        result: undefined,
        write: true,
      };
    });
  };

  readonly finishAttempt = (
    attemptId: string,
    outcome: { readonly planned?: boolean; readonly detail: string },
  ): DaemonSupervisionStatus =>
    this.#withState((state) => {
      const attempt = state.attempt;
      if (attempt?.attemptId !== attemptId) {
        throw new LifecycleError(
          "DAEMON_ATTEMPT_MISMATCH",
          "the completed Daemon attempt is not current",
        );
      }
      const finished = this.#finish(state, attempt, outcome.planned === true, outcome.detail);
      return { state: finished, result: this.#statusOf(finished), write: true };
    });

  readonly checkRepair = (): DaemonSupervisionStatus =>
    this.#withState((state) => {
      if (!state.exhausted) return { state, result: this.#statusOf(state), write: false };
      const now = this.#now();
      const repairPlan: DaemonSupervisionRepairPlan = {
        planId: crypto.randomUUID(),
        expectedState: stateIdentity(state),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
      };
      const planned = { ...state, repairPlan };
      return { state: planned, result: this.#statusOf(planned), write: true };
    });

  readonly applyRepair = (planId: string): DaemonSupervisionStatus =>
    this.#withState((state) => {
      if (state.lastRepair?.planId === planId) {
        return { state, result: this.#statusOf(state), write: false };
      }
      const plan = state.repairPlan;
      if (
        !state.exhausted ||
        plan === undefined ||
        plan.planId !== planId ||
        this.#now() > Date.parse(plan.expiresAt) ||
        plan.expectedState !== stateIdentity({ ...state, repairPlan: undefined })
      ) {
        throw new LifecycleError(
          "DAEMON_REPAIR_PLAN_INVALID",
          "the exact unexpired Daemon supervision repair plan is not current",
        );
      }
      const repaired: StoredSupervisionState = {
        ...state,
        cycleActive: false,
        nextRestartIndex: 0,
        exhausted: false,
        skipNextDelay: false,
        attempt: undefined,
        repairedAt: new Date(this.#now()).toISOString(),
        repairPlan: undefined,
        lastRepair: {
          planId: plan.planId,
          expectedState: plan.expectedState,
          appliedAt: new Date(this.#now()).toISOString(),
        },
      };
      return { state: repaired, result: this.#statusOf(repaired), write: true };
    });

  #recoverAbandoned(state: StoredSupervisionState): StoredSupervisionState {
    const attempt = state.attempt;
    if (attempt?.phase !== "running") return state;
    return this.#finish(
      state,
      attempt,
      attempt.planned,
      "the managed launcher or Daemon exited without recording an outcome",
    );
  }

  #finish(
    state: StoredSupervisionState,
    attempt: SupervisionAttempt,
    planned: boolean,
    detail: string,
  ): StoredSupervisionState {
    if (planned || attempt.planned) {
      const exhausted = state.nextRestartIndex >= state.policy.restartDelaysMs.length;
      return {
        ...state,
        exhausted,
        skipNextDelay: true,
        attempt: undefined,
        repairPlan: undefined,
      };
    }
    const failedAt = new Date(this.#now()).toISOString();
    const healthy =
      attempt.readyAt !== undefined &&
      attempt.operationSucceededAt !== undefined &&
      this.#now() -
        Math.max(Date.parse(attempt.readyAt), Date.parse(attempt.operationSucceededAt)) >=
        attempt.healthyResetMs;
    const nextRestartIndex = Math.min(
      healthy
        ? 0
        : attempt.budgetIndex === undefined
          ? state.nextRestartIndex
          : attempt.budgetIndex + 1,
      state.policy.restartDelaysMs.length,
    );
    const exhausted = nextRestartIndex >= state.policy.restartDelaysMs.length;
    return {
      ...state,
      cycleActive: true,
      nextRestartIndex,
      exhausted,
      skipNextDelay: false,
      attempt: undefined,
      lastFailure: {
        attemptId: attempt.attemptId,
        failedAt,
        detail: detail.slice(0, 1_024),
      },
      repairPlan: undefined,
    };
  }

  #changeAttempt(
    attemptId: string,
    change: (attempt: SupervisionAttempt) => SupervisionAttempt,
  ): void {
    this.#withState((state) => {
      if (state.attempt?.attemptId !== attemptId) {
        throw new LifecycleError("DAEMON_ATTEMPT_MISMATCH", "the Daemon attempt is not current");
      }
      return {
        state: { ...state, attempt: change(state.attempt), repairPlan: undefined },
        result: undefined,
        write: true,
      };
    });
  }

  #statusOf(state: StoredSupervisionState): DaemonSupervisionStatus {
    return {
      formatVersion: 1,
      stateVersion: state.revision,
      state: state.exhausted
        ? "exhausted"
        : state.attempt?.phase === "waiting"
          ? "waiting"
          : state.attempt?.phase === "running"
            ? "running"
            : "idle",
      policy: state.policy,
      nextRestartIndex: state.nextRestartIndex,
      restartAttemptsRemaining: Math.max(
        0,
        state.policy.restartDelaysMs.length - state.nextRestartIndex,
      ),
      repairRequired: state.exhausted,
      ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
      ...(state.lastFailure === undefined ? {} : { lastFailure: state.lastFailure }),
      ...(state.repairedAt === undefined ? {} : { repairedAt: state.repairedAt }),
      ...(state.repairPlan === undefined ? {} : { repairPlan: state.repairPlan }),
      ...(state.lastRepair === undefined ? {} : { lastRepair: state.lastRepair }),
    };
  }

  #read(): StoredSupervisionState {
    if (!existsSync(this.#statePath)) return initialState();
    assertPrivateNode(this.#statePath, "file");
    try {
      return stateOf(JSON.parse(readFileSync(this.#statePath, "utf8")) as unknown);
    } catch (cause) {
      if (cause instanceof LifecycleError) throw cause;
      throw new LifecycleError(
        "DAEMON_SUPERVISION_DAMAGED",
        "the launcher state is not valid JSON",
        cause,
      );
    }
  }

  #write(state: StoredSupervisionState): StoredSupervisionState {
    const stored = stateOf(JSON.parse(JSON.stringify({ ...state, revision: state.revision + 1 })));
    atomicPrivateFile(this.#statePath, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  #withState<A>(
    use: (state: StoredSupervisionState) => {
      readonly state: StoredSupervisionState;
      readonly result: A;
      readonly write: boolean;
    },
  ): A {
    const lock = fileLock(this.#stateLockPath, false);
    try {
      const selected = use(this.#read());
      if (!selected.write) return selected.result;
      const written = this.#write(selected.state);
      if (
        typeof selected.result === "object" &&
        selected.result !== null &&
        "formatVersion" in selected.result &&
        "stateVersion" in selected.result
      ) {
        return this.#statusOf(written) as A;
      }
      return selected.result;
    } finally {
      lock.release();
    }
  }
}
