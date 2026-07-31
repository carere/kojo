import { defineBuiltInSandboxProvider } from "../index";

/** Immutable Docker Sandbox Provider definition. */
export const docker = (options: { readonly providerKey: string; readonly revision: string }) =>
  defineBuiltInSandboxProvider({ kind: "docker", ...options });
