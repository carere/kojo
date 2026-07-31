import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { ExecutionTraceExport } from "@kojo/control";

export class TraceExportDestinationExistsError extends Error {
  override readonly name = "TraceExportDestinationExistsError";
}

/** The in-memory writer emits classic ZIP only, so it must never truncate ZIP fields. */
export class TraceExportArchiveTooLargeError extends Error {
  override readonly name = "TraceExportArchiveTooLargeError";

  constructor() {
    super(
      "This Execution Trace export exceeds the 4 GiB classic ZIP limit. Reduce included Artifacts or export a smaller Trace.",
    );
  }
}

interface ZipEntry {
  readonly contents: Uint8Array;
  readonly name: string;
}

const encoder = new TextEncoder();
const maxUint16 = 0xffff;
const maxUint32 = 0xffffffff;
const localHeaderByteSize = 30;
const centralHeaderByteSize = 46;
const endOfCentralDirectoryByteSize = 22;

const crc32 = (contents: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const uint16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

/**
 * Classic ZIP has no room for ZIP64 values. Validate every field before
 * allocating the archive or touching its destination, rather than truncating
 * a length or offset with DataView's 16/32-bit writes.
 */
export const assertClassicZipBounds = (entries: ReadonlyArray<ZipEntry>) => {
  if (!Number.isSafeInteger(entries.length) || entries.length > maxUint16) {
    throw new TraceExportArchiveTooLargeError();
  }
  let localOffset = 0;
  let centralDirectoryByteSize = 0;
  for (const entry of entries) {
    const nameByteSize = encoder.encode(entry.name).byteLength;
    if (
      !Number.isSafeInteger(entry.contents.byteLength) ||
      entry.contents.byteLength < 0 ||
      nameByteSize > maxUint16 ||
      entry.contents.byteLength > maxUint32
    ) {
      throw new TraceExportArchiveTooLargeError();
    }
    const localByteSize = localHeaderByteSize + nameByteSize + entry.contents.byteLength;
    const centralByteSize = centralHeaderByteSize + nameByteSize;
    if (
      localOffset + localByteSize > maxUint32 ||
      centralDirectoryByteSize + centralByteSize > maxUint32
    ) {
      throw new TraceExportArchiveTooLargeError();
    }
    localOffset += localByteSize;
    centralDirectoryByteSize += centralByteSize;
  }
  if (localOffset + centralDirectoryByteSize + endOfCentralDirectoryByteSize > maxUint32) {
    throw new TraceExportArchiveTooLargeError();
  }
};

/**
 * Creates a standards-compliant, uncompressed ZIP without invoking a shell or
 * accepting entry paths from artifact display names. The Archive names are
 * derived solely from recorded Artifact identities.
 */
const zip = (entries: ReadonlyArray<ZipEntry>) => {
  assertClassicZipBounds(entries);
  const local: Array<Uint8Array> = [];
  const central: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.contents);
    const size = entry.contents.byteLength;
    const header = concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(size),
      uint32(size),
      uint16(name.byteLength),
      uint16(0),
      name,
      entry.contents,
    ]);
    local.push(header);
    central.push(
      concat([
        uint32(0x02014b50),
        uint16(0x0314),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(checksum),
        uint32(size),
        uint32(size),
        uint16(name.byteLength),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name,
      ]),
    );
    offset += header.byteLength;
  }
  const centralDirectory = concat(central);
  return concat([
    ...local,
    centralDirectory,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.byteLength),
    uint32(offset),
    uint16(0),
  ]);
};

/**
 * Export canonicalization stays local: the only other stable serializers are
 * private to Workflow Definition hashing or Host request hashing, each with
 * different failure semantics. Archive data must remain a total, deterministic
 * representation of arbitrary recorded payloads without coupling this CLI
 * writer to either internal contract.
 */
const stableJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const prettyJson = (value: unknown) => encoder.encode(`${stableJson(value)}\n`);
const checksum = (contents: Uint8Array) => createHash("sha256").update(contents).digest("hex");

/** @internal Kept separate so ZIP bounds can be regression-tested without allocating huge files. */
export const writeClassicZip = async (destination: string, entries: ReadonlyArray<ZipEntry>) => {
  assertClassicZipBounds(entries);
  try {
    await writeFile(destination, zip(entries), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TraceExportDestinationExistsError(
        "The export destination already exists; choose a new ZIP path.",
      );
    }
    throw error;
  }
};

export const writeExecutionTraceExport = async (
  destination: string,
  trace: ExecutionTraceExport,
  payloadsRevealed: boolean,
) => {
  const events = encoder.encode(`${trace.events.map(stableJson).join("\n")}\n`);
  const artifactInventory = trace.artifacts.map(({ artifact, contentBase64 }) => ({
    ...artifact,
    included: contentBase64 !== null,
  }));
  const metadata = prettyJson({ artifacts: artifactInventory });
  const entries: Array<ZipEntry> = [
    { name: "events.ndjson", contents: events },
    { name: "artifacts.json", contents: metadata },
  ];
  for (const { artifact, contentBase64 } of trace.artifacts) {
    if (contentBase64 === null) continue;
    entries.push({
      name: `artifacts/${artifact.artifactId}`,
      contents: Buffer.from(contentBase64, "base64"),
    });
  }
  const files = entries.map((entry) => ({
    byteSize: entry.contents.byteLength,
    path: entry.name,
    sha256: checksum(entry.contents),
  }));
  entries.unshift({
    name: "manifest.json",
    contents: prettyJson({
      artifactInventory,
      compatibilityWarnings: trace.compatibilityWarnings,
      exportedAtMs: trace.exportedAtMs,
      files,
      formatVersion: trace.formatVersion,
      highWaterSequence: trace.highWaterSequence,
      projectIdentity: trace.projectIdentity,
      redactionMode: payloadsRevealed ? "unredacted" : "redacted",
      runId: trace.runId,
      runState: trace.runState,
      final: trace.final,
    }),
  });
  await writeClassicZip(destination, entries);
};
