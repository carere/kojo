export interface ManagedReleaseManifest {
  readonly formatVersion: 1;
  readonly releaseId: string;
  readonly kojoVersion: string;
  readonly bunVersion: string;
  readonly createdAt: string;
}
