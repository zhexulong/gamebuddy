// 摩擦传感器的假命题测试：用假 pi / 假 ctx 驱动真实的扩展模块。
//
// 为什么用假事件而不是跑真 pi：这三类事实（未验证收尾、上游错误签名、尾部悬空）是
// 纯状态判定，能且必须在毫秒级被证伪。真 pi 那一侧另有端到端验证（`friction-replay.mjs`
// 对一个真实账本条目回放），两者不是同一个断言，也不互相替代。
//
// 每条断言都必须在真实注入的违规上先红——本文件里的每一个 FAIL 都是这样被见过的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXT = pathToFileURL(new URL('./friction-ledger-extension.ts', import.meta.url).pathname.replace(/^\//, '')).href;

async function loadExtension() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
	};
	const mod = await import(EXT);
	mod.default(pi);
	return { handlers, commands, fire };
}

async function fire(handlers, event, ev, ctx) {
	for (const handler of handlers.get(event) ?? []) await handler(ev, ctx);
}

function ctxFor(cwd, leafId, sessionFile) {
	return {
		cwd,
		model: { provider: 'test', id: 'test-model' },
		sessionManager: {
			getLeafId: () => leafId,
			getSessionFile: () => sessionFile,
			getSessionId: () => 'test-session',
		},
		ui: { notify: () => {} },
	};
}

function tmpCwd() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-'));
	fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
	return dir;
}

function lastRecord(cwd) {
	const file = path.join(cwd, '.pi', 'friction-ledger.jsonl');
	const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
	return JSON.parse(lines[lines.length - 1]);
}

const checks = [];
function check(name, ok) {
	checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

const { handlers, commands } = await loadExtension();

// --- A：改了代码，之后再没跑过任何验证就收尾
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-a', 'a.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'edit', toolCallId: 'e1', args: { path: 'host/src/a.ts' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'edit', toolCallId: 'e1', isError: false }, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'bash', toolCallId: 'b1', args: { command: 'git status' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'bash', toolCallId: 'b1', isError: false }, ctx);
	await fire(handlers, 'message_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('A 改代码后未验证收尾被记为 unverifiedCodeStop', record.unverifiedCodeStop === true);
	check('A 记录了 leafEntryId 作为回放游标', record.leafEntryId === 'leaf-a');
	check('A 不把 git status 当成验证', record.verifyAttempts === 0);
}

// --- B：改了代码，跑了 tsc 且绿，收尾时不应标成未验证
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-b', 'b.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'edit', toolCallId: 'e1', args: { path: 'host/src/b.ts' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'edit', toolCallId: 'e1', isError: false }, ctx);
	await fire(
		handlers,
		'tool_execution_start',
		{ toolName: 'bash', toolCallId: 'b1', args: { command: 'node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit' } },
		ctx,
	);
	await fire(handlers, 'tool_execution_end', { toolName: 'bash', toolCallId: 'b1', isError: false }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('B tsc 路径里的 tsc.js 被认成验证', record.verifyAttempts === 1);
	check('B 已验证则不算未验证收尾', record.unverifiedCodeStop === false);
	check('B 记录了验证成功', record.lastVerifyOk === true);
}

// --- B2：验证命令跑了但红了，仍然算"跑过验证"（事实是红的，不是没跑）
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-b2', 'b2.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'write', toolCallId: 'e1', args: { path: 'x.ts' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'write', toolCallId: 'e1', isError: false }, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'bash', toolCallId: 'b1', args: { command: 'node --test foo.test.mjs' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'bash', toolCallId: 'b1', isError: true }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('B2 红了的验证仍记 verifyAttempts', record.verifyAttempts === 1);
	check('B2 红了的验证记 lastVerifyOk=false', record.lastVerifyOk === false);
	check('B2 红了的验证记 verifyFailures', record.verifyFailures === 1);
}

// --- C：上游 502 + 尾部悬空
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-c', 'c.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'bash', toolCallId: 'x1', args: { command: 'sleep 99' } }, ctx);
	await fire(
		handlers,
		'message_end',
		{ message: { role: 'assistant', stopReason: 'error', errorMessage: '502: upstream request failed / server_error' } },
		ctx,
	);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('C 502 被归类为 upstream_502', record.errorSignature === 'upstream_502');
	check('C 未回收的工具调用记为悬空', record.danglingToolCalls === 1);
	check('C 记录了 stopReason=error', record.stopReason === 'error');
}

// --- C2：429 与 auth 必须与 502 分开
for (const [message, expected] of [
	['429 Too Many Requests', 'rate_limit_429'],
	['401 unauthorized: invalid api key', 'auth_or_quota'],
	['request timed out after 60s', 'timeout'],
]) {
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, `leaf-${expected}`, 'x.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'message_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: message } }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	check(`C2 "${message.slice(0, 30)}" 归为 ${expected}`, lastRecord(cwd).errorSignature === expected);
}

// --- C3：已收回的工具调用不能算悬空（否则“悬空”只是“调用总数”的别名）
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-c3', 'c3.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'bash', toolCallId: 'done1', args: { command: 'ls' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'bash', toolCallId: 'done1', isError: false }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('C3 已收回的调用不算悬空', record.danglingToolCalls === 0);
	check('C3 已收回的调用仍计入 toolCalls', record.toolCalls === 1);
}

// --- D：错误正文里的凭据必须脱敏
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-d', 'd.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(
		handlers,
		'message_end',
		{ message: { role: 'assistant', stopReason: 'error', errorMessage: 'bad key sk-abcdef1234567890 and api_key=supersecret123' } },
		ctx,
	);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('D sk- 开头的凭据被脱敏', !record.errorMessage.includes('sk-abcdef1234567890'));
	check('D api_key= 的值被脱敏', !record.errorMessage.includes('supersecret123'));
}

// --- E：只改文档不算未验证代码收尾
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-e', 'e.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'edit', toolCallId: 'e1', args: { path: 'design/foo.md' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'edit', toolCallId: 'e1', isError: false }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	const record = lastRecord(cwd);
	check('E 文档改动计为 docEdits', record.docEdits === 1);
	check('E 文档改动不算未验证代码收尾', record.unverifiedCodeStop === false);
}

// --- F：/friction 命令能读出统计
{
	const cwd = tmpCwd();
	const ctx = ctxFor(cwd, 'leaf-f', 'f.jsonl');
	await fire(handlers, 'before_agent_start', {}, ctx);
	await fire(handlers, 'tool_execution_start', { toolName: 'edit', toolCallId: 'e1', args: { path: 'a.ts' } }, ctx);
	await fire(handlers, 'tool_execution_end', { toolName: 'edit', toolCallId: 'e1', isError: false }, ctx);
	await fire(handlers, 'agent_settled', { aborted: false }, ctx);
	let noticed = null;
	const cmdCtx = { ...ctx, ui: { notify: (m) => (noticed = m) } };
	await commands.get('friction').handler('', cmdCtx);
	check('/friction 输出包含未验证收尾计数', typeof noticed === 'string' && noticed.includes('未验证代码收尾'));
}

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL'));
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
