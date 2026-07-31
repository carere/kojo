import { defineBuiltInSandboxProvider } from "../index";

/** Immutable Vercel Sandbox Provider definition. Credentials resolve in the Host. */
export const vercel = (options: { readonly providerKey: string; readonly revision: string }) =>
  defineBuiltInSandboxProvider({ kind: "vercel", ...options });
