/// <reference types="vitest/config" />

import { paraglideVitePlugin as paraglide } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    devtools({
      removeDevtoolsOnBuild: true,
      injectSource: {
        enabled: true,
      },
      editor: {
        name: "VSCode",
        open: async (path, lineNumber, columnNumber) => {
          const { exec } = await import("node:child_process");
          let goto = path.replaceAll("$", "\\$");
          if (lineNumber) goto += `:${lineNumber}`;
          if (columnNumber) goto += `:${columnNumber}`;
          exec(`code --goto "${goto}"`);
        },
      },
    }),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
      router: {
        enableRouteTreeFormatting: true,
      },
    }),
    solid({ ssr: true }),
    paraglide({
      project: "../../project.inlang",
      outdir: "./src/i18n",
    }),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: "browser-e2e",
          environment: "node",
          include: ["tests/browser-e2e/**/*.test.ts"],
        },
      },
    ],
  },
});
