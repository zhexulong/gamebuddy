import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.cwd(), process.argv[2] ?? "third_party/sbom-node.json");
// The project controls this fixed command; use a shell so Windows resolves
// pnpm's .cmd shim correctly.
const raw = execSync("pnpm licenses list --json", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const byLicense = JSON.parse(raw);
const packages = [];
for (const [license, entries] of Object.entries(byLicense)) {
  for (const entry of entries) {
    packages.push({
      name: entry.name,
      versions: [...entry.versions].sort(),
      license,
      homepage: entry.homepage ?? null,
    });
  }
}
packages.sort((left, right) => left.name.localeCompare(right.name) || left.versions.join(",").localeCompare(right.versions.join(",")));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
  version: 1,
  metadata: {
    component: { type: "application", name: "gamebuddy", version: "0.0.0" },
    tools: [{ vendor: "pnpm", name: "pnpm licenses list", version: "11.1.3" }],
  },
  components: packages.map((entry) => ({
    type: "library",
    name: entry.name,
    version: entry.versions.join(","),
    licenses: [{ license: { id: entry.license } }],
    externalReferences: entry.homepage === null ? [] : [{ type: "website", url: entry.homepage }],
  })),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(`Wrote ${sbom.components.length} Node dependency records to ${output}.`);
