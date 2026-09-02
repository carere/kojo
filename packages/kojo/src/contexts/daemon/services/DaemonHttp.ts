import { extname, join } from "node:path";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { DaemonMutationGate } from "./DaemonMutationGate.ts";

export const noStoreJson = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export const problem = (status: number, code: string, message: string): Response =>
  noStoreJson({ code, message }, status);

export const isJson = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
  "application/json";

export const requestJson = async (request: Request): Promise<unknown> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1_048_576) {
    throw new LifecycleError("REQUEST_TOO_LARGE", "the request body is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

export const withOrdinaryMutation = async (
  gate: DaemonMutationGate,
  request: Request,
  body: () => Promise<Response>,
): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") return body();
  const release = gate.enter();
  if (release === undefined) {
    return problem(
      409,
      "daemon-mutations-held",
      "ordinary mutations are held by the current Daemon lifecycle operation",
    );
  }
  try {
    return await body();
  } finally {
    release();
  }
};

const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
};

export const consoleAsset = async (assets: string, pathname: string): Promise<Response> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const requested = segments.length === 0 ? "index.html" : join(...segments);
  const selected = extname(requested).length === 0 ? "index.html" : requested;
  const file = Bun.file(join(assets, selected));
  if (!(await file.exists())) return problem(404, "not-found", "the requested asset was not found");
  return new Response(file, {
    headers: { "content-type": contentType(selected), "x-content-type-options": "nosniff" },
  });
};
