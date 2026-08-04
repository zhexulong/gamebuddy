import { describe, expect, test } from "bun:test";
import { isNativeRuntimeMissingError } from "./embedding-local";

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
