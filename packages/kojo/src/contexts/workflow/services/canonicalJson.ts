const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON permits only finite numbers");
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

export const sha256Text = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
