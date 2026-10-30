// friction-ledger —— 只记账的被动传感器。
//
// 目的：把"宣称完成时没验证""上游错误停摆""尾部悬空"这三件本来只存在于人类记忆里的事，
// 变成一行可复算的事实。不调模型、不发网络、不改任何会话行为；任何异常都被吞掉，
// 因为诊断代码绝不允许影响会话本身。
//
// 落盘位置：<cwd>/.pi/friction-ledger.jsonl（该目录已存在时），否则 agent 目录下的
// friction-ledger.jsonl。每条记录带 leafEntryId —— 那是一个持久游标，事后可以只读地
// 从它回走祖先链，重建"模型做决定那一刻"的上下文，不需要 --fork，也不会被后续轮次冲掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const LEDGER_NAME = "friction-ledger.jsonl";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 400;
const MAX_TRACKED_PATHS = 8;

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cs|csproj|sln|css|scss|json|yml|yaml|py|rs|go|sql)$/i;
const VERIFY_CMD =
	/(^|[\s;&|])(node\s+--test|node\s+--import\s+tsx\s+--test|node\s+\S*run-test-suite|node\s+\S*build-test-artifact|node\s+\S*test-artifact|bun\s+test|vitest|playwright|npx\s+tsc|pnpm\s+test|npm\s+test|pnpm\s+\S*:test)|([\s;&|]|^)\S*[\\/]?tsc(\.js)?(\s|$)/i;
const GATE_CMD = /(audit-[a-z0-9-]+|check-[a-z0-9-]+|preflight-live-run|audit-totality)/i;

const EDIT_TOOLS = new Set(["edit", "write", "ast_grep_replace", "aft_import", "multi_edit"]);

interface RunState {
	startedAt: number | null;
	startEntryId: string | null;
	turns: number;
	toolCalls: number;
	openCalls: Set<string>;
	verifyCalls: Set<string>;
	codeEdits: number;
	codeEditPaths: string[];
	docEdits: number;
	verifyAttempts: number;
	verifyFailures: number;
	verifySinceLastCodeEdit: boolean;
	lastVerifyOk: boolean | null;
	lastCodeEditAt: number | null;
	stopReason: string | null;
	errorMessage: string | null;
	model: string | null;
}

function freshState(): RunState {
	return {
		startedAt: null,
		startEntryId: null,
		turns: 0,
		toolCalls: 0,
		openCalls: new Set(),
		verifyCalls: new Set(),
		codeEdits: 0,
		codeEditPaths: [],
		docEdits: 0,
		verifyAttempts: 0,
		verifyFailures: 0,
		verifySinceLastCodeEdit: false,
		lastVerifyOk: null,
		lastCodeEditAt: null,
		stopReason: null,
		errorMessage: null,
		model: null,
	};
}

function redact(text: string): string {
	return text
		.replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
		.replace(/(Bearer\s+[A-Za-z0-9._-]{8,})/gi, "[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi, "$1[REDACTED]");
}

function classifyError(message: string | null): string {
	if (!message) return "unknown";
	const m = message.toLowerCase();
	if (/429|rate[_\s-]?limit|too many requests/.test(m)) return "rate_limit_429";
	if (/502|bad gateway|upstream request failed|upstream_error/.test(m)) return "upstream_502";
	if (/503|service unavailable|overloaded|529/.test(m)) return "overloaded_5xx";
	if (/504|gateway timeout/.test(m)) return "gateway_timeout_504";
	if (/timeout|timed out|etimedout/.test(m)) return "timeout";
	if (/401|403|unauthori|invalid[_\s-]*api[_\s-]*key|quota|credit|billing/.test(m)) return "auth_or_quota";
	if (/context|too long|maximum context|length/i.test(m)) return "context";
	if (/abort|cancel/.test(m)) return "abort";
	return "other";
}

function ledgerPathFor(cwd: string): string {
	const projectPi = path.join(cwd, ".pi");
	try {
		if (fs.existsSync(projectPi) && fs.statSync(projectPi).isDirectory()) {
			return path.join(projectPi, LEDGER_NAME);
		}
	} catch {}
	return path.join(AGENT_DIR, LEDGER_NAME);
}

function append(record: unknown, cwd: string): void {
	const file = ledgerPathFor(cwd);
	const dir = path.dirname(file);
	try {
		fs.mkdirSync(dir, { recursive: true });
		const st = fs.statSync(file);
		if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.${Date.now()}.old`);
	} catch {}
	fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

function pathOf(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const v = a[key];
		if (typeof v === "string" && v) return v;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let state = freshState();

	function settle(ctx: any, aborted: boolean): void {
		if (state.startedAt === null) return;

		let leafEntryId: string | null = null;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		try {
			leafEntryId = ctx?.sessionManager?.getLeafId?.() ?? null;
			sessionFile = ctx?.sessionManager?.getSessionFile?.();
			sessionId = ctx?.sessionManager?.getSessionId?.();
			if (sessionFile) {
				sessionFile = path.resolve(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(), sessionFile);
			}
		} catch {}

		const unverifiedCodeStop =
			state.codeEdits > 0 && !state.verifySinceLastCodeEdit;

		const record = {
			v: 1,
			at: new Date().toISOString(),
			cwd: typeof ctx?.cwd === "string" ? ctx.cwd : undefined,
			sessionId,
			sessionFile,
			leafEntryId,
			startEntryId: state.startEntryId,
			model: state.model,
			aborted,
			durationMs: Date.now() - state.startedAt,
			turns: state.turns,
			toolCalls: state.toolCalls,
			codeEdits: state.codeEdits,
			docEdits: state.docEdits,
			codeEditPaths: state.codeEditPaths.slice(0, MAX_TRACKED_PATHS),
			verifyAttempts: state.verifyAttempts,
			verifyFailures: state.verifyFailures,
			lastVerifyOk: state.lastVerifyOk,
			unverifiedCodeStop,
			msSinceLastCodeEdit:
				state.lastCodeEditAt === null ? null : Date.now() - state.lastCodeEditAt,
			danglingToolCalls: state.openCalls.size,
			danglingToolNames: [...state.openCalls].slice(0, MAX_TRACKED_PATHS),
			stopReason: state.stopReason,
			errorSignature:
				state.stopReason === "error" || aborted ? classifyError(state.errorMessage) : null,
			errorMessage: state.errorMessage
				? redact(state.errorMessage).slice(0, MAX_ERROR_CHARS)
				: null,
		};

		try {
			append(record, typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd());
		} catch {}
	}

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		try {
			state = freshState();
			state.startedAt = Date.now();
			state.startEntryId = ctx?.sessionManager?.getLeafId?.() ?? null;
			const m = ctx?.model;
			state.model =
				m && typeof m === "object"
					? `${m.provider ?? ""}/${m.id ?? m.modelId ?? ""}`.replace(/^\/|\/$/g, "")
					: null;
		} catch {}
	});

	pi.on("turn_start", async () => {
		try {
			state.turns++;
		} catch {}
	});

	pi.on("message_end", async (event: any) => {
		try {
			const msg = event?.message;
			if (!msg || msg.role !== "assistant") return;
			if (typeof msg.stopReason === "string") state.stopReason = msg.stopReason;
			if (typeof msg.errorMessage === "string" && msg.errorMessage) {
				state.errorMessage = msg.errorMessage;
			}
		} catch {}
	});

	pi.on("tool_execution_start", async (event: any) => {
		try {
			const name = String(event?.toolName ?? "");
			state.toolCalls++;
			if (event?.toolCallId) state.openCalls.add(`${name}:${event.toolCallId}`);

			if (EDIT_TOOLS.has(name)) {
				const p = pathOf(event?.args);
				if (p && !p.includes(".agents/skills") && !p.includes(".pi/")) {
					if (CODE_EXT.test(p)) {
						state.codeEdits++;
						if (state.codeEditPaths.length < 32 && !state.codeEditPaths.includes(p)) {
							state.codeEditPaths.push(p);
						}
						state.lastCodeEditAt = Date.now();
						state.verifySinceLastCodeEdit = false;
					} else {
						state.docEdits++;
					}
				}
			}

			if (name === "bash") {
				const cmd = typeof event?.args?.command === "string" ? event.args.command : "";
				if (cmd && (VERIFY_CMD.test(cmd) || GATE_CMD.test(cmd))) {
					state.verifyAttempts++;
					state.verifySinceLastCodeEdit = true;
					if (event?.toolCallId) state.verifyCalls.add(String(event.toolCallId));
				}
			}
		} catch {}
	});

	pi.on("tool_execution_end", async (event: any) => {
		try {
			const name = String(event?.toolName ?? "");
			const callId = event?.toolCallId ? String(event.toolCallId) : null;
			if (callId) {
				state.openCalls.delete(`${name}:${callId}`);
				if (state.verifyCalls.delete(callId)) {
					if (event?.isError) {
						state.verifyFailures++;
						state.lastVerifyOk = false;
					} else {
						state.lastVerifyOk = true;
					}
				}
			}
		} catch {}
	});

	pi.on("agent_settled", async (event: any, ctx: any) => {
		try {
			settle(ctx, Boolean(event?.aborted));
		} catch {}
		state = freshState();
	});

	pi.registerCommand("friction", {
		description: "显示最近记账的摩擦事实（未验证收尾 / 上游错误 / 尾部悬空）",
		handler: async (_args: string, ctx: any) => {
			const notify = (msg: string, level: string) => {
				try {
					ctx?.ui?.notify?.(msg, level);
				} catch {}
			};
			try {
				const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
				const file = ledgerPathFor(cwd);
				if (!fs.existsSync(file)) {
					notify(`尚无账本：${file}`, "info");
					return;
				}
				const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-500);
				let unverified = 0;
				let errors = 0;
				let dangling = 0;
				const sigs: Record<string, number> = {};
				for (const line of lines) {
					let r: any;
					try {
						r = JSON.parse(line);
					} catch {
						continue;
					}
					if (r.unverifiedCodeStop) unverified++;
					if (r.danglingToolCalls > 0) dangling++;
					if (r.errorSignature) {
						errors++;
						sigs[r.errorSignature] = (sigs[r.errorSignature] ?? 0) + 1;
					}
				}
				notify(
					[
						`最近 ${lines.length} 次收尾`,
						`未验证代码收尾 ${unverified} (${((unverified / Math.max(1, lines.length)) * 100).toFixed(1)}%)`,
						`带错误签名 ${errors} ${JSON.stringify(sigs)}`,
						`尾部悬空 ${dangling}`,
						`账本 ${file}`,
					].join("\n"),
					"info",
				);
			} catch (e) {
				notify(`friction 读取失败: ${String(e)}`, "error");
			}
		},
	});
}
