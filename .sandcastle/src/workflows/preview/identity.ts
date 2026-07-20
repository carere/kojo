import { createHash } from "node:crypto";
import { PreviewIdentity } from "../../types/preview";

const shortHash = (value: string, length = 8) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

const branchSlug = (branch: string) => {
  const slug = branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 36)
    .replaceAll(/-+$/g, "");
  return slug || "branch";
};

export const createPreviewIdentity = (branch: string, repositoryRoot: string) => {
  const slug = branchSlug(branch);
  const branchId = shortHash(branch);
  const repositoryId = shortHash(repositoryRoot, 12);

  return new PreviewIdentity({
    branch,
    containerName: `delimoov-preview-${slug.slice(0, 28)}-${branchId}-${repositoryId.slice(0, 6)}`,
    hostname: `${slug}-${branchId}.delimoov.localhost`,
    repositoryId,
  });
};
