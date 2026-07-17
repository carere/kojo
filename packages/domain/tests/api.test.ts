import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { HealthResponse } from "../src/api";

describe("HealthResponse", () => {
  test("accepts the Kojo healthy response", () => {
    expect(
      Schema.decodeUnknownSync(HealthResponse)({
        service: "kojo",
        status: "ok",
      }),
    ).toEqual({ service: "kojo", status: "ok" });
  });
});
