import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublishedWindowsReparseInspector } from "../../windows-reparse-inspector/index.js";
import {
  readPublishedStardewModPackageContract,
  verifyPublishedStardewModPackage,
} from "../../stardew-mod-package-contract.js";

export type PrivateModProfileStagingDependencies = Readonly<{
  readPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>>;
  createSecret(): string;
  nowMs(): number;
}>;

export function createProductionStagingDependencies(): PrivateModProfileStagingDependencies {
  const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  return Object.freeze({
    async readPackage() {
      const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
      const contract = await readPublishedStardewModPackageContract(artifactRoot);
      await verifyPublishedStardewModPackage(artifactRoot, contract, inspector);
      return Object.freeze({
        root: resolve(artifactRoot, contract.descriptor.destination.replaceAll("/", sep)),
        entries: contract.entries,
      });
    },
    createSecret: () => `${randomUUID()}${randomUUID()}`,
    nowMs: Date.now,
  });
}
