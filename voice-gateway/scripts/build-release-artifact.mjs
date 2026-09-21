import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { build } from "esbuild";

/**
 * Voice Gateway release bundle step (single-file artifact contract).
 *
 * Bundles `voice-gateway/dist/main.js` (and the pinned
 * `@gamebuddy/voice-protocol` package it imports) into one self-contained ESM
 * file at `voice-gateway/.dist/entry/voice-gateway-entry.mjs`, and bundles the
 * protocol package into one file at
 * `voice-gateway/.dist/protocol/voice-protocol-index.mjs`. Production staging
 * (`ensureVoiceGateway`) consumes exactly these two single-file directories;
 * `voice-artifact-fixture-publisher` rejects anything else.
 *
 * The gateway reads its native audio helpers through
 * `new URL("../windows-waveout.ps1" | "../windows-wavein.ps1", import.meta.url)`
 * at runtime. Because the bundled entry lives in `entry/`, those URLs resolve
 * next to it — so this step copies both PowerShell scripts from the package
 * root into `voice-gateway/.dist/`.
 *
 * The bundle must stay self-contained: only `node:` builtins may remain
 * external, and this step fails closed if the entry output still imports any
 * bare package after bundling.
 */

const scriptPath = fileURLToPath(import.meta.url);
const voiceGatewayRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(voiceGatewayRoot, "..");
const distRoot = resolve(voiceGatewayRoot, "dist");
const protocolDistRoot = resolve(repositoryRoot, "packages", "voice-protocol", "dist");
const outputRoot = resolve(voiceGatewayRoot, ".dist");

/** `node:` builtins stay external; platform=node keeps bare builtins external
 * too, and the post-bundle assertion fails closed on any other bare import. */
const EXTERNAL = ["node:*"];

const esbuildVersion = createRequire(import.meta.url)("esbuild").version;

export const releaseArtifactOutputs = Object.freeze({
  outputRoot,
  entryPath: resolve(outputRoot, "entry", "voice-gateway-entry.mjs"),
  protocolPath: resolve(outputRoot, "protocol", "voice-protocol-index.mjs"),
  waveOutScript: resolve(outputRoot, "windows-waveout.ps1"),
  waveInScript: resolve(outputRoot, "windows-wavein.ps1"),
});

const esbuildOptions = (entryPoints, outfile) => ({
  entryPoints: [entryPoints],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: EXTERNAL,
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

/** Fail closed on any remaining bare-package import (would break on the
 * bundled runtime where no node_modules exists). */
async function assertNoExternalPackageImports(artifactPath) {
  const source = await readFile(artifactPath, "utf8");
  for (const match of source.matchAll(/\bfrom\s+"([^".][^"]*)"/g)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    throw new Error(`voice_release_bundle_external_package_import: ${match[0]}`);
  }
}

async function assertSingleFileDirectory(directory, label) {
  const state = await stat(directory).catch(() => undefined);
  if (!state || !state.isDirectory()) throw new Error(`voice_release_bundle_${label}_missing`);
  const files = await readdir(directory);
  if (files.length !== 1) throw new Error(`voice_release_bundle_${label}_must_be_single_file`);
  const path = resolve(directory, files[0]);
  const fileState = await stat(path);
  if (!fileState.isFile()) throw new Error(`voice_release_bundle_${label}_invalid`);
  return { path, bytes: fileState.size };
}

export async function buildReleaseArtifact() {
  const [entrySource, protocolSource, waveOutSource, waveInSource] = [
    resolve(distRoot, "main.js"),
    resolve(protocolDistRoot, "index.js"),
    resolve(voiceGatewayRoot, "windows-waveout.ps1"),
    resolve(voiceGatewayRoot, "windows-wavein.ps1"),
  ];
  for (const [label, path] of [["entry_source", entrySource], ["protocol_source", protocolSource], ["wave_out_source", waveOutSource], ["wave_in_source", waveInSource]]) {
    const state = await stat(path).catch(() => undefined);
    if (!state || !state.isFile()) throw new Error(`voice_release_bundle_${label}_missing: ${relative(voiceGatewayRoot, path)}`);
  }

  // Fresh immutable-ish output: stale files must never make entry/protocol
  // multi-file after a rebuild.
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "entry"), { recursive: true });
  await mkdir(resolve(outputRoot, "protocol"), { recursive: true });

  const { entryPath, protocolPath, waveOutScript, waveInScript } = releaseArtifactOutputs;
  const [{ metafile: entryMetafile }, { metafile: protocolMetafile }] = await Promise.all([
    build({ ...esbuildOptions(entrySource, entryPath), metafile: true }),
    build({ ...esbuildOptions(protocolSource, protocolPath), metafile: true }),
  ]);
  await Promise.all([
    copyFile(waveOutSource, waveOutScript),
    copyFile(waveInSource, waveInScript),
  ]);

  const bundleSource = await readFile(entryPath, "utf8");
  for (const scriptName of ["windows-waveout.ps1", "windows-wavein.ps1"]) {
    if (!bundleSource.includes(scriptName)) throw new Error(`voice_release_bundle_missing_script_reference: ${scriptName}`);
  }
  await assertNoExternalPackageImports(entryPath);
  await assertNoExternalPackageImports(protocolPath);

  const [entry, protocol] = await Promise.all([
    assertSingleFileDirectory(resolve(outputRoot, "entry"), "entry"),
    assertSingleFileDirectory(resolve(outputRoot, "protocol"), "protocol"),
  ]);
  const [waveOut, waveIn] = await Promise.all([stat(waveOutScript), stat(waveInScript)]);
  for (const [label, state] of [["wave_out", waveOut], ["wave_in", waveIn]]) {
    if (!state.isFile()) throw new Error(`voice_release_bundle_${label}_invalid`);
  }

  const entryInputs = Object.keys(entryMetafile.inputs).sort();
  const protocolInputs = Object.keys(protocolMetafile.inputs).sort();
  return Object.freeze({
    esbuildVersion,
    entry: { path: entry.path, bytes: entry.bytes, inputs: entryInputs },
    protocol: { path: protocol.path, bytes: protocol.bytes, inputs: protocolInputs },
    waveOut: { path: waveOutScript, bytes: waveOut.size },
    waveIn: { path: waveInScript, bytes: waveIn.size },
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  buildReleaseArtifact()
    .then((report) => {
      const { entry, protocol, waveOut, waveIn } = report;
      console.log(`esbuild ${report.esbuildVersion}`);
      console.log(`entry:    ${relative(voiceGatewayRoot, entry.path)} (${entry.bytes} bytes, ${entry.inputs.length} inputs)`);
      console.log(`protocol: ${relative(voiceGatewayRoot, protocol.path)} (${protocol.bytes} bytes, ${protocol.inputs.length} inputs)`);
      console.log(`waveout:  ${relative(voiceGatewayRoot, waveOut.path)} (${waveOut.bytes} bytes)`);
      console.log(`wavein:   ${relative(voiceGatewayRoot, waveIn.path)} (${waveIn.bytes} bytes)`);
    })
    .catch((error) => {
      console.error(`voice_release_bundle_failed: ${error.message}`);
      process.exitCode = 1;
    });
}