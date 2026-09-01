export type RetentionDuration = number | "indefinite";

export interface DaemonConfiguration {
  readonly limits: {
    readonly executingRuns: number;
    readonly newStartQueue: number;
  };
  readonly runner: {
    readonly idleMs: number;
    readonly handshakeMs: number;
    readonly heartbeatMs: number;
    readonly unhealthyMs: number;
    readonly cleanupMs: number;
    readonly recoveryCheckMs: number;
    readonly restartDelaysMs: ReadonlyArray<number>;
    readonly healthyResetMs: number;
  };
  readonly daemon: {
    readonly readinessMs: number;
    readonly cleanupMs: number;
    readonly restartDelaysMs: ReadonlyArray<number>;
    readonly healthyResetMs: number;
  };
  readonly retention: {
    readonly runHistoryMs: RetentionDuration;
    readonly traceMs: RetentionDuration;
    readonly artifactMs: RetentionDuration;
  };
}

export interface ProjectConfiguration {
  readonly limits: {
    readonly executingRuns: number;
    readonly newStartQueue: number;
  };
}

export const daemonConfigurationDefaults: DaemonConfiguration = {
  limits: { executingRuns: 4, newStartQueue: 1_000 },
  runner: {
    idleMs: 60_000,
    handshakeMs: 10_000,
    heartbeatMs: 5_000,
    unhealthyMs: 30_000,
    cleanupMs: 30_000,
    recoveryCheckMs: 60_000,
    restartDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
    healthyResetMs: 300_000,
  },
  daemon: {
    readinessMs: 60_000,
    cleanupMs: 30_000,
    restartDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
    healthyResetMs: 300_000,
  },
  retention: {
    runHistoryMs: "indefinite",
    traceMs: "indefinite",
    artifactMs: "indefinite",
  },
};

export const projectConfigurationDefaults: ProjectConfiguration = {
  limits: { executingRuns: 1, newStartQueue: 100 },
};

export type DaemonSettingPath =
  | "limits.executingRuns"
  | "limits.newStartQueue"
  | "runner.idleMs"
  | "runner.handshakeMs"
  | "runner.heartbeatMs"
  | "runner.unhealthyMs"
  | "runner.cleanupMs"
  | "runner.recoveryCheckMs"
  | "runner.restartDelaysMs"
  | "runner.healthyResetMs"
  | "daemon.readinessMs"
  | "daemon.cleanupMs"
  | "daemon.restartDelaysMs"
  | "daemon.healthyResetMs"
  | "retention.runHistoryMs"
  | "retention.traceMs"
  | "retention.artifactMs";

export type ProjectSettingPath = "limits.executingRuns" | "limits.newStartQueue";
export type ConfigurationValue = number | ReadonlyArray<number> | "indefinite";

export interface ConfigurationChange {
  readonly path: DaemonSettingPath | ProjectSettingPath;
  readonly value: ConfigurationValue;
  readonly reset: boolean;
}

export interface ConfigurationFieldStatus {
  readonly path: string;
  readonly effective: ConfigurationValue;
  readonly default: ConfigurationValue;
  readonly scope: "daemon" | "project";
  readonly activation: "immediate" | "future-attempt" | "lifecycle-restart";
  readonly pending?: ConfigurationValue;
}

export interface ConfigurationStatus {
  readonly formatVersion: 1;
  readonly scope: "daemon" | "project";
  readonly projectId?: string;
  readonly stateVersion: number;
  readonly restartRequired: boolean;
  readonly fields: ReadonlyArray<ConfigurationFieldStatus>;
}

export interface RetentionImpact {
  readonly runIds: ReadonlyArray<string>;
  readonly traceRunIds: ReadonlyArray<string>;
  readonly artifactIds: ReadonlyArray<string>;
  readonly protectedRunIds: ReadonlyArray<string>;
  readonly stateFingerprint: string;
}

export interface ConfigurationMaintenancePlan {
  readonly formatVersion: 1;
  readonly planId: string;
  readonly kind: "configuration-retention";
  readonly dataIdentity: string;
  readonly requestHash: string;
  readonly affectedScope: "daemon" | `project:${string}`;
  readonly expectedStateVersion: number;
  readonly expectedDataState: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly changes: ReadonlyArray<ConfigurationChange>;
  readonly impact: RetentionImpact;
}

export interface ConfigurationCheck {
  readonly formatVersion: 1;
  readonly proposed: ConfigurationStatus;
  readonly plan?: ConfigurationMaintenancePlan;
}

export interface RetentionCollectionResult {
  readonly runs: ReadonlyArray<string>;
  readonly traces: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
}

export interface ConfigurationApplyResult {
  readonly formatVersion: 1;
  readonly status: ConfigurationStatus;
  readonly collection: RetentionCollectionResult;
}
