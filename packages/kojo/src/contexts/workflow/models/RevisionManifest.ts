export interface RevisionFile {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface RevisionPackage {
  readonly packageId: string;
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyArray<RevisionFile>;
}

export interface RevisionResolution {
  readonly fromPackageId: string;
  readonly specifier: string;
  readonly targetPackageId: string;
  readonly subpath: string;
}

/** The credential-free identity document for one immutable Workflow Revision. */
export interface RevisionManifest {
  readonly formatVersion: 1;
  readonly workflowName: string;
  readonly entrySource: string;
  readonly sources: ReadonlyArray<RevisionFile>;
  readonly assets: ReadonlyArray<RevisionFile>;
  readonly sharedConfiguration: ReadonlyArray<RevisionFile>;
  readonly packages: ReadonlyArray<RevisionPackage>;
  readonly resolution: ReadonlyArray<RevisionResolution>;
  readonly runtime: {
    readonly packageId: string;
    readonly manifestHash: string;
    readonly runner: string;
    readonly protocols: ReadonlyArray<number>;
    readonly requiredFeatures: ReadonlyArray<string>;
  };
  readonly sharedEffect: {
    readonly packageId: string;
    readonly resolvedEntryHash: string;
  };
  readonly compatibility: {
    readonly bun: string;
    readonly os: string;
    readonly arch: string;
    readonly nativeContent: boolean;
  };
  readonly dependencyEvidence: {
    readonly lockfileHashes: ReadonlyArray<RevisionFile>;
    readonly resolutionInputHashes: ReadonlyArray<RevisionFile>;
  };
}

export interface CapturedWorkflowRevision {
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly manifest: RevisionManifest;
  readonly publishedPath: string;
}
