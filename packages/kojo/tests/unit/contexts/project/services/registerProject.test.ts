import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { inMemoryProjectRepository } from "../../../../../src/contexts/project/adapters/InMemoryProjectRepository.ts";
import { registerProject } from "../../../../../src/contexts/project/services/registerProject.ts";

const request = (requestId: string, requestBody: string, location = "/worktrees/one") => ({
  requestId,
  requestBody,
  dataIdentity: "data-one",
  location,
  observedAt: "2026-09-01T12:00:00.000Z",
  factory: { state: "missing" as const },
});

describe("register Project", () => {
  it("deduplicates a location and rejects changed content under one request ID", async () => {
    const repository = inMemoryProjectRepository;
    const [first, duplicate, conflict] = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* registerProject(request("request-one", "one"));
        const duplicate = yield* registerProject(request("request-two", "two"));
        const conflict = yield* registerProject(
          request("request-one", "changed", "/worktrees/two"),
        ).pipe(Effect.exit);
        return [first, duplicate, conflict] as const;
      }).pipe(Effect.provide(repository)),
    );
    expect(duplicate).toEqual({ created: false, project: first.project });
    expect(conflict._tag).toBe("Failure");
  });
});
