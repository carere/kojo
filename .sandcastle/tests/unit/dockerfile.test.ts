import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../../Dockerfile"), "utf8");

const chromiumRuntimePackages = [
  "fonts-freefont-ttf",
  "fonts-ipafont-gothic",
  "fonts-liberation",
  "fonts-noto-color-emoji",
  "fonts-tlwg-loma-otf",
  "fonts-unifont",
  "fonts-wqy-zenhei",
  "libasound2t64",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcairo2",
  "libcups2t64",
  "libdbus-1-3",
  "libdrm2",
  "libfontconfig1",
  "libfreetype6",
  "libgbm1",
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
  "xfonts-scalable",
  "xvfb",
] as const;

describe("Sandcastle Docker image", () => {
  test("installs the Playwright Chromium runtime", () => {
    for (const packageName of chromiumRuntimePackages) {
      expect(dockerfile).toContain(`  ${packageName} \\`);
    }
  });
});
