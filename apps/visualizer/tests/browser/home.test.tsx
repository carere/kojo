import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { VisualizerHome } from "../../src/contexts/readiness/components/visualizer-home";
import { setLocale } from "../../src/i18n/runtime";

let dispose: VoidFunction | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

test("shows the Kojo starting point", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <VisualizerHome />
      </ColorModeProvider>
    ),
    root,
  );

  await expect
    .element(page.getByRole("heading", { name: "The new Kojo starts here." }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Ready" })).toBeVisible();
  await expect.element(page.getByText("Effect RPC ready")).toBeVisible();
});

test("switches to the dark color mode", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <VisualizerHome />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: "Dark" }).click();

  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
});
