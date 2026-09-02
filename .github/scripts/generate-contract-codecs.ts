import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
export const contractCodecSource = ".github/sources/json-codec.ts.txt";
export const generatedContractCodecs = [
  "packages/kojo-client-contracts/src/contexts/shared/codecs/json.ts",
  "packages/kojo-runner-contracts/src/contexts/shared/codecs/json.ts",
] as const;

export const generateContractCodecs = (): void => {
  const source = readFileSync(join(root, contractCodecSource));
  for (const path of generatedContractCodecs) writeFileSync(join(root, path), source);
};

if (import.meta.main) {
  generateContractCodecs();
}
