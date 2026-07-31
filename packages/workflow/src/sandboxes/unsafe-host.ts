import { defineBuiltInSandboxProvider } from "../index";

/**
 * Explicitly acknowledges unisolated execution on the trusted local host.
 * Use only when the author intends to grant the command full host access.
 */
export const unsafeHost = (options: { readonly providerKey: string; readonly revision: string }) =>
  defineBuiltInSandboxProvider({ kind: "unsafe-host", unsafeAcknowledged: true, ...options });
