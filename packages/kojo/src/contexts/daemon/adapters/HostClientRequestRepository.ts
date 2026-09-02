import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  decodeMutationEnvelope,
  type MutationEnvelope,
} from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import {
  encodeCanonicalJson,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { ProjectStoreError } from "../../project/models/ProjectStoreError.ts";
import type {
  ClientRequestRepository,
  ClientRequestResolution,
  RetainedClientRequest as RetainedClientRequestView,
} from "../ports/ClientRequestRepository.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

const validRequestId = /^[A-Za-z0-9_-]+$/;
const validDataIdentity = /^[A-Za-z0-9_-]+$/;

interface FullClientRequest {
  readonly request: MutationEnvelope;
  readonly sha256: string;
  readonly createdAt: string;
  readonly subject: {
    readonly operation: string;
    readonly targetKind: string;
  };
  readonly resolution?: ClientRequestResolution;
}

interface CompactedClientRequest {
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly sha256: string;
  readonly createdAt: string;
  readonly subject: FullClientRequest["subject"];
  readonly resolution: ClientRequestResolution;
}

type StoredClientRequest = FullClientRequest | CompactedClientRequest;

const fullRetentionMillis = 30 * 24 * 60 * 60 * 1_000;

const validResolution = (value: unknown): value is ClientRequestResolution => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const resolution = value as Partial<ClientRequestResolution>;
  const reference = resolution.resultReference;
  return (
    typeof resolution.resolvedAt === "string" &&
    Number.isFinite(Date.parse(resolution.resolvedAt)) &&
    (resolution.status === "accepted" || resolution.status === "committed") &&
    reference !== undefined &&
    reference.identityVersion === 1 &&
    typeof reference.kind === "string" &&
    Array.isArray(reference.parts) &&
    reference.parts.every((part) => typeof part === "string")
  );
};

export class HostClientRequestRepository implements ClientRequestRepository {
  readonly #directory: string;
  readonly #dataIdentity: string;
  readonly #now: () => number;

  constructor(directory: string, dataIdentity: string, now: () => number = Date.now) {
    if (!validDataIdentity.test(dataIdentity)) throw new Error("The data identity is invalid.");
    ensurePrivateDirectory(directory);
    this.#directory = join(directory, dataIdentity);
    ensurePrivateDirectory(this.#directory);
    this.#dataIdentity = dataIdentity;
    this.#now = now;
  }

  #path(requestId: string, create = false): string {
    if (!validRequestId.test(requestId)) {
      throw new ProjectStoreError({
        code: "INVALID_REQUEST_ID",
        message: "The request ID is invalid.",
        status: 400,
        retry: "never",
        remedy: "Use the opaque request ID that Kojo supplied.",
      });
    }
    const requestDirectory = join(this.#directory, requestId);
    if (create) ensurePrivateDirectory(requestDirectory);
    return join(requestDirectory, "request.json");
  }

  #withLock<A>(requestId: string, create: boolean, body: () => A): A {
    const requestPath = this.#path(requestId, create);
    const lockPath = join(requestPath, "..", "request.lock");
    if (!create && !existsSync(lockPath)) return body();
    const descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor);
    if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      closeSync(descriptor);
      throw new Error("The client request lock is not a private owned file.");
    }
    const library = dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    if (library.symbols.flock(descriptor, 2) !== 0) {
      library.close();
      closeSync(descriptor);
      throw new Error("The client request lock is unavailable.");
    }
    try {
      return body();
    } finally {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    }
  }

  prepare(request: MutationEnvelope): string {
    return this.#withLock(request.requestId, true, () => this.#prepareLocked(request));
  }

  #prepareLocked(request: MutationEnvelope): string {
    const path = this.#path(request.requestId);
    if (request.dataIdentity !== this.#dataIdentity) {
      throw new ProjectStoreError({
        code: "DATA_IDENTITY_MISMATCH",
        message: "The request belongs to different Daemon data.",
        status: 409,
        retry: "never",
        remedy: "Prepare the request against the current Daemon data identity.",
      });
    }
    const requestBytes = encodeCanonicalJson(request as unknown as JsonValue);
    if (existsSync(path)) {
      assertPrivateNode(path, "file");
      const retained = this.#decode(readFileSync(path, "utf8"));
      if (
        !("request" in retained) ||
        encodeCanonicalJson(retained.request as unknown as JsonValue) !== requestBytes
      ) {
        throw new ProjectStoreError({
          code: "REQUEST_ID_CONFLICT",
          message: "This request ID already names different request content.",
          status: 409,
          retry: "lookupOriginal",
          remedy: "Look up the original request. Use a new request ID for different content.",
        });
      }
      return requestBytes;
    }
    const retained: FullClientRequest = {
      request,
      sha256: createHash("sha256").update(requestBytes).digest("hex"),
      createdAt: new Date(this.#now()).toISOString(),
      subject: { operation: request.operation, targetKind: request.target.kind },
    };
    const content = encodeCanonicalJson(retained as unknown as JsonValue);
    atomicPrivateFile(path, content);
    return requestBytes;
  }

  #decode(body: string): StoredClientRequest {
    const parsed = JSON.parse(body) as Partial<FullClientRequest & CompactedClientRequest>;
    if (
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      parsed.subject === undefined ||
      typeof parsed.subject.operation !== "string" ||
      typeof parsed.subject.targetKind !== "string" ||
      (parsed.resolution !== undefined && !validResolution(parsed.resolution))
    ) {
      throw new ProjectStoreError({
        code: "CLIENT_REQUEST_DAMAGED",
        message: "The retained client request is not valid.",
        status: 500,
        retry: "never",
        remedy: "Preserve the client request file and inspect the Daemon data.",
      });
    }
    const decoded = decodeMutationEnvelope(parsed.request);
    if (!decoded.ok) {
      if (
        typeof parsed.requestId !== "string" ||
        parsed.dataIdentity !== this.#dataIdentity ||
        parsed.subject === undefined ||
        parsed.resolution === undefined
      ) {
        throw new ProjectStoreError({
          code: "CLIENT_REQUEST_DAMAGED",
          message: "The compacted client request is not valid.",
          status: 500,
          retry: "never",
          remedy: "Preserve the client request file and inspect the Daemon data.",
        });
      }
      return {
        requestId: parsed.requestId,
        dataIdentity: parsed.dataIdentity,
        sha256: parsed.sha256,
        createdAt: parsed.createdAt,
        subject: parsed.subject,
        resolution: parsed.resolution,
      };
    }
    const bytes = encodeCanonicalJson(decoded.value as unknown as JsonValue);
    if (createHash("sha256").update(bytes).digest("hex") !== parsed.sha256) {
      throw new ProjectStoreError({
        code: "CLIENT_REQUEST_DAMAGED",
        message: "The retained client request hash does not match its content.",
        status: 500,
        retry: "never",
        remedy: "Preserve the client request file and inspect the Daemon data.",
      });
    }
    return {
      request: decoded.value,
      sha256: parsed.sha256,
      createdAt: parsed.createdAt,
      subject: parsed.subject ?? {
        operation: decoded.value.operation,
        targetKind: decoded.value.target.kind,
      },
      ...(parsed.resolution === undefined ? {} : { resolution: parsed.resolution }),
    };
  }

  requireExact(request: MutationEnvelope): string {
    const retained = this.lookup(request.requestId);
    if (retained === undefined || retained.request === undefined || retained.body === undefined) {
      throw new ProjectStoreError({
        code: "CLIENT_REQUEST_NOT_PREPARED",
        message: "The exact client request was not prepared on this Host.",
        status: 409,
        retry: "lookupOriginal",
        remedy: "Prepare the exact request before the domain mutation is sent.",
      });
    }
    const requestBytes = encodeCanonicalJson(request as unknown as JsonValue);
    if (requestBytes !== retained.body) {
      throw new ProjectStoreError({
        code: "REQUEST_ID_CONFLICT",
        message: "This request ID was prepared with different request content.",
        status: 409,
        retry: "lookupOriginal",
        remedy: "Replay the original request or use a new request ID.",
      });
    }
    return retained.body;
  }

  lookup(requestId: string): RetainedClientRequestView | undefined {
    return this.#withLock(requestId, false, () => this.#lookupLocked(requestId));
  }

  #lookupLocked(requestId: string): RetainedClientRequestView | undefined {
    const path = this.#path(requestId);
    if (!existsSync(path)) return undefined;
    assertPrivateNode(path, "file");
    const body = readFileSync(path, "utf8");
    let retained = this.#decode(body);
    if (
      "request" in retained &&
      retained.resolution !== undefined &&
      this.#now() - Date.parse(retained.resolution.resolvedAt) >= fullRetentionMillis
    ) {
      const compacted: CompactedClientRequest = {
        requestId: retained.request.requestId,
        dataIdentity: retained.request.dataIdentity,
        sha256: retained.sha256,
        createdAt: retained.createdAt,
        subject: retained.subject,
        resolution: retained.resolution,
      };
      atomicPrivateFile(path, encodeCanonicalJson(compacted as unknown as JsonValue));
      retained = compacted;
    }
    if ("request" in retained) {
      return {
        request: retained.request,
        requestId: retained.request.requestId,
        dataIdentity: retained.request.dataIdentity,
        body: encodeCanonicalJson(retained.request as unknown as JsonValue),
        contentHash: retained.sha256,
        createdAt: retained.createdAt,
        subject: retained.subject,
        ...(retained.resolution === undefined ? {} : { resolution: retained.resolution }),
      };
    }
    return {
      requestId: retained.requestId,
      dataIdentity: retained.dataIdentity,
      contentHash: retained.sha256,
      createdAt: retained.createdAt,
      subject: retained.subject,
      resolution: retained.resolution,
    };
  }

  resolve(requestId: string, resolution: ClientRequestResolution): void {
    this.#withLock(requestId, false, () => {
      const path = this.#path(requestId);
      if (!existsSync(path)) throw new Error("The client request does not exist.");
      const retained = this.#decode(readFileSync(path, "utf8"));
      if (!("request" in retained)) return;
      if (retained.resolution !== undefined) {
        const sameReference =
          encodeCanonicalJson(retained.resolution.resultReference as unknown as JsonValue) ===
          encodeCanonicalJson(resolution.resultReference as unknown as JsonValue);
        if (
          retained.resolution.status === "accepted" &&
          resolution.status === "committed" &&
          sameReference
        ) {
          atomicPrivateFile(
            path,
            encodeCanonicalJson({ ...retained, resolution } as unknown as JsonValue),
          );
          return;
        }
        if (retained.resolution.status !== resolution.status || !sameReference) {
          throw new Error("The client request already has different resolution metadata.");
        }
        return;
      }
      atomicPrivateFile(
        path,
        encodeCanonicalJson({ ...retained, resolution } as unknown as JsonValue),
      );
    });
  }

  compactResolved(): void {
    for (const requestId of readdirSync(this.#directory)) this.lookup(requestId);
  }

  list(): ReadonlyArray<RetainedClientRequestView & { readonly retainedAt: string }> {
    return readdirSync(this.#directory)
      .map((requestId) => {
        const retained = this.lookup(requestId);
        if (retained === undefined) {
          throw new ProjectStoreError({
            code: "CLIENT_REQUEST_DAMAGED",
            message: "The retained client request disappeared during observation.",
            status: 500,
            retry: "never",
            remedy: "Preserve the client request directory and inspect the Daemon data.",
          });
        }
        return {
          ...retained,
          retainedAt: statSync(this.#path(requestId)).mtime.toISOString(),
        };
      })
      .sort((left, right) => right.retainedAt.localeCompare(left.retainedAt));
  }
}
