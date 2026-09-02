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
import type { ClientRequestRepository } from "../ports/ClientRequestRepository.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

const validRequestId = /^[A-Za-z0-9_-]+$/;
const validDataIdentity = /^[A-Za-z0-9_-]+$/;

interface RetainedClientRequest {
  readonly request: MutationEnvelope;
  readonly sha256: string;
  readonly createdAt: string;
  readonly subject: {
    readonly operation: string;
    readonly targetKind: string;
  };
}

export class HostClientRequestRepository implements ClientRequestRepository {
  readonly #directory: string;
  readonly #dataIdentity: string;

  constructor(directory: string, dataIdentity: string) {
    if (!validDataIdentity.test(dataIdentity)) throw new Error("The data identity is invalid.");
    ensurePrivateDirectory(directory);
    this.#directory = join(directory, dataIdentity);
    ensurePrivateDirectory(this.#directory);
    this.#dataIdentity = dataIdentity;
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
      if (encodeCanonicalJson(retained.request as unknown as JsonValue) !== requestBytes) {
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
    const retained: RetainedClientRequest = {
      request,
      sha256: createHash("sha256").update(requestBytes).digest("hex"),
      createdAt: new Date().toISOString(),
      subject: { operation: request.operation, targetKind: request.target.kind },
    };
    const content = encodeCanonicalJson(retained as unknown as JsonValue);
    atomicPrivateFile(path, content);
    return requestBytes;
  }

  #decode(body: string): RetainedClientRequest {
    const parsed = JSON.parse(body) as Partial<RetainedClientRequest>;
    const decoded = decodeMutationEnvelope(parsed.request);
    if (!decoded.ok || typeof parsed.sha256 !== "string" || typeof parsed.createdAt !== "string") {
      throw new ProjectStoreError({
        code: "CLIENT_REQUEST_DAMAGED",
        message: "The retained client request is not valid.",
        status: 500,
        retry: "never",
        remedy: "Preserve the client request file and inspect the Daemon data.",
      });
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
    };
  }

  lookup(
    requestId: string,
  ): { readonly request: MutationEnvelope; readonly body: string } | undefined {
    return this.#withLock(requestId, false, () => this.#lookupLocked(requestId));
  }

  #lookupLocked(
    requestId: string,
  ): { readonly request: MutationEnvelope; readonly body: string } | undefined {
    const path = this.#path(requestId);
    if (!existsSync(path)) return undefined;
    assertPrivateNode(path, "file");
    const body = readFileSync(path, "utf8");
    const retained = this.#decode(body);
    return { request: retained.request, body };
  }

  list(): ReadonlyArray<{
    readonly request: MutationEnvelope;
    readonly body: string;
    readonly retainedAt: string;
  }> {
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
