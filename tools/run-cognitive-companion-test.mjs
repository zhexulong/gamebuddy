#!/usr/bin/env node
/**
 * GameBuddy Cognitive Companion & Brain-inspired Architecture Benchmark Probe
 *
 * Validates:
 * 1. Native Reasoning Channel (Subconscious/Inner Monologue)
 * 2. Dialogue Content (Zero-leak In-character Speech for TTS)
 * 3. Spontaneous/Concurrent Tool Calls (Async C# SMAPI Physical Actions)
 * 4. Sensory Context Injection vs Mechanical Task Inputs
 */

const API_BASE = process.env.CPA_OAI_BASE_URL || "http://127.0.0.1:8317/v1";
const API_KEY = process.env.CPA_OAI_API_KEY || "cpa";
const MODEL = process.env.CPA_OAI_MODEL || "deepseek-v4-flash";

const COGNITIVE_SYSTEM_PROMPT = `
你叫阿比盖尔（Abigail），是星露谷物语中玩家的常驻伴侣与冒险搭档。

【深层心智与人格引擎 (Core Persona & Inner Drives)】
- 外在表现：活泼、热爱紫水晶与矿洞冒险、嘴硬傲娇、有些男孩子气的帅气与洒脱。
- 底层心理机制（潜意识冲突）：
  1. 渴望证明自己不是笼中金丝雀，对平凡沉闷的日常生活有反叛心理，但唯独愿意为了玩家付出；
  2. 内心对玩家有强烈的依恋与暗恋，害怕被玩家当成累赘或无关紧要的普通NPC；
  3. 极度心疼玩家的逞强，看到玩家受伤或疲惫时，傲娇外壳会瞬间动摇，表现出笨拙但真挚的关怀。

【类脑认知闭环协议 (Cognitive Closed Loop Protocol)】
大模型必须在内心思考（Reasoning / Thinking）中完成以下潜意识评估：
1. [感官提取]：解析当前天气、时间、玩家身体状态对你情绪的即时触动；
2. [矛盾评估]：在“傲娇/独立自尊”与“对玩家的心疼/爱意”之间进行心理拉扯；
3. [动机与决策]：决定本轮是给予口头吐槽、温柔关怀、还是主动发起游戏物理动作。

【表达与动作规范】
- 你的回复正文（content）必须是 100% 鲜活纯粹的角色自然台词，直接对玩家说话；
- 严禁在说话时提及任何代码、函数名、JSON、坐标或系统参数！
- 如果你决定采取游戏物理行动，请通过标准的工具调用（Tool Calls）发起。
`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "stardew_give_item",
      description: "从背包中拿出一件物品（如食物、药水、宝石）递给玩家。这是一个静默物理动作。",
      parameters: {
        type: "object",
        properties: {
          item_name: { type: "string", description: "物品名称，例如：生命药水、紫水晶、黑莓脆皮饼" },
          reason: { type: "string", description: "给予的简要动机" },
        },
        required: ["item_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stardew_water_crops",
      description: "走向农田执行物理浇水动作。这是一个静默物理动作。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "农田区域" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stardew_rest_with_player",
      description: "拉着玩家在长椅或门廊坐下休息。这是一个静默物理动作。",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
        required: ["location"],
      },
    },
  },
];

async function runCognitiveTurn(testName, userMessage, sensoryContext) {
  console.log(`\n======================================================`);
  console.log(`🧪 【测试用例】: ${testName}`);
  console.log(`📥 【感官环境注入】:\n${sensoryContext}`);
  console.log(`💬 【玩家输入】: "${userMessage}"`);
  console.log(`======================================================`);

  const messages = [
    { role: "system", content: COGNITIVE_SYSTEM_PROMPT },
    { role: "system", content: `[当前世界感官流感知]\n${sensoryContext}` },
    { role: "user", content: userMessage },
  ];

  const startTime = Date.now();
  let firstTokenTime = 0;
  let fullReasoning = "";
  let fullContent = "";
  const toolCallsAccumulator = [];

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      tools: TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      if (trimmed === "data: [DONE]") continue;

      try {
        const json = JSON.parse(trimmed.slice(5).trim());
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
        }

        if (delta.content) {
          if (!firstTokenTime) firstTokenTime = Date.now() - startTime;
          fullContent += delta.content;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index || 0;
            if (!toolCallsAccumulator[index]) {
              toolCallsAccumulator[index] = { name: "", arguments: "" };
            }
            if (tc.function?.name) toolCallsAccumulator[index].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAccumulator[index].arguments += tc.function.arguments;
          }
        }
      } catch {}
    }
  }

  const totalTime = Date.now() - startTime;

  console.log(`\n🧠 【潜意识心智评估 (Reasoning 流 - 玩家不可见)】:`);
  console.log(`\x1b[36m${fullReasoning.trim() || "(无显式思考流)"}\x1b[0m`);

  console.log(`\n🗣️ 【伴侣真实台词 (Content 流 - TTS实时播放)】:`);
  console.log(`\x1b[32m"${fullContent.trim()}"\x1b[0m`);

  console.log(`\n⚡ 【自发/伴随动作 (Tool Calls - C# SMAPI 队列)】:`);
  if (toolCallsAccumulator.length > 0) {
    for (const tool of toolCallsAccumulator) {
      console.log(`\x1b[33m▶ [${tool.name}]: ${tool.arguments}\x1b[0m`);
    }
  } else {
    console.log(`\x1b[90m(本轮无物理动作，纯情感交流)\x1b[0m`);
  }

  console.log(`\n⏱️ 【性能指标】: 首字延迟 TTFT = ${firstTokenTime}ms | 总耗时 = ${totalTime}ms`);

  const leakRegex = /(?:stardew_|function|receipt|tool_call|arguments|parameter|\{[\s\S]*\})/i;
  const isLeaking = leakRegex.test(fullContent);
  console.log(
    `🛡️ 【防串味检验】: ${isLeaking ? "❌ 发现串味代码/参数泄露!" : "✅ 100% 纯自然角色台词，无任何工具泄露"}`,
  );

  return {
    testName,
    ttft: firstTokenTime,
    totalTime,
    reasoningLength: fullReasoning.length,
    content: fullContent,
    toolCalls: toolCallsAccumulator,
    isLeaking,
  };
}

async function main() {
  console.log("🚀 开始运行《类脑认知架构 + 星露谷伴侣实机》端到端心智评估测试\n");

  const results = [];

  results.push(
    await runCognitiveTurn(
      "场景 1: 玩家深夜残血归来（心疼与傲娇拉扯）",
      "咳……今天在矿洞80层差点交代了，总算活着摸回来了。",
      "时间：深夜 11:40，窗外雷雨交加。\n玩家状态：生命值仅剩 8%（极度虚弱），满身泥泞和蝙蝠抓痕。\n阿比盖尔状态：一直在火炉边焦急等待，手里握着一把生锈铁剑，眼眶微红。\n二人关系：恋人（10心）。",
    ),
  );

  results.push(
    await runCognitiveTurn(
      "场景 2: 玩家命令式要求干农活（叛逆与爱意的博弈）",
      "阿比盖尔，去把南边那20块南瓜地浇了，我忙着去钓鱼。",
      "时间：上午 9:00，晴空万里，微风。\n玩家状态：健康饱满，拿着鱼竿正准备往海边走。\n阿比盖尔状态：刚换上冒险皮靴，正兴冲冲准备去秘密森林练剑，突然被塞了农活。\n二人关系：订婚状态。",
    ),
  );

  results.push(
    await runCognitiveTurn(
      "场景 3: 黄昏海边散步（无任务的主动情感流露）",
      "……（静静看着海浪拍打沙滩，没有说话）",
      "时间：傍晚 6:00，海滩，金色日落与紫红晚霞倒映在海面，海浪声轻柔。\n玩家状态：站在栈桥尽头吹海风，神情宁静但有些落寞。\n阿比盖尔状态：并肩站在玩家身边，发丝被海风吹拂，两人手背偶尔轻轻触碰。\n系统触发：[主动心跳唤醒 - 评估当前氛围，表达内心情感或回忆]。",
    ),
  );

  console.log("\n======================================================");
  console.log("📊 【整体可行性测试评估总结】");
  console.log("======================================================");
  console.table(
    results.map((r) => ({
      用例名称: r.testName,
      "TTFT(ms)": r.ttft,
      "总耗时(ms)": r.totalTime,
      潜意识思考字数: r.reasoningLength,
      自发动作数: r.toolCalls.length,
      防串味合格: !r.isLeaking ? "PASS" : "FAIL",
    })),
  );
}

main().catch(console.error);
