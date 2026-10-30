#!/usr/bin/env node
// friction-replay —— 把账本里记下的 leafEntryId 还原成"那一刻模型实际看到的上下文"。
//
// 为什么不用 --fork：pi 的 --fork 只从 active leaf 分叉，事后再跑时那个会话已经往后走了很多步，
// 分出来的是"现在"而不是"当时"。pi 的会话是 v3 tree（id/parentId），SessionManager.branch(id)
// 能把 leaf 精确移回历史 entry，buildContextEntries() 是 compaction-aware 的，所以拿到的就是
// 当时模型真正收到的上下文切片。整个过程只读：不写 session 文件，不产生新会话。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
	process.env.PI_CODING_AGENT_PACKAGE,
	path.join(os.homedir(), '.pi', 'agent', 'install', 'releases', '1.4.0', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
	path.join(os.homedir(), '.pi', 'agent', 'install', 'releases', '1.4.0', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
].filter(Boolean);

const DEFAULT_LEDGER = path.join(os.homedir(), '.pi', 'agent', 'friction-ledger.jsonl');
const MAX_CHARS_PER_BLOCK = 2000;
const MAX_TOOL_RESULT_CHARS = 1200;
const HEAD_ENTRIES = 6;

function loadSdk() {
	for (const c of CANDIDATES) {
		if (fs.existsSync(c)) return import(pathToFileURL(c).href);
	}
	throw new Error('找不到 pi-coding-agent SDK');
}

function parseArgs(argv) {
	const out = { ledger: DEFAULT_LEDGER, index: -1, out: null, leaf: null, session: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--ledger') out.ledger = argv[++i];
		else if (a === '--index') out.index = Number(argv[++i]);
		else if (a === '--out') out.out = argv[++i];
		else if (a === '--leaf') out.leaf = argv[++i];
		else if (a === '--session') out.session = argv[++i];
		else if (a === '--json') out.json = true;
	}
	return out;
}

function readLedger(file) {
	const rows = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {}
	}
	return rows;
}

function redact(text) {
	return String(text)
		.replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
		.replace(/(Bearer\s+[A-Za-z0-9._-]{8,})/gi, '[REDACTED]')
		.replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi, '$1[REDACTED]');
}

function clip(text, max) {
	const s = String(text);
	return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function renderBlocks(content, max) {
	if (typeof content === 'string') return [clip(redact(content), max)];
	const out = [];
	for (const p of Array.isArray(content) ? content : []) {
		if (!p || typeof p !== 'object') continue;
		if (p.type === 'text' && typeof p.text === 'string') out.push(clip(redact(p.text), max));
		else if (p.type === 'thinking' && typeof p.thinking === 'string')
			out.push(`[thinking] ${clip(redact(p.thinking), max)}`);
		else if (p.type === 'toolCall')
			out.push(`[tool_call ${p.name}] ${clip(redact(JSON.stringify(p.arguments ?? null)), max)}`);
		else if (p.type === 'image') out.push('[image]');
	}
	return out;
}

function summarizeToolResult(m) {
	const parts = renderBlocks(m.content, MAX_TOOL_RESULT_CHARS);
	return `[tool_result${m.isError ? ' ERROR' : ''}] ${parts.join('\n')}`;
}

function renderEntry(entry) {
	if (entry.type !== 'message') return `[[${entry.type}]]`;
	const m = entry.message;
	if (!m) return `[[${entry.type} no message]]`;
	if (m.role === 'toolResult') return summarizeToolResult(m);
	const head = `### ${m.role}${m.stopReason ? ` (stopReason=${m.stopReason})` : ''}`;
	const body = renderBlocks(m.content, MAX_CHARS_PER_BLOCK).join('\n');
	const err = m.errorMessage ? `\n**errorMessage:** ${clip(redact(m.errorMessage), 600)}` : '';
	return `${head}\n${body}${err}`;
}

const args = parseArgs(process.argv.slice(2));
const sdk = await loadSdk();
const { SessionManager } = sdk;

let record = null;
if (args.leaf) {
	record = { leafEntryId: args.leaf, sessionFile: args.session };
} else {
	const rows = readLedger(args.ledger);
	if (!rows.length) {
		console.error(`账本为空或不存在: ${args.ledger}`);
		process.exit(2);
	}
	const idx = args.index < 0 ? rows.length + args.index : args.index;
	record = rows[idx];
	if (!record) {
		console.error(`账本索引越界: ${idx} (共 ${rows.length} 条)`);
		process.exit(2);
	}
}

if (!record.sessionFile || !record.leafEntryId) {
	console.error('该记录缺少 sessionFile / leafEntryId，无法定位');
	process.exit(2);
}
if (!fs.existsSync(record.sessionFile)) {
	console.error(`session 文件不存在: ${record.sessionFile}`);
	process.exit(2);
}

const sm = SessionManager.open(record.sessionFile);
const activeLeaf = sm.getLeafId();
sm.branch(record.leafEntryId);
if (sm.getLeafId() !== record.leafEntryId) {
	console.error(`无法把 leaf 移到 ${record.leafEntryId}（实际 ${sm.getLeafId()}）`);
	process.exit(2);
}
const chain = sm.buildContextEntries();

let thinking = 0;
let toolCalls = 0;
const roles = {};
for (const e of chain) {
	if (e.type !== 'message') continue;
	const m = e.message;
	if (!m) continue;
	roles[m.role] = (roles[m.role] ?? 0) + 1;
	for (const p of Array.isArray(m.content) ? m.content : []) {
		if (p.type === 'thinking') thinking++;
		if (p.type === 'toolCall') toolCalls++;
	}
}

const facts = {
	sessionFile: record.sessionFile,
	activeLeafAtReplay: activeLeaf,
	replayedLeaf: record.leafEntryId,
	entries: chain.length,
	roles,
	thinking,
	toolCalls,
	record: {
		at: record.at,
		stopReason: record.stopReason,
		errorSignature: record.errorSignature,
		unverifiedCodeStop: record.unverifiedCodeStop,
		danglingToolCalls: record.danglingToolCalls,
		codeEdits: record.codeEdits,
		verifyAttempts: record.verifyAttempts,
		lastVerifyOk: record.lastVerifyOk,
		codeEditPaths: record.codeEditPaths,
		errorMessage: record.errorMessage,
	},
};

if (args.json) {
	console.log(JSON.stringify(facts, null, 2));
	process.exit(0);
}

const head = chain.slice(0, HEAD_ENTRIES);
const tail = chain.slice(-40);
const parts = [];
parts.push(`# 现场回放 ${record.at}`);
parts.push('');
parts.push('## 这一轮记账的事实');
parts.push('```json');
parts.push(JSON.stringify(facts.record, null, 2));
parts.push('```');
parts.push('');
parts.push('## 重建的上下文规模');
parts.push('```json');
parts.push(JSON.stringify({ entries: chain.length, roles, thinking, toolCalls }, null, 2));
parts.push('```');
parts.push('');
parts.push(`> 这是 compaction-aware 的祖先链：模型在 ${record.leafEntryId} 这一刻真正收到的历史。`);
parts.push(`> 用 SessionManager.branch() 精确回放，不是 --fork（--fork 只从 active leaf 分叉）。`);
parts.push('');
parts.push('## 会话开头（取向）');
parts.push(...head.map(renderEntry));
parts.push('');
parts.push('## 收尾前最后 40 条（现场）');
parts.push(...tail.map(renderEntry));

const text = parts.join('\n\n');
const outPath =
	args.out ??
	path.join(path.dirname(args.ledger), 'friction-replay', `${String(record.at ?? '').replace(/[:.]/g, '-')}_${record.leafEntryId}.md`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, text, 'utf8');

console.log(JSON.stringify({ ...facts, replayFile: outPath, chars: text.length }, null, 2));
