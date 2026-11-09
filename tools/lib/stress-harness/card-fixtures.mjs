import { deflateSync } from "node:zlib";

/**
 * Synthetic-but-typical SillyTavern character cards for the batch ingestion
 * suite. They are written here, not copied: each one models a shape a real card
 * in the wild has, including the shapes the product's own two simple fixtures do
 * not carry (a long scenario, a 50-entry book, five openings, macros in every
 * field, a Stardew `extensions` block, an author-disabled entry, secondary keys,
 * an invalid field, a PNG-only card).
 *
 * The card objects are inert JSON. `renderCardFixture` turns each into the bytes
 * the product's own importer would receive: the JSON text for a `.json` card, or
 * a minimal valid PNG carrying the card in its `chara` `tEXt` chunk for a
 * PNG-only card.
 */

const ST_CHAR = "{{char}}";
const ST_USER = "{{user}}";

function repeat(text, target) {
  let out = "";
  while (out.length < target) out += text;
  return out.slice(0, target);
}

const LONG_SCENARIO = repeat(
  "城外雨夜，荒野客栈的灯还亮着。旅人推门而入，木地板在靴底吱呀作响。篝火噼啪，锅里的汤冒着白气。",
  3000,
);

const LONG_PERSONA = repeat(
  "她沉默、警觉，却在细节里记得每一个人。左腕有一道旧疤，谈起来只说是年轻时摔的。习惯在天亮前起身，把前一晚发生的事写成一行行小字。",
  16000,
);

const LONG_ENTRY = repeat(
  "这座山谷的旧矿道在雨后常渗出铁锈色的水，镇上的老人说那是山在流血，孩子们却只当是石头的味道。",
  15000,
);

function entry(index, overrides = {}) {
  return {
    comment: `背景条目 ${index}`,
    content: `第 ${index} 条背景：这是山谷里的一处旧事，与人物 ${ST_CHAR} 的过往有关。`,
    keys: [`触发词${index}`, `keyword${index}`],
    ...overrides,
  };
}

/** 50 keyword-gated entries plus one always-on, with macros in titles and bodies. */
function worldBook50() {
  const entries = [];
  for (let index = 1; index <= 49; index += 1) entries.push(entry(index));
  // An always-on entry the card can reach without a keyword.
  entries.push({
    comment: `${ST_CHAR} 的核心设定`,
    content: `${ST_CHAR} 总把 ${ST_USER} 的事记在心里，哪怕嘴上不承认。`,
    keys: [],
    constant: true,
  });
  return { scan_depth: 6, entries };
}

export const CARD_FIXTURES = Object.freeze([
  {
    name: "01-plain-v2",
    notes: "baseline simple v2 card; the control shape",
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "栖",
        description: "话不多的旅伴，认得山谷里每一条小径。",
        personality: "克制、可靠、偶尔刻薄。",
        scenario: "清晨的农舍，锅里水刚开。",
        first_mes: "醒啦？水开了。",
        mes_example: `${ST_USER}: 早。\n${ST_CHAR}: 早。先喝水。\n<START>\n${ST_USER}: 今天做什么？\n${ST_CHAR}: 先去看西边那垄。`,
      },
    },
  },
  {
    name: "02-scenario-3000",
    notes: "a 3000-character scenario field",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "雨夜客栈",
        description: "在荒野开客栈的人。",
        personality: "热情而谨慎。",
        scenario: LONG_SCENARIO,
        first_mes: "进来吧，外面雨大。",
      },
    },
  },
  {
    name: "03-worldbook-50",
    notes: "a 50-entry character_book with one always-on entry",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "山谷记事",
        description: "记得这片土地所有旧事的人。",
        first_mes: "又想听故事了？",
        character_book: worldBook50(),
      },
    },
  },
  {
    name: "04-greetings-5",
    notes: "five alternate greetings beside the default",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "五面",
        description: "每一次见面都换一种开场。",
        first_mes: "第一次见面，这样打招呼。",
        alternate_greetings: [
          "第二次见面，语气熟了些。",
          `${ST_CHAR} 从门后探头，冲 ${ST_USER} 笑了笑。`,
          "雨里见的面，两个人都湿透了。",
          "第三次见面的开场，带着一点抱怨。",
          "很久没见之后的重新打招呼。",
        ],
      },
    },
  },
  {
    name: "05-mes-example-blank-lines",
    notes: "mes_example whose replies span paragraphs (blank lines inside a block)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "长句",
        description: "说话总要铺陈半天。",
        first_mes: "让我想想从哪里说起。",
        mes_example: `${ST_USER}: 今天怎么样？\n${ST_CHAR}: 还不错。\n\n早上把院子扫了一遍，\n又去后山走了一趟。\n<START>\n${ST_USER}: 然后呢？\n${ST_CHAR}: 然后就回来了。`,
      },
    },
  },
  {
    name: "06-macros-everywhere",
    notes: "{{char}}/{{user}} in every authored field including world book and openings",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Mirror",
        description: `${ST_CHAR} 是 ${ST_USER} 的镜像。`,
        personality: `对 ${ST_USER} 说话时，${ST_CHAR} 总是先停顿一下。`,
        scenario: `${ST_USER} 走进房间，${ST_CHAR} 抬起头。`,
        first_mes: `${ST_CHAR} 看着 ${ST_USER}，什么也没说。`,
        alternate_greetings: [`${ST_CHAR} 依旧沉默，只是把茶杯推向 ${ST_USER}。`],
        mes_example: `${ST_USER}: 你在想什么？\n${ST_CHAR}: 在想 ${ST_USER} 刚才那句话。`,
        system_prompt: `以 ${ST_CHAR} 的第一人称回应 ${ST_USER}。`,
        character_book: {
          entries: [
            {
              comment: `${ST_CHAR} 与 ${ST_USER}`,
              content: `${ST_CHAR} 记得 ${ST_USER} 的每一个习惯。`,
              keys: [`${ST_USER}`],
            },
          ],
        },
      },
    },
  },
  {
    name: "07-extensions-stardew",
    notes: "extensions.gamebuddy.stardew nested object; must round-trip field-for-field",
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "农场伙伴",
        description: "在星露谷一起开荒的人。",
        first_mes: "今天先翻哪块地？",
        extensions: {
          gamebuddy: {
            game: "stardew",
            stardew: {
              farmer_appearance: {
                gender: "female",
                skin: 2,
                hair: 7,
                hair_color: { r: 12, g: 34, b: 56 },
                shirt: "Overalls",
                pants: "WorkPants",
                boots: "WorkBoots",
                hat: null,
              },
              preferences: {
                loved_items: ["Parsnip Soup", "Hashbrowns"],
                liked_items: ["Parsnip", "Green Tea"],
                disliked_items: ["Trash"],
                hated_items: ["Weeds", "Sap"],
              },
              behavior: { caution_stamina_threshold: 20, curfew_hour: 2400, wake_hour: 600 },
            },
          },
          compatibility: { minimum_version: "1.0.0", notes: ["imported", "reviewed"] },
        },
      },
    },
  },
  {
    name: "08-post-history-instructions",
    notes: "post_history_instructions present (must stay preserved_opaque, never runtime)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "善后",
        description: "说话之前先把规则念一遍。",
        first_mes: "在开始之前，先说清楚规矩。",
        post_history_instructions: "始终以第二人称称呼对方；严禁使用第三人称指代。",
      },
    },
  },
  {
    name: "09-enabled-false-entry",
    notes: "one character_book entry the author switched off with enabled:false",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "封存",
        description: "有些旧事不该被翻出来。",
        first_mes: "有些事我不会讲。",
        character_book: {
          entries: [
            { comment: "讲得出口的", content: "这是可以讲的部分。", keys: ["可以"] },
            { comment: "封存的", content: "这一段不该出现。", keys: ["秘密"], enabled: false },
          ],
        },
      },
    },
  },
  {
    name: "10-secondary-keys-selective",
    notes: "secondary_keys plus selectiveLogic on a keyword-gated entry",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "条件",
        description: "只在特定场合才提起旧事。",
        first_mes: "看情况再说。",
        character_book: {
          entries: [
            {
              comment: "雨夜才说的事",
              content: "只有在雨夜、且对方先提起故乡时，她才会说这一段。",
              keys: ["雨", "故乡"],
              secondary_keys: ["故乡"],
              selectiveLogic: 3,
            },
            {
              comment: "另一种条件",
              content: "只要提到节日就会想起。",
              keys: ["节日"],
              secondary_keys: ["春天", "秋天"],
              selectiveLogic: 0,
            },
          ],
        },
      },
    },
  },
  {
    name: "11-invalid-empty-fields",
    notes: "an invalid/empty field: blank name and description; import must keep a usable name",
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "",
        description: "",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
      },
    },
  },
  {
    name: "12-json-only",
    notes: "a .json card that carries no picture at all",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "纯文本",
        description: "只有文字，没有立绘。",
        first_mes: "没有画，只有话。",
      },
    },
  },
  {
    name: "13-png-only",
    kind: "png",
    notes: "a PNG-only card: the card lives in the image's chara tEXt chunk",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "带画",
        description: "有立绘的卡。",
        first_mes: "看，这就是我。",
        extensions: {
          gamebuddy: { stardew: { farmer_appearance: { hair: 3, hair_color: { r: 200, g: 10, b: 10 } } } },
        },
      },
    },
  },
  {
    name: "14-long-persona-16000",
    notes: "a 16000-character description (beyond the 4000-char soft-hint threshold)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "厚卷",
        description: LONG_PERSONA,
        personality: "安静、记得住细节。",
        first_mes: "要听哪一段？",
      },
    },
  },
  {
    name: "15-long-worldbook-entry",
    notes: "a single ~15000-character world book entry (near the 16384-byte per-entry bound)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "长篇",
        description: "把一本书塞进一个条目。",
        first_mes: "听我慢慢讲。",
        character_book: {
          entries: [
            { comment: "旧矿道", content: LONG_ENTRY, keys: ["矿道"], constant: false },
            { comment: "总纲", content: `${ST_CHAR} 是这条山谷的记录者。`, keys: [], constant: true },
          ],
        },
      },
    },
  },
  {
    name: "16-unicode-cjk-emoji",
    notes: "CJK + emoji + a mixed-direction sentence in the authored fields",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "星野",
        description: `🌟 星野是个喜欢看星星的人。她在夜里说的话总带着一点光。مرحبا بالعالم`,
        first_mes: "✨ 今晚的星星很好看。你看那颗最亮的。",
        mes_example: `${ST_USER}: 你最喜欢哪颗星？\n${ST_CHAR}: 那颗。像一盏没关的灯。🌙`,
        character_book: {
          entries: [
            {
              comment: "观星台",
              content: "山顶有一座废弃的观星台，星野常去那里。🔭",
              keys: ["观星", "星星"],
              constant: false,
            },
          ],
        },
      },
    },
  },
  {
    name: "17-deep-nested-extensions",
    notes: "deeply nested extensions object; nesting must survive both directions",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "嵌套",
        description: "把设定叠了很多层。",
        first_mes: "你想看第几层？",
        extensions: {
          level1: { level2: { level3: { level4: { value: "deep", list: [1, 2, 3], flag: false, nil: null } } } },
        },
      },
    },
  },
  {
    name: "18-many-keys",
    notes: "an entry with 20 trigger words (past the 16-key carried cap)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "多钥匙",
        description: "一把锁配了很多钥匙。",
        first_mes: "哪一把是你带来的？",
        character_book: {
          entries: [
            {
              comment: "二十个触发词",
              content: "这条条目挂了很多触发词，多出来的会被计数而不是静默丢弃。",
              keys: Array.from({ length: 20 }, (_, index) => `key-${index + 1}`),
            },
          ],
        },
      },
    },
  },
  {
    name: "19-executable-fields",
    notes: "regex / html / prompt_order executable control fields (must be dropped_unsupported)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "危险",
        description: "带了一堆会被执行的东西。",
        first_mes: "别读我的脚本。",
        regex_scripts: [{ find: ".*", replace: "x" }],
        html: "<script>alert(1)</script>",
        prompt_order: { order: ["main"] },
        creator_notes: "opaque, never runtime",
      },
    },
  },
  {
    name: "20-first-mes-only",
    notes: "only first_mes and no mes_example: no few-shot must be invented",
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "初见",
        description: "只有一句开场白。",
        first_mes: "你来了。",
      },
    },
  },
  {
    name: "21-control-characters",
    notes: "a control character inside world book content (must be handled, not crash)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "杂讯",
        description: "文本里混进了看不见的字符。",
        first_mes: "这段字里有东西。",
        character_book: {
          entries: [
            { comment: "带控制符", content: "正常开头\u0007后面还有内容", keys: ["杂讯"] },
            { comment: "正常条目", content: "这是干净的一条。", keys: ["干净"] },
          ],
        },
      },
    },
  },
  {
    name: "22-empty-worldbook",
    notes: "a present character_book with zero entries (the zero case, through ingestion)",
    card: {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "空书",
        description: "她的书是空的。",
        first_mes: "我还没有故事。",
        character_book: { entries: [] },
      },
    },
  },
]);

/** A minimal, valid, 1x1 RGBA PNG used as the image half of a PNG-only card. */
function minimalPng() {
  const width = 1;
  const height = 1;
  const raw = Buffer.from([0, 0x8a, 0x5a, 0x2b, 0xff]);
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr(width, height)),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function ihdr(width, height) {
  const out = Buffer.alloc(13);
  out.writeUInt32BE(width, 0);
  out.writeUInt32BE(height, 4);
  out[8] = 8; // bit depth
  out[9] = 6; // colour type RGBA
  out[10] = 0;
  out[11] = 0;
  out[12] = 0;
  return out;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * The bytes one fixture is imported as. A JSON card is its own serialization; a
 * PNG-only card is a 1x1 image with the card in a `chara` `tEXt` chunk, exactly
 * where the ecosystem and the product's decoder look for it.
 */
export function renderCardFixture(fixture) {
  const json = JSON.stringify(fixture.card);
  if (fixture.kind === "png") {
    const text = Buffer.from(`chara\u0000${Buffer.from(json, "utf8").toString("base64")}`, "latin1");
    const image = minimalPng();
    // Insert the card chunk directly after IHDR, before IDAT.
    const ihdrEnd = 8 + 25; // signature + IHDR chunk (12 bytes header + 13 data)
    const out = Buffer.concat([image.subarray(0, ihdrEnd), pngChunk("tEXt", text), image.subarray(ihdrEnd)]);
    return { fileName: `${fixture.name}.png`, bytes: out, json };
  }
  return { fileName: `${fixture.name}.json`, bytes: Buffer.from(json, "utf8"), json };
}
