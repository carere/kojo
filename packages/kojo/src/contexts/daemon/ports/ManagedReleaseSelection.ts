/** Controller-owned active managed release selection. */
export interface ManagedReleaseSelection {
  readonly read: () => string;
  readonly select: (expectedReleaseId: string, nextReleaseId: string) => string;
}
