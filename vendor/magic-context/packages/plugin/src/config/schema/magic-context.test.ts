import { describe, expect, it } from "bun:test";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_HISTORY_BUDGET_PERCENTAGE,
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    type MagicContextConfig,
    MagicContextConfigSchema,
} from "./magic-context";

describe("MagicContextConfigSchema", () => {
    describe("defaults", () => {
        it("applies defaults for an empty config", () => {
            const result = MagicContextConfigSchema.parse({});

            expect(result).toMatchObject({
                enabled: true,
                fail_closed_blocking: true,
                transform_mode: "ts",
                cache_ttl: "5m",
                execute_threshold_percentage: 65,
                protected_tags: 20,
                clear_reasoning_age: 50,
                history_budget_percentage: DEFAULT_HISTORY_BUDGET_PERCENTAGE,
                historian_timeout_ms: DEFAULT_HISTORIAN_TIMEOUT_MS,
                embedding: {
                    provider: "local",
                    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
                },
                memory: {
                    enabled: true,
                    domain: "coding-project",
                    injection_budget_tokens: 4000,
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                },
                todowrite: {
                    enabled: true,
                    overlay: true,
                },
            });
            expect(result.historian).toBeUndefined();
            expect(result.dreamer).toBeUndefined();
            expect(result.sidekick).toBeUndefined();
            expect(result.pi).toBeUndefined();
        });
    });

    describe("valid config", () => {
        it("parses an enabled config without stale reduction-specific keys", () => {
            const input = {
                enabled: true,
                fail_closed_blocking: true,
                experimental: { mural: { enabled: false } },
                transform_mode: "ts",
                auto_update: false,
                toast_duration_ms: 5000,
                cache_ttl: "10m",
                protected_tags: 3,
                execute_threshold_percentage: 75,
                clear_reasoning_age: 60,
                history_budget_percentage: 0.2,
                historian_timeout_ms: 360_000,
                commit_cluster_trigger: {
                    enabled: true,
                    min_clusters: 3,
                },
                sqlite: {
                    cache_size_mb: 64,
                    mmap_size_mb: 0,
                },
                system_prompt_injection: {
                    enabled: true,
                    skip_signatures: ["<!-- magic-context: skip -->"],
                },
                temporal_awareness: false,
                keep_subagents: false,
                todowrite: {
                    enabled: false,
                    overlay: false,
                },
                smart_drops: false,
                shadow_embedding: {
                    enabled: false,
                },
                caveman_text_compression: {
                    enabled: false,
                    min_chars: 500,
                },
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "http://localhost:1234/v1",
                    model: "text-embedding-3-small",
                    api_key: "secret-embedding",
                },
                memory: {
                    enabled: true,
                    domain: "ongoing-interaction",
                    injection_budget_tokens: 4000,
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                    auto_search: {
                        enabled: false,
                        score_threshold: 0.6,
                        min_prompt_chars: 20,
                    },
                    git_commit_indexing: {
                        enabled: false,
                        since_days: 365,
                        max_commits: 2000,
                    },
                },
                pi: {
                    subagent_extensions: ["@example/provider", "./extensions/local.ts"],
                },
                sidekick: {
                    disable: false,
                    model: "qwen-test",
                    fallback_models: ["qwen-fallback"],
                    temperature: 0.1,
                    variant: "fast",
                    timeout_ms: 12_000,
                    system_prompt: "Custom prompt",
                },
            } satisfies MagicContextConfig;

            const result = MagicContextConfigSchema.parse(input);

            expect(result).toEqual(input);
        });

        it("applies sidekick defaults when the object is present", () => {
            const result = MagicContextConfigSchema.parse({
                sidekick: {
                    model: "github-copilot/gpt-5.4",
                },
            });

            expect(result.sidekick).toEqual({
                model: "github-copilot/gpt-5.4",
                timeout_ms: 30000,
            });
        });

        it("accepts disable on hidden agents and strips deprecated top-level enabled", () => {
            const result = MagicContextConfigSchema.parse({
                historian: { disable: true },
                dreamer: {
                    disable: true,
                    enabled: true,
                    // Dreamer v2: per-task config. review-user-memories disabled,
                    // maintain-docs scheduled.
                    tasks: {
                        "review-user-memories": { schedule: "" },
                        "maintain-docs": { schedule: "0 * * * *" },
                    },
                },
                sidekick: { disable: true, enabled: true },
            });

            expect(result.historian?.disable).toBe(true);
            expect(result.dreamer?.disable).toBe(true);
            expect(result.sidekick?.disable).toBe(true);
            expect("enabled" in (result.dreamer as Record<string, unknown>)).toBe(false);
            expect("enabled" in (result.sidekick as Record<string, unknown>)).toBe(false);
            expect(result.dreamer?.tasks["review-user-memories"].schedule).toBe("");
            expect(result.dreamer?.tasks["maintain-docs"].schedule).toBe("0 * * * *");
            expect(result.dreamer?.tasks["classify-memories"].schedule).toBe("0 6 * * *");
            expect(result.dreamer?.tasks.retrospective.schedule).toBe("0 5 * * *");
        });

        it("defaults classify-memories and retrospective on daily in dreamer task schema", () => {
            const result = MagicContextConfigSchema.parse({ dreamer: { model: "x/y" } });
            expect(result.dreamer?.tasks["classify-memories"].schedule).toBe("0 6 * * *");
            expect(result.dreamer?.tasks.retrospective.schedule).toBe("0 5 * * *");
        });

        it("parses both transform modes", () => {
            expect(MagicContextConfigSchema.parse({ transform_mode: "ts" }).transform_mode).toBe(
                "ts",
            );
            expect(MagicContextConfigSchema.parse({ transform_mode: "rust" }).transform_mode).toBe(
                "rust",
            );
        });

        it("accepts optional auto_update user preference", () => {
            expect(MagicContextConfigSchema.parse({ auto_update: false }).auto_update).toBe(false);
            expect(MagicContextConfigSchema.parse({ auto_update: true }).auto_update).toBe(true);
        });

        it("accepts an explicitly configured Pi subagent extension allowlist", () => {
            expect(
                MagicContextConfigSchema.parse({
                    pi: { subagent_extensions: ["provider-package", "./local.ts"] },
                }).pi,
            ).toEqual({ subagent_extensions: ["provider-package", "./local.ts"] });
        });

        it("accepts and normalizes 2-letter ISO 639-1 language codes", () => {
            expect(MagicContextConfigSchema.parse({ language: "tr" }).language).toBe("tr");
            expect(MagicContextConfigSchema.parse({ language: "  ES " }).language).toBe("es");
            expect(MagicContextConfigSchema.parse({ language: "ja" }).language).toBe("ja");
        });

        it("parses per-model cache_ttl objects", () => {
            const input = {
                cache_ttl: {
                    default: "5m",
                    "claude-3-haiku": "10m",
                    "gpt-4": "2m",
                },
            };

            const result = MagicContextConfigSchema.parse(input);

            expect(result.cache_ttl).toEqual(input.cache_ttl);
        });
    });

    describe("validation", () => {
        it("rejects an unknown transform mode", () => {
            expect(() => MagicContextConfigSchema.parse({ transform_mode: "wasm" })).toThrow();
        });

        it("rejects empty Pi subagent extension entries", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ pi: { subagent_extensions: ["  "] } }),
            ).toThrow();
        });

        it("rejects protected_tags greater than 100", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 101 })).toThrow();
        });

        it("rejects protected_tags less than 1", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 0 })).toThrow();
        });

        it("accepts protected_tags boundary values", () => {
            expect(MagicContextConfigSchema.parse({ protected_tags: 1 }).protected_tags).toBe(1);
            expect(MagicContextConfigSchema.parse({ protected_tags: 20 }).protected_tags).toBe(20);
        });

        it("rejects clear_reasoning_age below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ clear_reasoning_age: 9 })).toThrow();
        });

        it("rejects historian_timeout_ms below minimum", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ historian_timeout_ms: 59_999 }),
            ).toThrow();
        });

        it("rejects non-code output language values", () => {
            expect(() => MagicContextConfigSchema.parse({ language: "Turkish" })).toThrow(); // full name
            expect(() => MagicContextConfigSchema.parse({ language: "tur" })).toThrow(); // 3-letter
            expect(() => MagicContextConfigSchema.parse({ language: "zz" })).toThrow(); // unknown code
            expect(() => MagicContextConfigSchema.parse({ language: "<x>" })).toThrow();
        });

        it("rejects openai-compatible embedding config without endpoint", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        model: "text-embedding-3-small",
                    },
                }),
            ).toThrow();
        });

        it("rejects openai-compatible embedding config without model", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        endpoint: "http://localhost:1234/v1",
                    },
                }),
            ).toThrow();
        });
    });
});
