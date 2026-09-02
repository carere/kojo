import { existsSync, readFileSync } from "node:fs";
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

export class HostClientRequestRepository implements ClientRequestRepository {
  readonly #directory: string;

  constructor(directory: string) {
    ensurePrivateDirectory(directory);
    this.#directory = directory;
  }

  #path(requestId: string): string {
    if (!validRequestId.test(requestId)) {
      throw new ProjectStoreError({
        code: "INVALID_REQUEST_ID",
        message: "The request ID is invalid.",
        status: 400,
        retry: "never",
        remedy: "Use the opaque request ID that Kojo supplied.",
      });
    }
    return join(this.#directory, `${requestId}.json`);
  }

  prepare(request: MutationEnvelope): string {
    const path = this.#path(request.requestId);
    const content = encodeCanonicalJson(request as unknown as JsonValue);
    if (existsSync(path)) {
      assertPrivateNode(path, "file");
      if (readFileSync(path, "utf8") !== content) {
        throw new ProjectStoreError({
          code: "REQUEST_ID_CONFLICT",
          message: "This request ID already names different request content.",
          status: 409,
          retry: "lookupOriginal",
          remedy: "Look up the original request. Use a new request ID for different content.",
        });
      }
      return content;
    }
    atomicPrivateFile(path, content);
    return content;
  }

  lookup(
    requestId: string,
  ): { readonly request: MutationEnvelope; readonly body: string } | undefined {
    const path = this.#path(requestId);
    if (!existsSync(path)) return undefined;
    assertPrivateNode(path, "file");
    const body = readFileSync(path, "utf8");
    const decoded = decodeMutationEnvelope(JSON.parse(body));
    if (!decoded.ok) {
      throw new ProjectStoreError({
        code: "CLIENT_REQUEST_DAMAGED",
        message: "The retained client request is not valid.",
        status: 500,
        retry: "never",
        remedy: "Preserve the client request file and inspect the Daemon data.",
      });
    }
    return { request: decoded.value, body };
  }
}
