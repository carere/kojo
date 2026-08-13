import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";

describe("RunId", () => {
  it("decodes a string into a branded run id", () => {
    // Deliberately `unknown`: a run id reaches us from a database row or a CLI argument, never
    // as a value the compiler already knows is a string.
    const fromTheOutside: unknown = "run_01JQ8F2K";
    expect(Schema.decodeUnknownSync(RunId)(fromTheOutside)).toBe("run_01JQ8F2K");
  });

  it("rejects a value that is not a string", () => {
    expect(() => Schema.decodeUnknownSync(RunId)(42)).toThrow();
  });
});
