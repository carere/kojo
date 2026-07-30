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
  readonly reveal: boolean;
  readonly conditions: ReadonlyArray<string>;
  readonly cursor?: string;
  readonly input?: string;
  readonly value?: string;
  readonly valueFile?: string;
  readonly limit?: string;
  readonly states: ReadonlyArray<string>;
  readonly workflowKeys: ReadonlyArray<string>;
}

export const parseOptions = (args: ReadonlyArray<string>): ParsedOptions | undefined => {
  const remaining: Array<string> = [];
  let projectId: string | undefined;
  let projectPath: string | undefined;
  let requestKey: string | undefined;
  let reveal = false;
  const conditions: Array<string> = [];
  let cursor: string | undefined;
  let input: string | undefined;
  let value: string | undefined;
  let valueFile: string | undefined;
  let limit: string | undefined;
  const states: Array<string> = [];
  const workflowKeys: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--reveal") {
      if (reveal) return undefined;
      reveal = true;
      continue;
    }
    if (
      ![
        "--project",
        "--project-id",
        "--request-key",
        "--condition",
        "--cursor",
        "--input",
        "--value",
        "--value-file",
        "--limit",
        "--state",
        "--workflow",
      ].includes(argument)
    ) {
      remaining.push(argument);
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) return undefined;
    index += 1;
    if (argument === "--condition") {
      conditions.push(optionValue);
    } else if (argument === "--state") {
      states.push(optionValue);
    } else if (argument === "--workflow") {
      workflowKeys.push(optionValue);
    } else if (argument === "--input") {
      if (input !== undefined) return undefined;
      input = optionValue;
    } else if (argument === "--value") {
      if (value !== undefined || valueFile !== undefined) return undefined;
      value = optionValue;
    } else if (argument === "--value-file") {
      if (value !== undefined || valueFile !== undefined) return undefined;
      valueFile = optionValue;
    } else if (argument === "--cursor") {
      if (cursor !== undefined) return undefined;
      cursor = optionValue;
    } else if (argument === "--limit") {
      if (limit !== undefined) return undefined;
      limit = optionValue;
    } else if (argument === "--project") {
      if (projectPath !== undefined) return undefined;
      projectPath = optionValue;
    } else if (argument === "--project-id") {
      if (projectId !== undefined) return undefined;
      projectId = optionValue;
    } else {
      if (requestKey !== undefined) return undefined;
      requestKey = optionValue;
    }
  }
  if (projectId !== undefined && projectPath !== undefined) return undefined;
  return {
    args: remaining,
    projectId,
    projectPath,
    requestKey,
    reveal,
    conditions,
    cursor,
    input,
    value,
    valueFile,
    limit,
    states,
    workflowKeys,
  };
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
