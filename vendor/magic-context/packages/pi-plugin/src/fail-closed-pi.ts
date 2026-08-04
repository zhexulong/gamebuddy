/**
 * Pi loud fail-closed surface when storage cannot open at boot.
 *
 * Registers the minimum hooks that prevent silent native-compaction fallthrough:
 * - `session_before_compact` always cancels (MC owns compaction when enabled)
 * - `context` throws {@link FailClosedBlockingError} on every primary pass
 *
 * Periodically re-probes storage; when open succeeds, invokes `onRecovered` so
 * the full runtime can start without a process restart.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFailClosedBlockingError,
	createFailClosedController,
	type FailClosedReason,
	isFailClosedBlockingError,
	shouldBypassFailClosedBlock,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";

const PREFIX = "[magic-context][pi]";

export function registerPiFailClosedSurface(
	pi: ExtensionAPI,
	args: {
		reason: FailClosedReason;
		tryReopen: () => Promise<ContextDatabase | null>;
		onRecovered: (db: ContextDatabase) => void | Promise<void>;
	},
): void {
	const controller = createFailClosedController();
	controller.arm(args.reason);
	let recovered = false;
	let recovering: Promise<boolean> | null = null;

	const tryRecover = async (): Promise<boolean> => {
		if (recovered) return true;
		if (recovering) return recovering;
		recovering = (async () => {
			try {
				const db = await args.tryReopen();
				if (!db) return false;
				recovered = true;
				controller.clear();
				await args.onRecovered(db);
				log(
					`${PREFIX} storage re-probe succeeded; full Magic Context runtime starting`,
				);
				return true;
			} catch (error) {
				log(
					`${PREFIX} storage re-probe failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			} finally {
				recovering = null;
			}
		})();
		return recovering;
	};

	// Keep cancelling native compaction while MC is enabled but inoperable —
	// otherwise Pi's threshold/overflow compact runs with zero MC signal.
	pi.on("session_before_compact", async () => {
		log(
			`${PREFIX} session_before_compact: cancelling — magic-context fail-closed (storage unavailable)`,
		);
		return { cancel: true };
	});

	pi.on("context", async (_event, _ctx) => {
		if (recovered) return;
		try {
			await controller.enforce({
				blockingEnabled: true,
				// Pi subagent children never load this extension (env guard in
				// index.ts). No additional agent-name exemption is required here.
				exempt: shouldBypassFailClosedBlock({ isPiSubagentEnv: false }),
				tryReopen: tryRecover,
			});
		} catch (error) {
			if (isFailClosedBlockingError(error)) throw error;
			throw createFailClosedBlockingError(
				controller.getReason() ?? args.reason,
				{ cause: error },
			);
		}
		// enforce() returned without throw only when recovered mid-pass.
	});

	log(
		`${PREFIX} fail-closed blocking surface registered (${args.reason.kind}); primary turns will error until storage recovers or the build is upgraded`,
	);
}
