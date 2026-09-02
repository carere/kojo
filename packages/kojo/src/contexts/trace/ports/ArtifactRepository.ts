export interface PublishedArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
}

export interface ArtifactRepository {
  readonly begin: (input: {
    readonly transferId: string;
    readonly runId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly totalSize: number;
    readonly sha256: string;
  }) => void;
  readonly write: (
    transferId: string,
    ordinal: number,
    data: Uint8Array,
    declaration?: { readonly totalSize: number; readonly sha256: string },
  ) => void;
  readonly finish: (transferId: string, publishedAt: string) => PublishedArtifact;
  readonly list: (runId: string) => ReadonlyArray<PublishedArtifact>;
}
