import { realpath } from "node:fs/promises";

export const resolveProjectSelectionPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
};
