/** A random Gate capability that is safe as a positional CLI argument. */
export const createGateToken = (): string =>
  `gate_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
