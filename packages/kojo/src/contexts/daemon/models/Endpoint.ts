export interface DaemonEndpoint {
  readonly formatVersion: 1;
  readonly dataIdentity: string;
  readonly instanceId: string;
  readonly socketPath: string;
  readonly ready: true;
}
