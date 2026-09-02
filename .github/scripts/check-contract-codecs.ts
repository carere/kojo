import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contractCodecSource,
  generatedContractCodecs,
} from "./generate-contract-codecs.ts";

const root = process.cwd();
const source = readFileSync(join(root, contractCodecSource));
const stale = generatedContractCodecs.filter(
  (path) => !readFileSync(join(root, path)).equals(source),
);
if (stale.length > 0) {
  throw new Error(
    `Generated contract JSON codecs drifted: ${stale.join(", ")}. Run bun .github/scripts/generate-contract-codecs.ts.`,
  );
}
console.log(
  `contract JSON codec source matches ${generatedContractCodecs.length} generated package copies`,
);
