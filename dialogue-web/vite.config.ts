import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  createBuildArtifactInspectionPolicy,
  createProductionArtifactManifest,
  type BrowserArtifactInspectionPolicy,
} from "./scripts/browser-artifact-manifest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const normalOutputDirectory = resolve(packageRoot, "dist");
const privateStagingParent = resolve(packageRoot, ".build-staging");
const PRIVATE_STAGING_LEAF = /^[a-f0-9]{32}$/;

function isChildOf(parent: string, path: string) {
  const remainder = relative(parent, path);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

function privateOutputArgument() {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--outDir") {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("-")) throw new TypeError("Private browser output requires one --outDir value");
      values.push(value);
      index += 1;
    } else if (argument.startsWith("--outDir=")) {
      values.push(argument.slice("--outDir=".length));
    }
  }
  if (values.length > 1) throw new TypeError("Private browser output accepts exactly one --outDir value");
  return values[0];
}

async function assertRegularDirectory(path: string, message: string) {
  let state;
  try {
    state = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TypeError(message);
    throw error;
  }
  if (!state.isDirectory() || state.isSymbolicLink() || (await realpath(path)) !== path) throw new TypeError(message);
}

async function validatePrivateOutputDirectory(value: string, requireEmpty: boolean) {
  if (!isAbsolute(value) || value !== resolve(value)) {
    throw new TypeError("Private browser output must be a normalized absolute directory");
  }
  if (
    !isChildOf(privateStagingParent, value) ||
    dirname(value) !== privateStagingParent ||
    !PRIVATE_STAGING_LEAF.test(value.slice(privateStagingParent.length + 1))
  ) {
    throw new TypeError("Private browser output must be an opaque direct child of the browser-owned staging parent");
  }
  await assertRegularDirectory(privateStagingParent, "Private browser staging parent must be a non-link directory");
  await assertRegularDirectory(value, "Private browser output directory must already exist as a non-link directory");
  if (requireEmpty && (await readdir(value)).length !== 0) {
    throw new TypeError("Private browser output directory must be empty");
  }
  return value;
}

const productionArtifactManifest = (
  outputDirectory: string,
  privateOutputDirectory: boolean,
  inspectionPolicy: BrowserArtifactInspectionPolicy,
): Plugin => ({
  name: "gamebuddy-production-artifact-manifest",
  apply: "build",
  async closeBundle() {
    // Re-check the Host-precreated staging leaf after Vite writes it. Node has
    // no portable atomic no-follow directory handle API, so this narrows the
    // pre-build/closeBundle replacement window but does not claim arbitrary
    // Windows reparse protection (design/42 remains blocked).
    if (privateOutputDirectory) await validatePrivateOutputDirectory(outputDirectory, false);
    await createProductionArtifactManifest(outputDirectory, inspectionPolicy);
  },
});

export default defineConfig(async ({ command }) => {
  const isBuild = command === "build";
  const requestedOutputDirectory = isBuild ? privateOutputArgument() : undefined;
  const outputDirectory = requestedOutputDirectory
    ? await validatePrivateOutputDirectory(requestedOutputDirectory, true)
    : normalOutputDirectory;
  const inspectionPolicy = isBuild
    ? await createBuildArtifactInspectionPolicy()
    : Object.freeze({ inspect: async () => {} });

  return {
    root: packageRoot,
    plugins: [
      react(),
      productionArtifactManifest(outputDirectory, requestedOutputDirectory !== undefined, inspectionPolicy),
    ],
    build: {
      outDir: outputDirectory,
      emptyOutDir: requestedOutputDirectory ? false : true,
      sourcemap: false,
      manifest: false,
    },
  };
});
