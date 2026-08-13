import { describe, expect, it } from "@effect/vitest";
import { hello } from "../../../src/cli/hello.ts";
import { review } from "../../../src/cli/review.ts";
import { demos, describeChoices } from "../../../src/cli/workflows.ts";

/**
 * The one line `--help` prints, and the one a refusal ends with.
 *
 * It is tested apart from the directory it is normally built from because the property that matters
 * is not "can this read a folder" — it is that a person is told what *this* repository offers, and
 * told it in a way that cannot be mistaken for what Kojo ships.
 */
describe("what a person is told they may run", () => {
  it("names the factory's own workflows first, and Kojo's as demos", () => {
    const line = describeChoices(["hotfix", "review"], ["demo-hello", "demo-review"]);

    expect(line).toContain("this factory: hotfix, review");
    expect(line).toContain("Built-in demos: demo-hello, demo-review");
    // The factory's names come first because they are the answer; the demos are the footnote.
    expect(line.indexOf("hotfix")).toBeLessThan(line.indexOf("demo-hello"));
  });

  it("says there is no factory here rather than offering demos as if they were one", () => {
    const line = describeChoices([], ["demo-hello", "demo-review"]);

    expect(line).toContain(".kojo/workflows/");
    expect(line).toContain("demo-hello, demo-review");
    expect(line).not.toContain("this factory");
  });
});

/**
 * **The collision this ticket exists to remove.**
 *
 * Kojo's own `review` shared a name *and* an idempotency key with the `review` that `kojo init`
 * stamps, and having no agent phase it answered `kojo run review "the change"` in a stamped
 * repository by succeeding in milliseconds while invoking nothing. A precedence rule would resolve
 * that; a prefix makes it unrepresentable, which is what this asserts.
 */
describe("the workflows Kojo itself ships", () => {
  it("cannot take a name a factory would stamp", () => {
    const stampable = ["review", "hotfix"];

    for (const demo of demos) {
      expect(demo.name.startsWith("demo-")).toBe(true);
      expect(stampable).not.toContain(demo.name);
    }
  });

  /**
   * **The `Runnable`'s name is not the name that collides.** `demos` above carries the word the CLI
   * matches on, and renaming only that leaves the collision exactly where it was: the workflow's own
   * `_tag` is what the engine registers under, and its idempotency key is what makes two starts one
   * run. A stamped `review` and a built-in whose definition still said `review` would share both.
   *
   * Measured, not supposed: with the definitions below put back to `review`/`review/${subject}` and
   * the `Runnable` left as `demo-review`, the assertion above stays green and so does the whole unit
   * tier. This is what closes that hole.
   */
  it("carries the demo prefix on the definition and the idempotency key, not only on the CLI name", () => {
    const stampable = ["review", "hotfix"];

    for (const shipped of [hello, review]) {
      expect(shipped.definition._tag.startsWith("demo-")).toBe(true);
      expect(stampable).not.toContain(shipped.definition._tag);
    }

    // The key is what the engine deduplicates starts by, so a shared prefix there is what stops a
    // factory's run and a demo's run from being taken for the same run.
    expect(review.definition.idempotencyKey({ subject: "the change" })).toBe(
      "demo-review/the change",
    );
    expect(hello.definition.idempotencyKey({ who: "Kevin", fail: false })).toBe(
      "demo-hello/Kevin/false",
    );
  });
});
