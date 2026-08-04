import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type DreamTaskName,
	isCanonicalDreamTask,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { runPiDreamForProject } from "../dreamer";
import { sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxDreamCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
		dreamerEnabled?: boolean;
		resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
		onProjectSeen?: (projectIdentity: string) => void;
	},
): void {
	pi.registerCommand("ctx-dream", {
		description: "Run Magic Context dreamer tasks for this project now",
		handler: async (args, ctx) => {
			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			const dreamerEnabled =
				deps.resolveDreamerEnabled?.(ctx) ?? deps.dreamerEnabled;
			deps.onProjectSeen?.(project.projectIdentity);

			// Optional single-task arg: `/ctx-dream verify`.
			const requested =
				typeof args === "string" ? args.trim() : String(args ?? "").trim();
			let task: DreamTaskName | undefined;
			if (requested) {
				if (!isCanonicalDreamTask(requested)) {
					sendCtxStatusMessage(
						pi,
						{
							title: "/ctx-dream",
							text: `## /ctx-dream\n\nUnknown task "${requested}".`,
							level: "info",
						},
						{
							projectDir: project.projectDir,
							projectIdentity: project.projectIdentity,
						},
					);
					return;
				}
				task = requested;
			}
			if (dreamerEnabled === false) {
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: "## /ctx-dream\n\nDreamer is disabled for this project (`dreamer.disable=true`).",
						level: "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
				return;
			}
			// Tell the user we're starting a real run.
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-dream",
					text: [
						"## /ctx-dream",
						"",
						task
							? `Running dream task "${task}" for ${project.projectIdentity}…`
							: `Starting dream run for ${project.projectIdentity}…`,
						`Project directory: ${project.projectDir}`,
					].join("\n"),
					level: "info",
				},
				{
					projectDir: project.projectDir,
					projectIdentity: project.projectIdentity,
				},
			);

			// Dreamer v2: run due/forced tasks now via the per-task scheduler.
			try {
				const result = await runPiDreamForProject(
					project.projectIdentity,
					task,
				);
				const lines: string[] = [];
				if (result.ran.length > 0) lines.push(`Ran: ${result.ran.join(", ")}`);
				if (result.failed.length > 0)
					lines.push(`Failed: ${result.failed.join(", ")}`);
				if (result.skippedNoWork.length > 0)
					lines.push(`Skipped (no work): ${result.skippedNoWork.join(", ")}`);
				if (result.deferredBusy.length > 0)
					lines.push(
						// "Busy" means the task's DOMAIN lease is held — usually
						// a sibling task (e.g. a scheduled verify blocking a
						// manual curate), not this task itself.
						`Busy: ${result.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`,
					);
				if (lines.length === 0) lines.push("No enabled dream tasks to run.");

				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: ["## /ctx-dream", "", ...lines].join("\n"),
						level: result.ran.length > 0 ? "success" : "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sessionLog(project.projectIdentity, `/ctx-dream failed: ${message}`);
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream run failed: ${message}`,
							"The registered timer will retry due tasks on its next tick.",
						].join("\n"),
						level: "error",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
			}
		},
	});
}
