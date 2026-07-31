const safeInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0 ? value : undefined;

export const parseRetentionDuration = (input: string): number | null | undefined => {
  if (input === "off") return null;
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(input);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const multiplier = {
    ms: 1,
    s: 1_000,
    m: 60 * 1_000,
    h: 60 * 60 * 1_000,
    d: 24 * 60 * 60 * 1_000,
    w: 7 * 24 * 60 * 60 * 1_000,
  }[match[2] as "ms" | "s" | "m" | "h" | "d" | "w"];
  return safeInteger(amount * multiplier);
};

export const parseRetentionSize = (input: string): number | null | undefined => {
  if (input === "off") return null;
  const match = /^(\d+)(B|KiB|MiB|GiB|TiB)$/.exec(input);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const multiplier = {
    B: 1,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  }[match[2] as "B" | "KiB" | "MiB" | "GiB" | "TiB"];
  return safeInteger(amount * multiplier);
};
