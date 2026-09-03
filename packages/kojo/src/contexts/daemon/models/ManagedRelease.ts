export interface ManagedReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface ManagedReleaseCompatibility {
  readonly dataFormats: ReadonlyArray<number>;
  readonly revisionFormats: ReadonlyArray<number>;
  readonly runnerProtocols: ReadonlyArray<number>;
  readonly requiredFeatures: ReadonlyArray<string>;
}

export interface ManagedReleaseMigration {
  readonly fromDataFormat: number;
  readonly toDataFormat: number;
  readonly rollback: "preserved" | "lost";
  readonly description: string;
}

/** The exact immutable managed payload used by upgrade preflight. */
export interface CheckedManagedReleaseManifest {
  readonly formatVersion: 2;
  readonly releaseId: string;
  readonly kojoVersion: string;
  readonly bunVersion: string;
  readonly createdAt: string;
  readonly host: {
    readonly os: string;
    readonly arch: string;
  };
  readonly compatibility: ManagedReleaseCompatibility;
  readonly migration?: ManagedReleaseMigration;
  readonly files: ReadonlyArray<ManagedReleaseFile>;
}
