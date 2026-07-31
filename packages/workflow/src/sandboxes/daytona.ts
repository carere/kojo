import { defineBuiltInSandboxProvider } from "../index";

/** Immutable Daytona Sandbox Provider definition. Credentials resolve in the Host. */
export const daytona = (options: { readonly providerKey: string; readonly revision: string }) =>
  defineBuiltInSandboxProvider({ kind: "daytona", ...options });
