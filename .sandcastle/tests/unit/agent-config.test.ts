import { describe, expect, test } from "bun:test";
import { createSandboxProvider, hooks } from "../../src/workflows/delivery/agents/config";

describe("delivery agent sandbox configuration", () => {
  test("removes host environment secrets before creating the sandbox", async () => {
    let createdEnvironment: Record<string, string> | undefined;
    let providerEnvironment: Record<string, string> | undefined;
    const provider = createSandboxProvider({
      hostEnvironment: ["GH_TOKEN=github-write-token", "ANOTHER_SECRET=private-value"].join("\n"),
      providerFactory: (options) => {
        providerEnvironment = options?.env;
        return {
          create: async (createOptions: { env: Record<string, string> }) => {
            createdEnvironment = createOptions.env;
            return {};
          },
          env: options?.env ?? {},
          name: "test-docker",
          sandboxHomedir: "/home/agent",
          tag: "bind-mount",
        } as never;
      },
    });

    await (
      provider as unknown as {
        create: (options: { env: Record<string, string> }) => Promise<unknown>;
      }
    ).create({
      env: {
        ANOTHER_SECRET: "private-value",
        CODEX_HOME: "/home/agent/.codex",
        GH_TOKEN: "github-write-token",
        SAFE_SETTING: "visible",
      },
    });

    expect(providerEnvironment).toEqual({ CODEX_HOME: "/home/agent/.codex" });
    expect(createdEnvironment).toEqual({
      CODEX_HOME: "/home/agent/.codex",
      SAFE_SETTING: "visible",
    });
  });

  test("recognizes Bun-compatible exported environment assignments only", async () => {
    let createdEnvironment: Record<string, string> | undefined;
    const provider = createSandboxProvider({
      hostEnvironment: [
        "  export GH_TOKEN = github-write-token",
        "export ANOTHER_SECRET=private-value",
        "SAFE_SECRET = hidden",
        "# COMMENTED_SECRET=visible",
        "export 1INVALID=visible",
        "INVALID-DASH=visible",
        "export MISSING_EQUALS",
      ].join("\n"),
      providerFactory: () =>
        ({
          create: async (createOptions: { env: Record<string, string> }) => {
            createdEnvironment = createOptions.env;
            return {};
          },
          env: {},
          name: "test-docker",
          sandboxHomedir: "/home/agent",
          tag: "bind-mount",
        }) as never,
    });

    await (
      provider as unknown as {
        create: (options: { env: Record<string, string> }) => Promise<unknown>;
      }
    ).create({
      env: {
        "1INVALID": "visible",
        ANOTHER_SECRET: "private-value",
        COMMENTED_SECRET: "visible",
        GH_TOKEN: "github-write-token",
        "INVALID-DASH": "visible",
        MISSING_EQUALS: "visible",
        SAFE_SECRET: "hidden",
        VISIBLE_SETTING: "visible",
      },
    });

    expect(createdEnvironment).toEqual({
      "1INVALID": "visible",
      COMMENTED_SECRET: "visible",
      "INVALID-DASH": "visible",
      MISSING_EQUALS: "visible",
      VISIBLE_SETTING: "visible",
    });
  });

  test("shadows the host environment file inside every workspace sandbox", () => {
    let providerMounts:
      | readonly { readonly hostPath: string; readonly sandboxPath: string; readonly?: boolean }[]
      | undefined;

    createSandboxProvider({
      hostEnvironment: "GH_TOKEN=github-write-token",
      providerFactory: (options) => {
        providerMounts = options?.mounts;
        return {
          create: async () => ({}),
          env: options?.env ?? {},
          name: "test-docker",
          sandboxHomedir: "/home/agent",
          tag: "bind-mount",
        } as never;
      },
    });

    expect(providerMounts).toContainEqual({
      hostPath: expect.stringMatching(/\.sandcastle\/\.env\.example$/),
      readonly: true,
      sandboxPath: ".sandcastle/.env",
    });
  });

  test("prepares the environment shadow target before Docker mounts it", () => {
    expect(hooks.host?.onWorktreeReady).toContainEqual({
      command: "touch .sandcastle/.env",
    });
  });
});
