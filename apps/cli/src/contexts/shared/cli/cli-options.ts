import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type RequestKey, RequestKey as RequestKeySchema } from "@kojo/control";
import { Schema } from "effect";

export interface ParsedOptions {
  readonly args: ReadonlyArray<string>;
  readonly projectId?: string;
  readonly projectPath?: string;
  readonly requestKey?: string;
  readonly conditions: ReadonlyArray<string>;
  readonly cursor?: string;
  readonly limit?: string;
}

export const parseOptions = (args: ReadonlyArray<string>): ParsedOptions | undefined => {
  const remaining: Array<string> = [];
  let projectId: string | undefined;
  let projectPath: string | undefined;
  let requestKey: string | undefined;
  const conditions: Array<string> = [];
  let cursor: string | undefined;
  let limit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      ![
        "--project",
        "--project-id",
        "--request-key",
        "--condition",
        "--cursor",
        "--limit",
      ].includes(argument)
    ) {
      remaining.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    index += 1;
    if (argument === "--condition") {
      conditions.push(value);
    } else if (argument === "--cursor") {
      if (cursor !== undefined) return undefined;
      cursor = value;
    } else if (argument === "--limit") {
      if (limit !== undefined) return undefined;
      limit = value;
    } else if (argument === "--project") {
      if (projectPath !== undefined) return undefined;
      projectPath = value;
    } else if (argument === "--project-id") {
      if (projectId !== undefined) return undefined;
      projectId = value;
    } else {
      if (requestKey !== undefined) return undefined;
      requestKey = value;
    }
  }
  if (projectId !== undefined && projectPath !== undefined) return undefined;
  return { args: remaining, projectId, projectPath, requestKey, conditions, cursor, limit };
};

export const decodeRequestKey = (value: string | undefined): RequestKey | undefined => {
  try {
    return Schema.decodeUnknownSync(RequestKeySchema)(value ?? randomUUID());
  } catch {
    return undefined;
  }
};

export const canonicalSelectorPath = async (input: string) => {
  let candidate = resolve(input);
  const missingSegments: Array<string> = [];
  for (;;) {
    try {
      return join(await realpath(candidate), ...missingSegments);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(input);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
};
