import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { ExecutionTraceExport } from "@kojo/control";

export class TraceExportDestinationExistsError extends Error {
  override readonly name = "TraceExportDestinationExistsError";
}

interface ZipEntry {
  readonly contents: Uint8Array;
  readonly name: string;
}

const encoder = new TextEncoder();

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
 * Creates a standards-compliant, uncompressed ZIP without invoking a shell or
 * accepting entry paths from artifact display names. The Archive names are
 * derived solely from recorded Artifact identities.
 */
const zip = (entries: ReadonlyArray<ZipEntry>) => {
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
