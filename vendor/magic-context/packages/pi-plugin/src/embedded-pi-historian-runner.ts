import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	stream,
	type Api,
	type Context,
	type Model,
} from "@earendil-works/pi-ai/compat";
import type {
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

/**
 * GameBuddy's historian runner: a hidden, no-tool, one-shot request through
 * the ModelRegistry of the already embedded Pi SDK. Unlike PiSubagentRunner it
 * never starts `pi`, never opens a user Pi session, and never exposes tools.
 */
export class EmbeddedPiHistorianRunner implements SubagentRunner {
	readonly harness = "pi-embedded-sdk";
	private registry: ModelRegistry | undefined;

	constructor(
		private readonly streamCall: typeof stream = stream,
	) {}

	bindModelRegistry(registry: ModelRegistry): void {
		this.registry = registry;
	}

	async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
		const startedAt = Date.now();
		const fail = (
			reason: Extract<SubagentRunResult, { ok: false }> ["reason"],
			error: string,
			transient = false,
		): SubagentRunResult => ({
			ok: false,
			reason,
			error,
			durationMs: Date.now() - startedAt,
			...(transient ? { transient: true } : {}),
		});
		if (options.signal?.aborted) return fail("abort", "embedded historian aborted by caller");
		if (!this.registry) return fail("spawn_failed", "embedded historian ModelRegistry is not bound", true);
		if (!options.model) return fail("model_failed", "embedded historian requires a configured model");

		const slash = options.model.indexOf("/");
		if (slash <= 0 || slash === options.model.length - 1) {
			return fail("model_failed", "embedded historian model must be provider/model");
		}
		const providerId = options.model.slice(0, slash);
		const modelId = options.model.slice(slash + 1);
		const model = this.registry.find(providerId, modelId);
		if (!model) return fail("model_failed", `embedded historian model unavailable: ${options.model}`, true);

		const auth = await this.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) return fail("model_failed", auth.error, true);
		const controller = new AbortController();
		const abort = () => controller.abort();
		let timedOut = false;
		options.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.timeoutMs ?? 120_000);
		try {
			const context: Context = {
				systemPrompt: options.systemPrompt,
				messages: [{ role: "user", content: options.userMessage, timestamp: Date.now() }],
				// No tools: historian has no side effects and no player expression path.
				tools: [],
			};
			const events = this.streamCall(model as Model<Api>, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: controller.signal,
				...(options.thinkingLevel ? { reasoningEffort: options.thinkingLevel } : {}),
			});
			let final: { stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
			for await (const event of events) {
				const typed = event as { type?: string; message?: typeof final; error?: typeof final };
				if (typed.type === "done") final = typed.message;
				if (typed.type === "error") final = typed.error;
			}
			if (controller.signal.aborted) {
				return fail(options.signal?.aborted ? "abort" : "timeout", options.signal?.aborted ? "embedded historian aborted by caller" : "embedded historian timed out", true);
			}
			if (!final || final.stopReason === "error" || final.stopReason === "aborted") {
				return fail("model_failed", final?.errorMessage ?? "embedded historian returned no final assistant message", true);
			}
			if (final.stopReason === "length") return fail("truncated", "embedded historian output was truncated", true);
			const assistantText = (final.content ?? [])
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text ?? "")
				.join("")
				.trim();
			return assistantText.length > 0
				? { ok: true, assistantText, durationMs: Date.now() - startedAt, toolCallCount: 0 }
				: fail("no_assistant", "embedded historian returned no text", true);
		} catch (error) {
			return fail(
				controller.signal.aborted ? (options.signal?.aborted ? "abort" : "timeout") : "model_failed",
				timedOut ? "embedded historian timed out" : error instanceof Error ? error.message : String(error),
				true,
			);
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}
}
