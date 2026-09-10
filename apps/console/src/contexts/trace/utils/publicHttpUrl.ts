/** Only HTTP(S) links without embedded credentials can leave the Run view. */
export const publicHttpUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
