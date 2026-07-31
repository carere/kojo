import { expect, it } from "vitest";
import {
  parseRetentionDuration,
  parseRetentionSize,
} from "../../../../../src/contexts/shared/cli/retention-values";

it("parses explicit retention durations and off", () => {
  expect(parseRetentionDuration("14d")).toBe(14 * 24 * 60 * 60 * 1_000);
  expect(parseRetentionDuration("2h")).toBe(2 * 60 * 60 * 1_000);
  expect(parseRetentionDuration("off")).toBeNull();
  expect(parseRetentionDuration("14 days")).toBeUndefined();
});

it("parses binary retention sizes and rejects decimal units", () => {
  expect(parseRetentionSize("100MiB")).toBe(100 * 1024 ** 2);
  expect(parseRetentionSize("5GiB")).toBe(5 * 1024 ** 3);
  expect(parseRetentionSize("off")).toBeNull();
  expect(parseRetentionSize("5GB")).toBeUndefined();
});
