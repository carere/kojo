/** JSR's npm compatibility registry uses @jsr names, including when installed with an alias. */
export const canonicalPackageName = (name: string): string => {
  for (const packageName of ["kojo-runtime", "kojo-runner-contracts", "kojo-client-contracts"]) {
    if (name === `@jsr/carere__${packageName}`) return `@carere/${packageName}`;
  }
  return name;
};
