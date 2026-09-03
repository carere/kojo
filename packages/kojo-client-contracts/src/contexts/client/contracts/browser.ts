export interface BrowserSessionRequest {
  readonly grant: string;
}

export interface BrowserSessionResponse {
  readonly formatVersion: 1;
  readonly credential: string;
  readonly expiresAt: string;
  readonly instanceId: string;
}

export interface DaemonDocument {
  readonly formatVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly releaseId: string;
  readonly packageVersion: string;
  readonly bunVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly startedAt: string;
  readonly accessExpiresAt: string;
  readonly projectCount: number;
}
