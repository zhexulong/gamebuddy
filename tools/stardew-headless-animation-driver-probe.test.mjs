import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const markdownUrl = new URL("./stardew-headless-animation-driver-probe.md", import.meta.url);
const scriptUrl = new URL("./stardew-headless-animation-driver-probe.ps1", import.meta.url);

const requiredActions = ["till_soil", "water_crop", "chop_tree_source"];

test("animation probe charter fixes the target version, topology, actions, and observation points", async () => {
  const charter = await readFile(markdownUrl, "utf8");

  assert.match(charter, /Stardew Valley\s*\|\s*`1\.6\.15\.24356`/);
  assert.match(charter, /SMAPI\s*\|\s*`4\.5\.2`/);
  assert.match(charter, /native_ai_farmhand_multiplayer/);
  assert.match(charter, /Host 驱动/);
  assert.match(charter, /物理输入\s*\|\s*无键盘、无手柄/);

  for (const action of requiredActions) assert.match(charter, new RegExp(`\\b${action}\\b`));
  assert.match(charter, /UsingTool/);
  assert.match(charter, /动画帧/);
  assert.match(charter, /Apex/);
  assert.match(charter, /deadlock_or_timeout/);
  assert.match(charter, /watchdog/i);
  assert.match(charter, /证据表/);
  assert.match(charter, /状态：\*\*charter-only \/ live evidence 未运行\*\*/);
  assert.match(charter, /## 最小复现路径/);
});

test("charter records both seam choices and keeps the current recommendation conservative", async () => {
  const charter = await readFile(markdownUrl, "utf8");

  assert.match(charter, /保持 `Tool\.DoFunction` 单次结算/);
  assert.match(charter, /切换为 `BeginUsingTool\(\)`/);
  assert.match(charter, /当前 seam 建议：先保持/);
  assert.match(charter, /客机专属状态机卡死/);
  assert.match(charter, /不盲重试/);
  assert.match(charter, /不假称完成\/取消/);
});

test("PowerShell wrapper is an evidence-only delegated probe with plan-only default", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /\[CmdletBinding\(\)\]/);
  for (const parameter of ["GamePath", "ProfilePath", "SaveSlot", "BridgePath", "EvidencePath", "RunLive"]) {
    assert.match(script, new RegExp(`\\$${parameter}\\b`));
  }
  for (const action of requiredActions) assert.match(script, new RegExp(`['\"]${action}['\"]`));
  assert.match(script, /authority = 'evidence_only'/);
  assert.match(script, /existing authenticated bridge\/test harness only/);
  assert.match(script, /direct C# handler invocation/);
  assert.match(script, /UsingTool/);
  assert.match(script, /Apex/);
  assert.match(script, /deadlock_or_timeout/);
  assert.match(script, /if \(-not \$RunLive\)/);
  assert.match(script, /stardew-headless-animation-driver-evidence\/v1/);
  assert.match(script, /Start-Process/);
});
