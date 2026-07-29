import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { HostOverview } from "../../src/contexts/workflow-execution/host/components/host-overview";
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
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await expect
    .element(page.getByRole("heading", { name: "The new Kojo starts here." }))
    .toBeVisible();
});

test("switches to the dark color mode", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: "Dark" }).click();

  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
});

test("shows Host connectivity and the authoritative empty Project state", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 1 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list"],
              },
              projects: [],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  await expect.element(page.getByText("No Kojo Projects yet.")).toBeVisible();
});
