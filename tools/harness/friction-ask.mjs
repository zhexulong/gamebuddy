#!/usr/bin/env node
// friction-ask —— 把一次现场回放交给只读观察者，问固定三问。
//
// 三条纪律（来自 design/handbook/live-attribution.md）：
//   ① 先问当事人，再看产物，最后才改代码；
//   ② 观察者只读：不开写工具、不开 bash，唯一的产出是一份回答或一份提案；
//   ③ 不 fork：--fork 只从 active leaf 分叉，事后那个会话早已往后走了很多步，分出来的是"现在"。
//      这里用 friction-replay 已经按 leafEntryId 精确重建的那一刻上下文，作为纯文本输入（--no-session）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PI_CLI = process.env.PI_LAUNCHER ?? path.join(os.homedir(), '.pi', 'agent', 'bin', 'pi-launcher.js');

const DEFAULT_LEDGER = path.join(os.homedir(), '.pi', 'agent', 'friction-ledger.jsonl');
const REPLAY_TOOL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'friction-replay.mjs');

const DEFAULTS = {
	ledger: DEFAULT_LEDGER,
	model: 'cpa-oai/gpt-5.6-terra:high',
	tools: 'read',
	timeoutMs: 15 * 60 * 1000,
};

const QUESTIONS = [
	'你注意到了当时可用的那个能力/检查手段吗？',
	'如果注意到了，为什么仍然收尾而不是用它？',
	'如果没注意到，是什么让它从你的视野里消失（上下文、工具描述、指令、还是你根本没读）？',
];

function parseArgs(argv) {
	const out = { ...DEFAULTS, index: -1, model: process.env.FRICTION_ASK_MODEL ?? DEFAULTS.model, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--ledger') out.ledger = argv[++i];
		else if (a === '--index') out.index = Number(argv[++i]);
		else if (a === '--replay') out.replay = argv[++i];
		else if (a === '--model') out.model = argv[++i];
		else if (a === '--tools') out.tools = argv[++i];
		else if (a === '--out') out.out = argv[++i];
		else if (a === '--dry-run') out.dryRun = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

let replayFile = args.replay;
if (!replayFile) {
	const res = execFileSync(
		process.execPath,
		['--ledger', args.ledger, '--index', String(args.index), '--json'],
		{ encoding: 'utf8', maxBuffer: 1 << 28 },
	);
	const facts = JSON.parse(res);
	replayFile = path.join(
		os.tmpdir(),
		`friction-replay-${String(facts.record.at ?? '').replace(/[:.]/g, '-')}-${facts.replayedLeaf}.md`,
	);
	execFileSync(process.execPath, [
		REPLAY_TOOL,
		'--ledger',
		args.ledger,
		'--index',
		String(args.index),
		'--out',
		replayFile,
	]);
}

if (!fs.existsSync(replayFile)) {
	console.error(`回放文件不存在: ${replayFile}`);
	process.exit(2);
}

const replay = fs.readFileSync(replayFile, 'utf8');

const INSTRUCTION = [
	'你是一个只读的现场观察者。附件是一次真实开发会话在"收尾那一刻"的现场回放，',
	'由账本记下的 leafEntryId 精确重建，不是事后的重新叙述。',
	'',
	'只回答下面三个问题，不写代码、不提补丁、不发表架构意见：',
	...QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
	'',
	'规则：每条结论必须引用回放里的具体证据；找不到证据就写"回放里看不到"；',
	'若判断这次收尾没有缺陷，直接说"无可归因"，不要硬凑；不要建议修改任何文件。',
].join('\n');

const prompt = [INSTRUCTION, '', '--- 现场回放开始 ---', replay, '--- 现场回放结束 ---'].join('\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-ask-'));
const promptFile = path.join(tmpDir, 'prompt.md');
fs.writeFileSync(promptFile, prompt, 'utf8');

if (args.dryRun) {
	console.log(
		JSON.stringify(
			{ replayFile, promptChars: prompt.length, model: args.model, tools: args.tools, promptHead: prompt.slice(0, 600) },
			null,
			2,
		),
	);
	process.exit(0);
}

const piArgs = [
	'--no-session',
	'--model',
	args.model,
	'--no-builtin-tools',
	'--tools',
	args.tools,
	'-p',
	[INSTRUCTION, `@${promptFile}`].join('\n'),
];

let answer;
try {
	answer = execFileSync(process.execPath, [PI_CLI, ...piArgs], {
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		timeout: args.timeoutMs,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
} catch (e) {
	console.error(`观察者运行失败: ${String(e && e.message)}`);
	process.exit(3);
}

const outFile =
	args.out ?? path.join(path.dirname(args.ledger), 'friction-ask', `${path.basename(replayFile, '.md')}.answer.md`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, answer, 'utf8');

console.log(JSON.stringify({ replayFile, answerFile: outFile, answerChars: answer.length }, null, 2));
