import { defineBuiltInSandboxProvider } from "../index";

/** Immutable Podman Sandbox Provider definition. */
export const podman = (options: { readonly providerKey: string; readonly revision: string }) =>
  defineBuiltInSandboxProvider({ kind: "podman", ...options });
