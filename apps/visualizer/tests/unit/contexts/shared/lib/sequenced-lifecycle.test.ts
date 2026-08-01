import { expect, it } from "vitest";
import { makeSequencedLifecycle } from "../../../../../src/contexts/shared/lib/sequenced-lifecycle";

it("awaits old teardown before starting the replacement and on unmount", async () => {
  const events: Array<string> = [];
  let releaseStop: (() => void) | undefined;
  const lifecycle = makeSequencedLifecycle<string>(async (handle) => {
    events.push(`stop:${handle}`);
    await new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
  });

  await lifecycle.replace(() => {
    events.push("start:first");
    return "first";
  });
  const replacement = lifecycle.replace(() => {
    events.push("start:second");
    return "second";
  });
  await Promise.resolve();
  expect(events).toEqual(["start:first", "stop:first"]);
  releaseStop?.();
  await replacement;
  expect(events).toEqual(["start:first", "stop:first", "start:second"]);

  const disposal = lifecycle.dispose();
  await Promise.resolve();
  expect(events).toEqual(["start:first", "stop:first", "start:second", "stop:second"]);
  releaseStop?.();
  await disposal;
});

it("skips superseded replacements during a rapid selection switch", async () => {
  const events: Array<string> = [];
  const lifecycle = makeSequencedLifecycle<string>(async (handle) => {
    events.push(`stop:${handle}`);
  });

  await lifecycle.replace(() => {
    events.push("start:first");
    return "first";
  });
  const second = lifecycle.replace(() => {
    events.push("start:second");
    return "second";
  });
  const third = lifecycle.replace(() => {
    events.push("start:third");
    return "third";
  });
  await Promise.all([second, third]);

  expect(events).toEqual(["start:first", "stop:first", "start:third"]);
  await lifecycle.dispose();
});
