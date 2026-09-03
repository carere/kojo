export class ProjectStoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retry: "lookupOriginal" | "never" | "safe";
  readonly remedy: string;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly retry: "lookupOriginal" | "never" | "safe";
    readonly remedy: string;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProjectStoreError";
    this.code = options.code;
    this.status = options.status;
    this.retry = options.retry;
    this.remedy = options.remedy;
  }
}
