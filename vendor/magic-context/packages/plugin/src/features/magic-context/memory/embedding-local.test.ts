import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import {
    __resetLocalEmbeddingForTests,
    __setLocalEmbeddingTestHooks,
    isNativeRuntimeMissingError,
    type LocalEmbeddingDtype,
    LocalEmbeddingProvider,
} from "./embedding-local";

afterEach(() => {
    __resetLocalEmbeddingForTests();
});

function nativeBindingLoadError(): Error & { code: string } {
    return Object.assign(
        new Error("ERR_DLOPEN_FAILED: onnxruntime-node/onnxruntime_binding.node failed to load"),
        { code: "ERR_DLOPEN_FAILED" },
    );
}

function fakeTransformersModule(options?: {
    onPipeline?: (pipelineOptions: { dtype: string; device?: string }) => void;
}): Record<string, unknown> {
    return {
        env: {},
        LogLevel: { ERROR: "error" },
        pipeline: async (
            _task: string,
            _model: string,
            pipelineOptions: { dtype: string; device?: string },
        ) => {
            options?.onPipeline?.(pipelineOptions);
            return async () => ({ data: new Float32Array([0, 1]), dims: [1, 2] });
        },
    };
}

// Part A of issue #128: classify the PERMANENT "native runtime not installed"
// failure so the provider degrades once (one actionable log line) instead of
// re-importing transformers and re-spamming the cryptic resolver error on every
// embedding. The discriminator must catch the missing-package shapes WITHOUT
// swallowing transient load errors (protobuf/EBUSY) or unrelated failures.
describe("isNativeRuntimeMissingError", () => {
    test("Bun resolver: Cannot find package 'onnxruntime-node'", () => {
        expect(
            isNativeRuntimeMissingError(new Error("Cannot find package 'onnxruntime-node'")),
        ).toBe(true);
    });

    test("Node ERR_MODULE_NOT_FOUND targeting onnxruntime-node", () => {
        const err = Object.assign(new Error("Cannot find module 'onnxruntime-node'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("Bun ResolveMessage name on onnxruntime-node", () => {
        const err = Object.assign(new Error("Could not resolve: onnxruntime-node"), {
            name: "ResolveMessage",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("transient protobuf parse failure is NOT classified as missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("Protobuf parsing failed"))).toBe(false);
    });

    test("EBUSY transient is NOT missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("EBUSY: resource busy"))).toBe(false);
    });

    test("unrelated error mentioning neither package nor module is not missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("model file checksum mismatch"))).toBe(false);
    });

    test("a generic 'cannot find module' for some OTHER package is not our runtime", () => {
        // Must mention onnxruntime-node specifically — a different missing module
        // (e.g. a user mis-config) should surface its own error, not be masked as
        // the runtime-missing degrade.
        const err = Object.assign(new Error("Cannot find package 'left-pad'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });

    test("null/undefined/non-error inputs are safe", () => {
        expect(isNativeRuntimeMissingError(null)).toBe(false);
        expect(isNativeRuntimeMissingError(undefined)).toBe(false);
        expect(isNativeRuntimeMissingError("onnxruntime-node")).toBe(false);
    });

    // #7: the package IS installed but its native binary fails to dlopen — e.g.
    // Windows missing the VC++ runtime. The error names the binding file (path
    // contains "onnxruntime") with code ERR_DLOPEN_FAILED, not "onnxruntime-node".
    test("ERR_DLOPEN_FAILED on the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error(
                "\\\\?\\C:\\...\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node " +
                    "is not a valid Win32 application.",
            ),
            { code: "ERR_DLOPEN_FAILED" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("MODULE_NOT_FOUND for the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error("Cannot find module '../bin/napi-v6/win32/x64/onnxruntime_binding.node'"),
            { code: "ERR_MODULE_NOT_FOUND" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("ERR_DLOPEN_FAILED for an UNRELATED native module is not our runtime", () => {
        const err = Object.assign(new Error("some-other-native.node failed to load"), {
            code: "ERR_DLOPEN_FAILED",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });
});

// Issue #259: the local embedding provider must thread a configured dtype into
// the transformers.js pipeline AND fold it into the model identity so switching
// dtype re-embeds rather than mixing vector spaces. The default (no dtype) must
// produce the byte-identical identity as before this field existed.
describe("LocalEmbeddingProvider dtype threading (#259)", () => {
    test("default constructor (no dtype) keeps the golden identity", () => {
        const provider = new LocalEmbeddingProvider();
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/all-MiniLM-L6-v2",
        });
        expect(provider.modelId).toBe(expected);
    });

    test("explicit fp32 dtype matches the default identity (fp32 is the default)", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 512);
        const fp32 = new LocalEmbeddingProvider(
            "Xenova/all-MiniLM-L6-v2",
            512,
            "fp32" as LocalEmbeddingDtype,
        );
        expect(fp32.modelId).toBe(noDtype.modelId);
    });

    test("a non-default dtype produces a different identity than the default", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/paraphrase-multilingual-MiniLM-L12-v2");
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(noDtype.modelId);
        // And it must equal the identity computed with local_dtype folded in.
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            local_dtype: "q8",
        });
        expect(q8.modelId).toBe(expected);
    });

    test("different non-default dtypes produce different identities", () => {
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        const int8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "int8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(int8.modelId);
    });
});

describe("LocalEmbeddingProvider native-to-WASM fallback", () => {
    test("retries a classified native load failure once with WASM and keeps that decision process-sticky", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-fallback-"));
        const logs: string[] = [];
        let nativeImports = 0;
        let wasmImports = 0;
        let wasmInjections = 0;
        const pipelineOptions: Array<{ dtype: string; device?: string }> = [];
        try {
            __setLocalEmbeddingTestHooks({
                importTransformers: async () => {
                    nativeImports++;
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => {
                    wasmInjections++;
                    return true;
                },
                importTransformersWasmFallback: async () => {
                    wasmImports++;
                    return fakeTransformersModule({
                        onPipeline: (options) => pipelineOptions.push(options),
                    });
                },
                modelCacheDir: () => cacheDir,
                log: (message) => logs.push(message),
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
            expect(wasmInjections).toBe(1);
            expect(pipelineOptions).toEqual([{ dtype: "fp32", device: "auto" }]);
            expect(logs).toContainEqual(
                expect.stringContaining("WASM inference is slower than native"),
            );
            expect(logs).toContainEqual(expect.stringContaining("openai-compatible"));

            // A second provider must use the selected WASM path directly rather
            // than attempting the known-broken native import again.
            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(2);
            expect(wasmInjections).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("latches disabled and routes to doctor only when native and WASM both fail", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-both-broken-"));
        const logs: string[] = [];
        let nativeImports = 0;
        let wasmImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                importTransformers: async () => {
                    nativeImports++;
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => true,
                importTransformersWasmFallback: async () => {
                    wasmImports++;
                    throw new Error("Cannot find package 'onnxruntime-web'");
                },
                modelCacheDir: () => cacheDir,
                log: (message) => logs.push(message),
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(false);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
            expect(logs).toContainEqual(
                expect.stringContaining("both the onnxruntime-node native"),
            );
            expect(logs).toContainEqual(
                expect.stringContaining("npx @cortexkit/magic-context@latest doctor"),
            );

            expect(await new LocalEmbeddingProvider().initialize()).toBe(false);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("Electron keeps its early WASM injection path without a second fallback initialization", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-electron-wasm-"));
        let importsAfterEarlyInjection = 0;
        let fallbackImports = 0;
        let wasmInjections = 0;
        try {
            __setLocalEmbeddingTestHooks({
                isElectron: () => true,
                injectWasmOrt: async () => {
                    wasmInjections++;
                    return true;
                },
                importTransformers: async () => {
                    importsAfterEarlyInjection++;
                    return fakeTransformersModule();
                },
                importTransformersWasmFallback: async () => {
                    fallbackImports++;
                    throw new Error("Electron must not initialize a second WASM fallback");
                },
                modelCacheDir: () => cacheDir,
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(wasmInjections).toBe(1);
            expect(importsAfterEarlyInjection).toBe(1);
            expect(fallbackImports).toBe(0);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
