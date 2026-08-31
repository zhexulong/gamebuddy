import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/**
 * Detects whether the local-embedding runtime can use native ONNX or its WASM
 * fallback in an installed plugin tree.
 *
 * The plugin's `@huggingface/transformers` Node entry statically imports
 * `onnxruntime-node`. When that package or its platform binary cannot load,
 * doctor probes `onnxruntime-web` too, so it can distinguish native success,
 * a usable slower fallback, and an installation where neither runtime works.
 */

export type LocalEmbeddingRuntimeStatus =
    | { state: "ok"; binaryPath: string }
    | { state: "package-missing"; packageDir: string }
    | { state: "binary-missing"; packageDir: string; expectedBinary: string }
    | { state: "load-failed"; packageDir: string; reason: string }
    | {
          state: "wasm-fallback";
          nativeFailure: NativeLocalEmbeddingRuntimeFailure;
          wasmPath: string;
      }
    | {
          state: "both-broken";
          nativeFailure: NativeLocalEmbeddingRuntimeFailure;
          wasmReason: string;
      }
    | { state: "unknown"; reason: string };

export type NativeLocalEmbeddingRuntimeFailure = Extract<
    LocalEmbeddingRuntimeStatus,
    { state: "package-missing" | "binary-missing" | "load-failed" }
>;

export type BrokenLocalEmbeddingRuntimeStatus =
    | NativeLocalEmbeddingRuntimeFailure
    | Extract<LocalEmbeddingRuntimeStatus, { state: "both-broken" }>;

function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && code.length > 0 ? `${code}: ${message}` : message;
}

const ONNX_LOAD_PROBE_TIMEOUT_MS = 10_000;
const ONNX_LOAD_PROBE_OUTPUT_LIMIT = 800;
const ONNX_LOAD_PROBE_PACKAGE_DIR_ENV = "MAGIC_CONTEXT_ONNX_RUNTIME_NODE_PACKAGE_DIR";
const ONNX_RUNTIME_NODE_LOAD_PROBE_SCRIPT = [
    'const { createRequire } = require("node:module");',
    'const { join } = require("node:path");',
    "function describe(error) {",
    '  const message = error instanceof Error ? error.message : String(error ?? "unknown error");',
    '  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";',
    '  return code ? code + ": " + message : message;',
    "}",
    "try {",
    `  const packageDir = process.env.${ONNX_LOAD_PROBE_PACKAGE_DIR_ENV};`,
    `  if (!packageDir) throw new Error("${ONNX_LOAD_PROBE_PACKAGE_DIR_ENV} is not set");`,
    '  const req = createRequire(join(packageDir, "package.json"));',
    "  req(packageDir);",
    "  process.stdout.write(JSON.stringify({ ok: true }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, reason: describe(error) }));",
    "}",
].join("\n");

interface OnnxRuntimeLoadProbeChildResult {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
    status?: number | null;
    signal?: NodeJS.Signals | string | null;
    error?: Error | null;
}

function runOnnxRuntimeNodeLoadProbeChild(packageDir: string): OnnxRuntimeLoadProbeChildResult {
    return spawnSync(process.execPath, ["-e", ONNX_RUNTIME_NODE_LOAD_PROBE_SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, [ONNX_LOAD_PROBE_PACKAGE_DIR_ENV]: packageDir },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: ONNX_LOAD_PROBE_TIMEOUT_MS,
    });
}

let runOnnxRuntimeNodeLoadProbeChildForRuntime = runOnnxRuntimeNodeLoadProbeChild;

export function __setEmbeddingRuntimeTestHooks(hooks: {
    runOnnxRuntimeNodeLoadProbeChild?: (packageDir: string) => OnnxRuntimeLoadProbeChildResult;
}): void {
    runOnnxRuntimeNodeLoadProbeChildForRuntime =
        hooks.runOnnxRuntimeNodeLoadProbeChild ?? runOnnxRuntimeNodeLoadProbeChild;
}

function outputText(output: string | Buffer | null | undefined): string {
    if (typeof output === "string") return output;
    if (Buffer.isBuffer(output)) return output.toString("utf8");
    return "";
}

function outputSnippet(output: string | Buffer | null | undefined): string {
    const normalized = outputText(output).replace(/\s+/g, " ").trim();
    if (normalized.length <= ONNX_LOAD_PROBE_OUTPUT_LIMIT) return normalized;
    return `${normalized.slice(0, ONNX_LOAD_PROBE_OUTPUT_LIMIT)}…`;
}

function stderrSuffix(result: OnnxRuntimeLoadProbeChildResult): string {
    const stderr = outputSnippet(result.stderr);
    return stderr.length > 0 ? `; stderr: ${stderr}` : "";
}

function stdoutSuffix(result: OnnxRuntimeLoadProbeChildResult): string {
    const stdout = outputSnippet(result.stdout);
    return stdout.length > 0 ? `; stdout: ${stdout}` : "";
}

function parseOnnxProbeVerdict(output: string): { ok: boolean; reason?: string } | null {
    const candidates = output
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .reverse();
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as { ok?: unknown; reason?: unknown };
            if (typeof parsed.ok === "boolean") {
                return {
                    ok: parsed.ok,
                    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
                };
            }
        } catch {
            // Keep scanning; native loaders may print extra lines before the verdict.
        }
    }
    return null;
}

function probeOnnxRuntimeNodeLoad(
    packageDir: string,
): Extract<LocalEmbeddingRuntimeStatus, { state: "load-failed" }> | null {
    const result = runOnnxRuntimeNodeLoadProbeChildForRuntime(packageDir);
    const errorCode = (result.error as { code?: unknown } | null)?.code;
    if (errorCode === "ETIMEDOUT") {
        return {
            state: "load-failed",
            packageDir,
            reason: `probe timed out after ${ONNX_LOAD_PROBE_TIMEOUT_MS}ms${stderrSuffix(result)}`,
        };
    }
    if (result.error) {
        return {
            state: "load-failed",
            packageDir,
            reason: `probe process failed: ${describeError(result.error)}${stderrSuffix(result)}`,
        };
    }
    if (result.signal) {
        return {
            state: "load-failed",
            packageDir,
            reason: `probe terminated by signal ${result.signal}${stderrSuffix(result)}`,
        };
    }
    if (typeof result.status === "number" && result.status !== 0) {
        return {
            state: "load-failed",
            packageDir,
            reason: `probe exited with code ${result.status}${stderrSuffix(result)}`,
        };
    }

    const verdict = parseOnnxProbeVerdict(outputText(result.stdout));
    if (verdict?.ok === true) return null;
    if (verdict?.ok === false) {
        return {
            state: "load-failed",
            packageDir,
            reason: verdict.reason ?? "onnxruntime-node failed to load",
        };
    }

    return {
        state: "load-failed",
        packageDir,
        reason: `probe returned no JSON verdict${stdoutSuffix(result)}${stderrSuffix(result)}`,
    };
}

function isNativeLocalEmbeddingRuntimeFailure(
    status: LocalEmbeddingRuntimeStatus,
): status is NativeLocalEmbeddingRuntimeFailure {
    return (
        status.state === "package-missing" ||
        status.state === "binary-missing" ||
        status.state === "load-failed"
    );
}

function describeNativeFailure(status: NativeLocalEmbeddingRuntimeFailure): string {
    return status.state === "package-missing"
        ? "package is not installed"
        : status.state === "binary-missing"
          ? "expected platform binding file is absent"
          : `binding failed to load: ${status.reason}`;
}

export function isLocalEmbeddingRuntimeBroken(
    status: LocalEmbeddingRuntimeStatus,
): status is BrokenLocalEmbeddingRuntimeStatus {
    return status.state === "both-broken" || isNativeLocalEmbeddingRuntimeFailure(status);
}

export function formatLocalEmbeddingRuntimeDoctorWarning(
    status: BrokenLocalEmbeddingRuntimeStatus,
): string {
    if (status.state !== "both-broken") {
        return (
            "Embedding provider: local — onnxruntime-node native binding missing — " +
            `${describeNativeFailure(status)}; its postinstall likely failed. Embeddings will not work. ` +
            "Reinstall with network access to the npm registry and GitHub releases, " +
            "or switch `embedding.provider` to an HTTP endpoint (`openai-compatible`)."
        );
    }
    return (
        "Embedding provider: local — native runtime and WASM fallback both unavailable — " +
        `native: ${describeNativeFailure(status.nativeFailure)}; WASM: ${status.wasmReason}; ` +
        "their install or postinstall likely failed. Reinstall with network access to the npm registry and GitHub releases, " +
        "or switch `embedding.provider` to an HTTP endpoint (`openai-compatible`)."
    );
}

export function formatLocalEmbeddingRuntimeWasmFallback(
    status: Extract<LocalEmbeddingRuntimeStatus, { state: "wasm-fallback" }>,
): string {
    return (
        "Embedding provider: local — onnxruntime-node native binding failed " +
        `(${describeNativeFailure(status.nativeFailure)}); using onnxruntime-web (WASM) at ${status.wasmPath}. ` +
        "WASM inference is slower than native; a remote `openai-compatible` provider may be faster."
    );
}

/**
 * Maps `process.platform`/`process.arch` to onnxruntime-node's on-disk binary
 * layout: `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`. The dir
 * names match Node's platform/arch tokens directly (linux/darwin/win32,
 * x64/arm64), so no translation is needed beyond filtering to what ships.
 */
function expectedBinaryRelPath(platform: NodeJS.Platform, arch: string): string | null {
    const supportedPlatform = platform === "linux" || platform === "darwin" || platform === "win32";
    const supportedArch = arch === "x64" || arch === "arm64";
    if (!supportedPlatform || !supportedArch) return null;
    return join("bin", "napi-v6", platform, arch, "onnxruntime_binding.node");
}

type WasmRuntimeProbe = { state: "ok"; wasmPath: string } | { state: "failed"; reason: string };

function probeWasmRuntimeFromRequire(requireFn: NodeRequire): WasmRuntimeProbe {
    try {
        const resolved = requireFn.resolve("onnxruntime-web");
        const packageDir = packageDirFromResolved(resolved, "onnxruntime-web");
        const loadFailure = probeOnnxRuntimeNodeLoad(packageDir);
        if (loadFailure === null) return { state: "ok", wasmPath: packageDir };
        return { state: "failed", reason: loadFailure.reason };
    } catch (error) {
        return {
            state: "failed",
            reason: `onnxruntime-web is not resolvable: ${describeError(error)}`,
        };
    }
}

function withWasmFallback(
    native: LocalEmbeddingRuntimeStatus,
    probeWasm: () => WasmRuntimeProbe,
): LocalEmbeddingRuntimeStatus {
    if (!isNativeLocalEmbeddingRuntimeFailure(native)) return native;

    // Keep the tagged result rather than relying on a truthy probe value: both
    // success and failure carry data, and doctor must report the distinction.
    const wasm = probeWasm();
    if (wasm.state === "ok") {
        return { state: "wasm-fallback", nativeFailure: native, wasmPath: wasm.wasmPath };
    }
    return { state: "both-broken", nativeFailure: native, wasmReason: wasm.reason };
}

function probeWasmRuntimeAt(installRoot: string): WasmRuntimeProbe {
    const requireFn = createRequire(join(installRoot, "package.json"));
    return probeWasmRuntimeFromRequire(requireFn);
}

/**
 * Check a single install root (the directory that owns `node_modules`) for a
 * usable onnxruntime-node. `npm`/Bun hoist transitive deps, so the package lands
 * at `<installRoot>/node_modules/onnxruntime-node`.
 */
export function checkLocalEmbeddingRuntimeAt(
    installRoot: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): LocalEmbeddingRuntimeStatus {
    const packageDir = join(installRoot, "node_modules", "onnxruntime-node");
    let native: LocalEmbeddingRuntimeStatus;
    if (!existsSync(join(packageDir, "package.json"))) {
        native = { state: "package-missing", packageDir };
    } else {
        const rel = expectedBinaryRelPath(platform, arch);
        if (rel === null) {
            // Unknown platform/arch — a direct package load still proves whether
            // its own native-loader path works.
            native = probeOnnxRuntimeNodeLoad(packageDir) ?? {
                state: "ok",
                binaryPath: packageDir,
            };
        } else {
            const binaryPath = join(packageDir, rel);
            native = existsSync(binaryPath)
                ? (probeOnnxRuntimeNodeLoad(packageDir) ?? { state: "ok", binaryPath })
                : { state: "binary-missing", packageDir, expectedBinary: binaryPath };
        }
    }
    return withWasmFallback(native, () => probeWasmRuntimeAt(installRoot));
}

/**
 * Check across candidate install roots (a plugin can be cached under
 * `@pkg@latest/...` or `@pkg/...`). Returns the first `ok`; otherwise the first
 * informative failure; `unknown` only when no candidate root even exists (we
 * can't introspect the install, so we stay silent rather than false-alarm).
 */
export function checkLocalEmbeddingRuntime(
    installRoots: string[],
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): LocalEmbeddingRuntimeStatus {
    const existing = installRoots.filter((root) => existsSync(root));
    if (existing.length === 0) {
        return {
            state: "unknown",
            reason: "no installed plugin tree found to inspect",
        };
    }
    let firstFallback: Extract<LocalEmbeddingRuntimeStatus, { state: "wasm-fallback" }> | null =
        null;
    let firstFailure: LocalEmbeddingRuntimeStatus | null = null;
    for (const root of existing) {
        const status = checkLocalEmbeddingRuntimeAt(root, platform, arch);
        if (status.state === "ok") return status;
        if (status.state === "wasm-fallback") {
            if (firstFallback === null) firstFallback = status;
            continue;
        }
        if (firstFailure === null) firstFailure = status;
    }
    return firstFallback ?? firstFailure ?? { state: "unknown", reason: "no candidate roots" };
}

/** Slice a resolved module path back to its package directory (the dir that
 *  owns `node_modules/<pkg>`), so we can locate the platform binary relative to
 *  it regardless of how deep the resolved entry (`dist/index.js`) sits. */
function packageDirFromResolved(resolvedPath: string, packageName: string): string {
    const marker = `node_modules${sep}${packageName.split("/").join(sep)}`;
    const idx = resolvedPath.indexOf(marker);
    return idx >= 0 ? resolvedPath.slice(0, idx + marker.length) : dirname(resolvedPath);
}

function probeWasmRuntimeByResolution(pluginDir: string): WasmRuntimeProbe {
    try {
        const reqPlugin = createRequire(join(pluginDir, "package.json"));
        const direct = probeWasmRuntimeFromRequire(reqPlugin);
        if (
            direct.state === "ok" ||
            !direct.reason.startsWith("onnxruntime-web is not resolvable")
        ) {
            return direct;
        }

        // Use transformers as the resolution parent for pnpm's strict layout,
        // where its direct runtime dependencies are not hoisted.
        const tfResolved = reqPlugin.resolve("@huggingface/transformers");
        const tfDir = packageDirFromResolved(tfResolved, "@huggingface/transformers");
        return probeWasmRuntimeFromRequire(createRequire(join(tfDir, "package.json")));
    } catch (error) {
        return {
            state: "failed",
            reason: `could not resolve onnxruntime-web (${describeError(error)})`,
        };
    }
}

/**
 * Resolution-based variant for harnesses whose install layout is NOT a single
 * deterministic `<root>/node_modules/onnxruntime-node` (Pi: dev-path bun
 * workspace, npm-hoisted user/project install, or pnpm strict store — verified
 * empirically that the physical path differs across all three). Instead of
 * guessing a path, it asks Node's resolver exactly as the plugin would at
 * runtime: resolve onnxruntime-node FROM the installed plugin dir, then locate
 * the platform binary relative to the resolved package.
 *
 * Two resolution attempts, both layout-agnostic:
 *   A. resolve `onnxruntime-node` directly from the plugin (works when hoisted
 *      or visible to the plugin — npm/bun default).
 *   B. resolve `@huggingface/transformers` (a direct plugin dep that OWNS
 *      onnxruntime-node), then resolve onnxruntime-node from THERE — covers
 *      pnpm-strict where the transitive dep isn't visible to the plugin itself.
 *
 * Returns `unknown` (caller stays SILENT) when the plugin dir doesn't exist or
 * neither resolution succeeds in a way we can introspect — never a false alarm.
 */
export function checkLocalEmbeddingRuntimeByResolution(
    pluginDir: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): LocalEmbeddingRuntimeStatus {
    if (!existsSync(join(pluginDir, "package.json"))) {
        return { state: "unknown", reason: "plugin package dir not found" };
    }

    let onnxDir: string | null = null;
    let resolveError: string | undefined;
    try {
        const reqPlugin = createRequire(join(pluginDir, "package.json"));
        try {
            // A: direct (hoisted / bun / npm)
            onnxDir = packageDirFromResolved(
                reqPlugin.resolve("onnxruntime-node"),
                "onnxruntime-node",
            );
        } catch {
            // B: through the transformers package that owns it (pnpm strict)
            const tfResolved = reqPlugin.resolve("@huggingface/transformers");
            const tfDir = packageDirFromResolved(tfResolved, "@huggingface/transformers");
            const reqTf = createRequire(join(tfDir, "package.json"));
            onnxDir = packageDirFromResolved(reqTf.resolve("onnxruntime-node"), "onnxruntime-node");
        }
    } catch (error) {
        // Read `.code` directly off the thrown object — do NOT gate on
        // `instanceof Error`: Bun's resolver throws a `ResolveMessage` that is
        // NOT an Error instance (code "MODULE_NOT_FOUND"), Node throws
        // "ERR_MODULE_NOT_FOUND" (ESM) / "MODULE_NOT_FOUND" (CJS createRequire).
        resolveError = (error as { code?: string } | null)?.code;
        // onnxruntime-node genuinely not resolvable from the installed plugin =
        // the #128 missing-package case (only meaningful because we confirmed
        // the plugin dir exists above).
        if (resolveError === "ERR_MODULE_NOT_FOUND" || resolveError === "MODULE_NOT_FOUND") {
            return withWasmFallback(
                {
                    state: "package-missing",
                    packageDir: join(pluginDir, "node_modules", "onnxruntime-node"),
                },
                () => probeWasmRuntimeByResolution(pluginDir),
            );
        }
        return {
            state: "unknown",
            reason: `could not resolve onnxruntime-node (${resolveError ?? "unknown error"})`,
        };
    }

    if (!onnxDir) {
        return { state: "unknown", reason: "onnxruntime-node resolution produced no path" };
    }

    const rel = expectedBinaryRelPath(platform, arch);
    let native: LocalEmbeddingRuntimeStatus;
    if (rel === null) {
        // Unknown platform/arch — package resolution plus a direct load can
        // still prove whether the native loader works.
        native = probeOnnxRuntimeNodeLoad(onnxDir) ?? { state: "ok", binaryPath: onnxDir };
    } else {
        const binaryPath = join(onnxDir, rel);
        native = existsSync(binaryPath)
            ? (probeOnnxRuntimeNodeLoad(onnxDir) ?? { state: "ok", binaryPath })
            : { state: "binary-missing", packageDir: onnxDir, expectedBinary: binaryPath };
    }
    return withWasmFallback(native, () => probeWasmRuntimeByResolution(pluginDir));
}
