/**
 * The behaviour vocabulary the shipped persona examples are read against - THE DECLARED HALF of
 * `tools/check-persona-example-behaviours.mjs`, and the only list that gate holds.
 *
 * WHY THIS FILE EXISTS. A sentence was added to the card on 2026-11-12 (`f731fbb9`):
 *
 *   `动作回执是内部认知，绝不翻成台词广播；但对手头东西的评价、对工具的嫌弃不用回执，直接说。`
 *
 * The second clause is a PERMISSION: evaluating the thing in her hands and complaining about a tool are the two things
 * she says without an action receipt behind it. An uncommitted edit deleted it, and after the deletion
 * `git grep '对工具的嫌弃|评价'` found it in no file - not the card, not the three presets, not either world book, not
 * any gate - while `card.json`'s own `mes_example` still demonstrated exactly those two behaviours
 * (`这泥巴比水泥还黏靴子`, `震得我手腕生疼，火星子直冒`). Nothing would have caught it; a lane read the diff. This
 * table and the gate beside it are the refusal that was missing.
 *
 * WHAT IS DERIVED AND WHAT IS DECLARED. The gate derives three things and this file declares one:
 *
 *   derived   the example population - every `{{char}}` turn every `card.json` under `assets/tavern/presets/**` ships,
 *             taken from `data.mes_example` (a string, the CCv2 shape the card uses) or `data.mes_examples` (an array),
 *             so a new example joins the population without an edit here.
 *   derived   the claim corpus - the card's rule fields, the three preset documents' `prompts[*].name/content`, and
 *             every world book's `alwaysOnPremise` + `entries[*].title/content`, read from a directory scan.
 *   derived   where each claim sentence lives, so a finding can print a file and a sentence and nothing here has to go
 *             stale when a clause moves between files.
 *   declared  this table: which behaviour a sample of her speech exhibits, and the sentence that permits or forbids it.
 *
 * THE LIMIT, stated plainly because it is the whole reason this docblock is long: splitting Chinese dialogue into
 * behaviours is a semantic judgement, so the split cannot be derived, and a declared table is a LIST - which in this
 * repository is a test, not a gate. What turns it back into a gate is that the list is closed from both ends and
 * expires: the gate refuses an example no row covers (`example_unclassified`), a row whose sample the card no longer
 * ships (`behaviour_claim_stale` / `behaviour_claim_unmatched`), a row whose sentence the corpus no longer contains
 * (`example_demonstrates_a_behaviour_no_claim_permits`), and a `mode` outside the closed pair. It cannot adjudicate
 * whether a row's behaviour name is the right reading of the line; a reader can, and the table is short enough to read.
 *
 * THE VOCABULARY IS SIZED BY THE EXAMPLES, NOT BY THE DOMAIN. It was built by splitting the 15 turns the card ships
 * today and then merging names that covered the same turn, not by enumerating behaviours a companion could have. 11
 * rows for 15 turns; the gate prints, per row, how many examples carry its samples, and the ~12-row budget is the
 * tripwire for the failure mode this design has: if the examples were not behaviour samples at all, the table would grow
 * a row per line and stop being read.
 *
 * MODE. `permitted` and `forbidden` are the two halves of the gate's property - the sentence either allows the
 * behaviour or bans it - and the closed pair is validated. It is not a verdict: one row below (`files_an_action_receipt`)
 * is `forbidden` and is demonstrated by three shipped examples anyway, which is a real tension in the card and not this
 * gate's to settle. It is recorded here so the next reader meets it as a fact rather than discovering it.
 *
 * WHAT IS NOT AN EXAMPLE. `first_mes` and `alternate_greetings` are authored OPENINGS - shown verbatim once before the
 * player has spoken - not samples of how she answers him, so the population excludes them by name instead of silently.
 * `data.character_book` is excluded from the claim corpus because `default-companion/worldbook.json` carries the same
 * eleven entries in the shape the assembly reads; one fact, one spelling.
 *
 * Every `claim` below is quoted verbatim from the card. `{{user}}` and `{{char}}` stay as the card writes them.
 *
 * THE 2026-11-17 REVERSAL, written here rather than left in a diff, because this table exists for exactly one
 * reason and the reason just changed. The permission the incident above was about - `对工具的嫌弃不用回执，直接说`
 * - was DELETED from `data.system_prompt` on the operator's ruling: a licence to vent about a tool without a
 * receipt is a back door that turns every micro-frustration into speech, which is the `不报备、不解说` rule the
 * same sentence begins with, undermined by its own second clause. What survives is `对手头东西的评价不用回执，
 * 直接说` - evaluating the thing in her hands is not a frustration and is not what the ruling named - and the
 * clause that replaced the licence governs WORK rather than speech: `干活时心照不宣，不报备、不解说，有事才说事`.
 * So the two rows that were tied to the deleted sentence are re-tied, and neither row loses its behaviour:
 * `evaluates_the_thing_in_hand` follows the surviving half it was always about, and `complains_about_a_tool`
 * follows `只用来调侃活计和工具`, the card's own standing licence to aim that caustic edge at the work and the
 * tools. This reverses the recorded decision at `assets/tavern/presets/PERSONA-REVISION.md` row `394f77da`
 * (2026-11-16, "the permission ... is RESTORED rather than deleted"); a reversal that is written down is the
 * cheap part, and a reversal that is silent is what the gate above was built to refuse.
 */

/** The closed pair a row's `mode` must be in: the sentence allows the behaviour, or it bans it. */
export const CLAIM_MODES = Object.freeze(["permitted", "forbidden"]);

/**
 * `behaviour` is the name a finding prints. `samples` are verbatim fragments of the shipped examples that exhibit it -
 * an anchor is a fragment, not a whole line, so a line that is rewritten around the behaviour keeps its row.
 */
export const BEHAVIOURS = Object.freeze([
  {
    behaviour: "evaluates_the_thing_in_hand",
    gloss: "评价手头这件事物本身：菜、泥、收成",
    mode: "permitted",
    claim: "对手头东西的评价不用回执，直接说",
    samples: ["这泥巴比水泥还黏靴子", "长得真胖", "没白费力气"],
  },
  {
    behaviour: "complains_about_a_tool",
    gloss: "嫌弃手上的工具或活计的体感",
    mode: "permitted",
    claim: "只用来调侃活计和工具",
    samples: ["震得我手腕生疼", "水壶沉死了"],
  },
  {
    behaviour: "reports_an_immediate_obstacle",
    gloss: "遇上闭店、卡路或阻塞时，只讲眼前这道障碍",
    mode: "permitted",
    claim: "遇上卡路、没体力、天黑，若交流只讲眼前这道障碍，不讲原因、不讲规则",
    samples: ["罗宾门口挂着休业牌呢", "东头那块大石头把路口堵死了"],
  },
  {
    behaviour: "asks_the_user_a_question",
    gloss: "把选择或情况当问题抛回去，有商有量",
    mode: "permitted",
    claim: "有商有量",
    samples: ["还是去河边碰运气钓鲶鱼？", "兜里还有南边树林拔的野葱没？", "听见蝙蝠扑腾没？"],
  },
  {
    behaviour: "divides_the_work",
    gloss: "分工：这块我干，你去干那块",
    mode: "permitted",
    claim: "最享受分工明确、各自干完活在门口碰头的踏实感",
    samples: ["西边那畦土豆交给我", "地里杂草交给我", "剩下这几垄我来整"],
  },
  {
    behaviour: "teases_the_user",
    gloss: "发小之间的熟稔互怼，拿旧事和糗事打趣",
    mode: "permitted",
    claim: "熟稔互怼",
    samples: ["望夫石", "野桑葚劲头哪儿去了", "罚你挑水"],
  },
  {
    behaviour: "tells_the_user_to_do_something",
    gloss: "直接使唤对方，不留客套和低姿态",
    mode: "permitted",
    claim: "绝无半分低姿态保姆腔或客套",
    samples: ["靴子脱门口啊", "杂草乱石赶紧扔了", "赶紧喝两口定定神"],
  },
  {
    behaviour: "warns_of_the_0200_cost",
    gloss: "拿两点昏倒、被哈维扣急救费来催",
    mode: "permitted",
    claim: "绝不熬过一点半给哈维送急救费",
    samples: ["大几百急诊费"],
  },
  {
    behaviour: "stops_to_rest_when_spent",
    gloss: "体力到底就收手回屋，不硬撑",
    mode: "permitted",
    claim: "没体力了绝不硬撑，立刻停手回屋休息",
    samples: ["不干了，手腕酸得快不是自己的了", "我先躺下睡了啊"],
  },
  {
    behaviour: "takes_up_the_users_words_first",
    gloss: "第一句先接住对方刚说的话、刚留的便签",
    mode: "permitted",
    claim: "第一句就落到他的句子上",
    samples: ["便签看到了", "石头够了，还差四块铜矿"],
  },
  {
    behaviour: "comforts_with_her_own_scar",
    gloss: "用自己熬夜做图的旧伤、递凉水开窗来定神，不端着讲道理",
    mode: "permitted",
    claim: "用自嘲吐槽、递凉水或开窗吹冷风帮对方定神",
    samples: ["这德行我也犯过"],
  },
]);
