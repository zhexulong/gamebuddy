import type { Locale } from "../i18n";

/**
 * The character domain's one vocabulary.
 *
 * The names here are the functional side's own names, not invented synonyms:
 * a character card contributes a `persona`, a `scenario`, `dialogue_examples`,
 * `lorebook` entries and an `opening`; the Host publishes exactly the stable
 * kinds `persona | scenario | dialogue_examples | lorebook_constant` plus
 * volatile `lorebook_entry`. There is deliberately no "greeting" kind on the
 * functional side - the first message a chat opens with is the opening
 * (`first_mes` / `alternate_greetings`), so the surface says "Opening".
 *
 * The strings live in this file (not `i18n.ts`, which a visual lane owns) and
 * are selected by the mount's own locale.
 */
export type CharacterLabels = Readonly<{
  unavailable: string;
  loading: string;
  saving: string;
  saved: string;
  saveFailed: string;
  discard: string;

  importTitle: string;
  importHint: string;
  importFileLabel: string;
  importChooseFile: string;
  importPasteLabel: string;
  importPasteHint: string;
  importSubmit: string;
  importBusy: string;
  importCreated: string;
  importCreatedDetail: string;
  importKept: string;
  importLorebookCount: string;
  importPreserved: string;
  importNotUsed: string;
  importAllUsed: string;
  importLongField: string;
  importVoiceCarried: string;
  importVoiceDropped: string;
  importFailed: string;
  importFailedText: string;
  importFailedTooLarge: string;
  /**
   * The staged-card review (design/26 §4.6): the Host's own field report is what
   * the player approves, so the words here name the decision, not the mechanics.
   */
  importReviewTitle: string;
  importReviewHint: string;
  importReviewName: string;
  importReviewWillKeep: string;
  importReviewConfirm: string;
  importReviewCancel: string;
  /**
   * The player-facing name of one card field. The review prints these words and
   * never the identifier it was handed: the Host's own field names
   * (`persona_core`, `example_1`, `system_prompt`) and the card keys the decoder
   * refuses (`regex_scripts`, `html`) are the artifact's vocabulary, not the
   * player's.
   */
  fieldName: string;
  fieldScenario: string;
  fieldVoiceDirective: string;
  fieldPersona: string;
  fieldPersonaInteractionStyle: string;
  fieldPersonaExpressionStyle: string;
  fieldExampleDialogue: string;
  fieldOpening: string;
  fieldAlternateOpening: string;
  fieldScript: string;
  fieldRegularExpressions: string;
  fieldMacros: string;
  fieldQuickReplies: string;
  fieldHtml: string;
  fieldPromptOrder: string;
  /** Between two field names in one sentence: a comma, or the CJK `、`. */
  fieldSeparator: string;
  historyTitle: string;
  historyHint: string;
  historyEmpty: string;
  historyFailed: string;

  companionsTitle: string;
  companionsEmpty: string;
  companionCurrent: string;
  /**
   * When a companion ADDED to the library becomes the one in play. The companion
   * in play comes from the deployment the Host starts with, and there is no
   * activation operation, so this surface offers no control and says so.
   */
  companionInPlay: string;
  /**
   * The roster row's own control, whose accessible name says what it does: it
   * VIEWS the companion's authored facts. It is not an activation control - the
   * companion in play is chosen by the start-up configuration - so the words never
   * promise a switch.
   */
  companionInspect: string;
  /** The inspector drawer's own vocabulary; every field is labelled, and an
   * absent one says she was made without it rather than showing an empty box. */
  companionInspectorClose: string;
  /** The in-play statement the inspector carries in its own words: a state, never
   * a control, because no activation operation exists. */
  companionInspectorInPlay: string;
  companionInspectorNotInPlay: string;
  companionInspectorUnavailable: string;
  companionInspectorPersonaTitle: string;
  companionInspectorPersonaCore: string;
  companionInspectorScenarioAbsent: string;
  companionInspectorOpeningsTitle: string;
  companionInspectorGreetingsAbsent: string;
  companionInspectorWorldBookTitle: string;
  companionInspectorWorldBookAbsent: string;
  /** "She was made without one" for a group whose heading already names the group. */
  companionInspectorAbsent: string;
  newCompanionTitle: string;
  newCompanionHint: string;
  newCompanionCreate: string;

  voiceTitle: string;
  voiceHint: string;
  voiceEmptyHint: string;
  voiceFromCard: string;
  voiceEditedByYou: string;
  voiceText: string;
  voiceSave: string;
  voiceClear: string;
  voiceAdd: string;
  voiceCancel: string;
  voiceSaveFailed: string;
  voiceCleared: string;

  personaTitle: string;
  personaHint: string;
  personaName: string;
  personaDescription: string;
  personaAbsent: string;
  personaPresent: string;
  personaSave: string;

  scenarioTitle: string;
  scenarioHint: string;
  scenarioName: string;
  scenarioDescription: string;
  scenarioAbsent: string;
  scenarioSave: string;

  openingTitle: string;
  openingHint: string;
  openingLabel: string;
  openingVariantText: string;
  openingAdd: string;
  openingAbsent: string;
  openingSave: string;

  worldBookTitle: string;
  worldBookHint: string;
  worldBookAttach: string;
  worldBookDetach: string;
  worldBookPending: string;
  worldBookUnavailable: string;
  worldBookFailed: string;

  /**
   * The managed library's authoring surface: a fresh product's library is
   * always empty, so the empty state is the entry point to the whole feature.
   */
  worldBookEmpty: string;
  worldBookCreate: string;
  worldBookCreateTitle: string;
  worldBookEditTitle: string;
  worldBookDraftHint: string;
  worldBookItemTitle: string;
  worldBookItemSummary: string;
  worldBookEntriesLabel: string;
  worldBookEntriesEmpty: string;
  worldBookShowEntries: string;
  worldBookHideEntries: string;
  worldBookEdit: string;
  worldBookDelete: string;
  worldBookDeleteConfirm: string;
  worldBookSave: string;
  worldBookCreateSubmit: string;
  worldBookCancel: string;
  worldBookEntryScope: string;
  worldBookEntryScopeCompanion: string;
  worldBookEntryScopeSetting: string;
  worldBookEntryTitle: string;
  worldBookEntrySummary: string;
  worldBookEntryKeys: string;
  worldBookEntryKeysHint: string;
  worldBookEntryAdd: string;
  worldBookEntryRemove: string;
  worldBookDeleted: string;
  worldBookCreateFailed: string;
  worldBookSaveFailed: string;
  worldBookDeleteFailed: string;
  worldBookDetailFailed: string;

  /**
   * The companion's OWN world book, which is a different thing from the list
   * above: it is what her card carried and what she always has with her.
   */
  companionWorldBookTitle: string;
  companionWorldBookHint: string;
  companionWorldBookCount: string;
  companionWorldBookTriggerWords: string;
  companionWorldBookKeySeparator: string;
  companionWorldBookAlwaysOn: string;
  companionWorldBookNoEntries: string;
  /** The disclosure that reveals one entry's own text. */
  companionWorldBookEntryText: string;

  /** The decoder's own disposition classes, in player words. */
  dispositionAccepted: string;
  dispositionPreserved: string;
  dispositionDropped: string;
  dispositionRejected: string;
}>;

const en: CharacterLabels = Object.freeze({
  unavailable: "Character management is unavailable in this profile.",
  loading: "Loading…",
  saving: "Saving…",
  saved: "Saved.",
  saveFailed: "Could not save. The content changed elsewhere; reload and retry.",
  discard: "Discard",

  importTitle: "Import a character card",
  importHint:
    "Choose a character card file (.json or .png). You can also paste the card text below. The file is read in your browser and stays on this machine.",
  importFileLabel: "Character card file",
  importChooseFile: "Choose card file",
  importPasteLabel: "Paste card text",
  importPasteHint: "SillyTavern V2/V3 JSON.",
  importSubmit: "Import card",
  importBusy: "Importing…",
  importCreated: "Imported {{name}}.",
  importCreatedDetail:
    "She is archived safely in your local companion library; the companion in play is chosen by the start-up configuration, so she becomes the one in play only when GameBuddy later starts with her.",
  importKept: "Kept {{count}} card fields.",
  importLorebookCount: "Carries {{count}} lorebook entries.",
  importPreserved: "Kept {{count}} fields unchanged.",
  importNotUsed: "Could not use: {{fields}}.",
  importAllUsed: "Every card field was usable.",
  importLongField: "This description is long ({{chars}} chars); it may raise per-turn token use.",
  importVoiceCarried: "Keeps the card's own performance directive.",
  importVoiceDropped: "The card's own performance directive was too long and was not kept.",
  importFailed: "The card could not be imported.",
  importFailedText: "That file is not readable character card text.",
  importFailedTooLarge: "That file is too large to import (limit 2 MB).",
  importReviewTitle: "Review before importing",
  importReviewHint:
    "Nothing has been imported yet. This is what the Host staged from the card - what it will keep and what it could not use - and the companion is created only when you confirm.",
  importReviewName: "The card names it {{name}}.",
  importReviewWillKeep: "Will keep {{count}} card fields: {{fields}}.",
  importReviewConfirm: "Import this card",
  importReviewCancel: "Cancel",
  fieldName: "Name",
  fieldScenario: "Scenario",
  fieldVoiceDirective: "Performance directive",
  fieldPersona: "Persona",
  fieldPersonaInteractionStyle: "Interaction style",
  fieldPersonaExpressionStyle: "Expression style",
  fieldExampleDialogue: "Example dialogue",
  fieldOpening: "Opening",
  fieldAlternateOpening: "Alternate opening",
  fieldScript: "Script",
  fieldRegularExpressions: "Regular expressions",
  fieldMacros: "Macros",
  fieldQuickReplies: "Quick replies",
  fieldHtml: "HTML",
  fieldPromptOrder: "Prompt order",
  fieldSeparator: ", ",
  historyTitle: "Imported cards",
  historyHint: "Every imported card and what it kept or dropped.",
  historyEmpty: "No cards imported yet.",
  historyFailed: "The import history could not be read.",

  companionsTitle: "Companions",
  companionsEmpty: "No companions yet.",
  companionCurrent: "current",
  companionInPlay:
    "The companion in play is chosen by the start-up configuration — a companion imported or created here is archived safely in your local companion library, and becomes the one in play only when GameBuddy later starts with her.",
  companionInspect: "View {{name}}'s character",
  companionInspectorClose: "Close",
  companionInspectorInPlay: "This is the companion in play.",
  companionInspectorNotInPlay:
    "{{name}} is saved in your companion library. She is not the companion in play — the companion in play was chosen by the start-up configuration, and viewing her character here does not change that.",
  companionInspectorUnavailable: "Her character could not be read.",
  companionInspectorPersonaTitle: "Description and personality",
  companionInspectorPersonaCore: "Who she is",
  companionInspectorScenarioAbsent: "She was made without a scenario.",
  companionInspectorOpeningsTitle: "Openings",
  companionInspectorGreetingsAbsent: "She was made without an opening; a chat with her starts empty.",
  companionInspectorWorldBookTitle: "Her own world book",
  companionInspectorWorldBookAbsent: "She was made without a world book.",
  companionInspectorAbsent: "She was made without one.",
  newCompanionTitle: "New companion",
  newCompanionHint: "A display name only; GameBuddy mints every identity.",
  newCompanionCreate: "Create companion",

  voiceTitle: "Performance directive",
  voiceHint:
    "The card's own direction for how this companion performs, kept after the Host's floor. You can rewrite it or clear it; a cleared directive is absent from the prompt rather than empty.",
  voiceEmptyHint:
    "This companion has no performance directive yet. You can write one here; it is stored with her and used when she performs.",
  voiceFromCard: "From the card",
  voiceEditedByYou: "Edited by you",
  voiceText: "Directive",
  voiceSave: "Save directive",
  voiceClear: "Clear directive",
  voiceAdd: "Add a performance directive",
  voiceCancel: "Cancel",
  voiceSaveFailed: "Could not save the directive. It changed elsewhere; reload and retry.",
  voiceCleared: "Cleared.",

  personaTitle: "Persona",
  personaHint: "How your companion sees you.",
  personaName: "Your display name",
  personaDescription: "Persona description",
  personaAbsent: "No persona saved yet.",
  personaPresent: "Saved",
  personaSave: "Save persona",

  scenarioTitle: "Scenario",
  scenarioHint: "The setting your companion assumes.",
  scenarioName: "Scenario name",
  scenarioDescription: "Scenario",
  scenarioAbsent: "No scenario saved yet.",
  scenarioSave: "Save scenario",

  openingTitle: "Opening",
  openingHint: "The first message this character can open a chat with. You choose one when a chat starts.",
  openingLabel: "Opening label",
  openingVariantText: "Opening text",
  openingAdd: "Add opening",
  openingAbsent: "No opening saved yet.",
  openingSave: "Save opening",

  worldBookTitle: "World books you can attach",
  worldBookHint:
    "World books from the library that this conversation can attach. Your companion's own world book is a different list, and it is always with her.",
  worldBookAttach: "Attach",
  worldBookDetach: "Detach",
  worldBookPending: "Saved. It fully applies on the next turn.",
  worldBookUnavailable: "The world book is temporarily unavailable.",
  worldBookFailed: "The world book could not be updated.",

  worldBookEmpty: "Your world book library is empty.",
  worldBookCreate: "Create a world book",
  worldBookCreateTitle: "New world book",
  worldBookEditTitle: "Editing {{title}}",
  worldBookDraftHint:
    "A world book is a title, a summary and at least one entry. An entry is used when your own words match one of its trigger words.",
  worldBookItemTitle: "Title",
  worldBookItemSummary: "Summary",
  worldBookEntriesLabel: "Entries",
  worldBookEntriesEmpty: "This world book carries no entries yet.",
  worldBookShowEntries: "Read it",
  worldBookHideEntries: "Close",
  worldBookEdit: "Edit",
  worldBookDelete: "Delete",
  worldBookDeleteConfirm: "Remove {{title}} from the library?",
  worldBookSave: "Save",
  worldBookCreateSubmit: "Create",
  worldBookCancel: "Cancel",
  worldBookEntryScope: "Whose fact is it",
  worldBookEntryScopeCompanion: "About her",
  worldBookEntryScopeSetting: "About the world",
  worldBookEntryTitle: "Entry title",
  worldBookEntrySummary: "What it says",
  worldBookEntryKeys: "Trigger words",
  worldBookEntryKeysHint: "Separated by commas. Leave empty for an entry that is always on.",
  worldBookEntryAdd: "Add entry",
  worldBookEntryRemove: "Remove entry",
  worldBookDeleted: "Removed from the library.",
  worldBookCreateFailed: "The world book could not be created.",
  worldBookSaveFailed: "The world book could not be saved.",
  worldBookDeleteFailed: "The world book could not be deleted.",
  worldBookDetailFailed: "Its own text could not be read.",

  companionWorldBookTitle: "Your companion's own world book",
  companionWorldBookHint:
    "The world book her card carried, kept here with her. An entry is used when your own words match one of its trigger words, unless it is marked as always on.",
  companionWorldBookCount: "Entries in her own book: {{count}}",
  companionWorldBookTriggerWords: "Trigger words: {{keys}}",
  companionWorldBookKeySeparator: ", ",
  companionWorldBookAlwaysOn: "Always with her",
  companionWorldBookNoEntries: "Her own book is here, but it carries no entries yet.",
  companionWorldBookEntryText: "What it says",

  dispositionAccepted: "used",
  dispositionPreserved: "kept unchanged",
  dispositionDropped: "not used",
  dispositionRejected: "rejected",
});

const zh: CharacterLabels = Object.freeze({
  unavailable: "当前配置不支持角色管理。",
  loading: "加载中…",
  saving: "保存中…",
  saved: "已保存。",
  saveFailed: "无法保存。内容已在其他位置更改；请重新加载后再试。",
  discard: "丢弃",

  importTitle: "导入角色卡",
  importHint: "选择角色卡文件（.json 或 .png）。也可以在下方粘贴角色卡文本。文件在你的浏览器中读取，不会离开本机。",
  importFileLabel: "角色卡文件",
  importChooseFile: "选择角色卡文件",
  importPasteLabel: "粘贴角色卡文本",
  importPasteHint: "SillyTavern V2/V3 JSON。",
  importSubmit: "导入角色卡",
  importBusy: "正在导入…",
  importCreated: "已导入 {{name}}。",
  importCreatedDetail:
    "她已安全归档到本地伙伴库；在玩的伙伴由启动配置选定，所以只有在 GameBuddy 以她重新启动后，她才会成为在玩的伙伴。",
  importKept: "已保留 {{count}} 个卡片字段。",
  importLorebookCount: "包含 {{count}} 条世界书词条。",
  importPreserved: "有 {{count}} 个字段原样保留。",
  importNotUsed: "无法使用：{{fields}}。",
  importAllUsed: "卡片的所有字段均可使用。",
  importLongField: "该描述较长（{{chars}} 字符），可能会增加每轮 Token 消耗。",
  importVoiceCarried: "保留卡片自带的演出指导。",
  importVoiceDropped: "卡片自带的演出指导过长，未能保留。",
  importFailed: "无法导入该角色卡。",
  importFailedText: "该文件不是可读取的角色卡文本。",
  importFailedTooLarge: "该文件过大，无法导入（上限 2 MB）。",
  importReviewTitle: "导入前确认",
  importReviewHint:
    "尚未导入任何内容。以下是 Host 从卡片中暂存的结果——将保留什么、无法使用什么；只有你确认后才会创建伙伴。",
  importReviewName: "卡片中的名称为 {{name}}。",
  importReviewWillKeep: "将保留 {{count}} 个卡片字段：{{fields}}。",
  importReviewConfirm: "导入此角色卡",
  importReviewCancel: "取消",
  fieldName: "名称",
  fieldScenario: "场景",
  fieldVoiceDirective: "演出指导",
  fieldPersona: "用户设定",
  fieldPersonaInteractionStyle: "互动风格",
  fieldPersonaExpressionStyle: "表达风格",
  fieldExampleDialogue: "对话示例",
  fieldOpening: "开场白",
  fieldAlternateOpening: "备用开场白",
  fieldScript: "脚本",
  fieldRegularExpressions: "正则表达式",
  fieldMacros: "宏",
  fieldQuickReplies: "快捷回复",
  fieldHtml: "HTML",
  fieldPromptOrder: "提示词顺序",
  fieldSeparator: "、",
  historyTitle: "已导入的角色卡",
  historyHint: "每次导入的角色卡，以及保留或丢弃的内容。",
  historyEmpty: "暂无已导入的角色卡。",
  historyFailed: "无法读取导入历史。",

  companionsTitle: "伙伴",
  companionsEmpty: "还没有伙伴。",
  companionCurrent: "当前",
  companionInPlay:
    "在玩的伙伴由启动配置选定——你在这里导入或创建的伙伴会安全归档到本地伙伴库，只有在 GameBuddy 以她重新启动后，她才会成为在玩的伙伴。",
  companionInspect: "查看 {{name}} 的角色",
  companionInspectorClose: "关闭",
  companionInspectorInPlay: "这就是在玩的伙伴。",
  companionInspectorNotInPlay:
    "{{name}} 已保存在你的伙伴库中。她不是在玩的伙伴——在玩的伙伴由启动配置选定，在这里查看她的角色并不会改变这一点。",
  companionInspectorUnavailable: "无法读取她的角色资料。",
  companionInspectorPersonaTitle: "描述与性格",
  companionInspectorPersonaCore: "她是谁",
  companionInspectorScenarioAbsent: "创建她时没有场景。",
  companionInspectorOpeningsTitle: "开场白",
  companionInspectorGreetingsAbsent: "创建她时没有开场白；与她的对话会以空白开始。",
  companionInspectorWorldBookTitle: "她自己的世界书",
  companionInspectorWorldBookAbsent: "创建她时没有世界书。",
  companionInspectorAbsent: "创建她时没有这项设定。",
  newCompanionTitle: "新建伙伴",
  newCompanionHint: "只需填写显示名称；所有身份由 GameBuddy 铸造。",
  newCompanionCreate: "创建伙伴",

  voiceTitle: "演出指导",
  voiceHint:
    "卡片自带的演出指令，位于 Host 底层规则之后。你可以改写或清除；清除后提示词中不再出现该指令，而不是留下一段空文本。",
  voiceEmptyHint: "这位同伴还没有演出指导。你可以在这里写一条；它会随她保存，并在她演出时用于提示词。",
  voiceFromCard: "来自卡片",
  voiceEditedByYou: "你已修改",
  voiceText: "指令内容",
  voiceSave: "保存指令",
  voiceClear: "清除指令",
  voiceAdd: "添加演出指导",
  voiceCancel: "取消",
  voiceSaveFailed: "无法保存指令。内容已在其他位置更改；请重新加载后再试。",
  voiceCleared: "已清除。",

  personaTitle: "用户设定",
  personaHint: "你希望伙伴如何认识你。",
  personaName: "你的显示名称",
  personaDescription: "用户设定描述",
  personaAbsent: "还没有保存用户设定。",
  personaPresent: "已设置",
  personaSave: "保存用户设定",

  scenarioTitle: "场景",
  scenarioHint: "伙伴所假设的情境。",
  scenarioName: "场景名称",
  scenarioDescription: "场景文本",
  scenarioAbsent: "还没有保存场景。",
  scenarioSave: "保存场景",

  openingTitle: "开场白",
  openingHint: "该角色用于开始对话的第一句话；开始新对话时你可以选择其中一个。",
  openingLabel: "开场白标签",
  openingVariantText: "开场白文本",
  openingAdd: "添加开场白",
  openingAbsent: "还没有保存开场白。",
  openingSave: "保存开场白",

  worldBookTitle: "可关联的世界书",
  worldBookHint: "可以从库里关联到这次对话的世界书。伴侣自己的世界书是另一份清单，始终跟她在一起。",
  worldBookAttach: "关联",
  worldBookDetach: "解除关联",
  worldBookPending: "已保存，将在下一回合完全生效。",
  worldBookUnavailable: "世界书暂时不可用。",
  worldBookFailed: "无法更新世界书。",

  worldBookEmpty: "你的世界书库还是空的。",
  worldBookCreate: "新建世界书",
  worldBookCreateTitle: "新建世界书",
  worldBookEditTitle: "正在编辑 {{title}}",
  worldBookDraftHint: "一本世界书由标题、简介和至少一条词条组成。当你的话命中词条的触发词时，这条词条才会被用到。",
  worldBookItemTitle: "标题",
  worldBookItemSummary: "简介",
  worldBookEntriesLabel: "词条",
  worldBookEntriesEmpty: "这本世界书里还没有词条。",
  worldBookShowEntries: "查看内容",
  worldBookHideEntries: "收起",
  worldBookEdit: "编辑",
  worldBookDelete: "删除",
  worldBookDeleteConfirm: "要把 {{title}} 从书库中删除吗？",
  worldBookSave: "保存",
  worldBookCreateSubmit: "创建",
  worldBookCancel: "取消",
  worldBookEntryScope: "属于谁的设定",
  worldBookEntryScopeCompanion: "关于她",
  worldBookEntryScopeSetting: "关于世界",
  worldBookEntryTitle: "词条标题",
  worldBookEntrySummary: "词条内容",
  worldBookEntryKeys: "触发词",
  worldBookEntryKeysHint: "用逗号分隔。留空表示这条词条始终生效。",
  worldBookEntryAdd: "添加词条",
  worldBookEntryRemove: "移除词条",
  worldBookDeleted: "已从书库中删除。",
  worldBookCreateFailed: "无法创建这本世界书。",
  worldBookSaveFailed: "无法保存这本世界书。",
  worldBookDeleteFailed: "无法删除这本世界书。",
  worldBookDetailFailed: "无法读取它的内容。",

  companionWorldBookTitle: "伴侣自己的世界书",
  companionWorldBookHint:
    "她卡片自带的世界书，一直保存在她这里。当你自己的话命中某条词条的触发词时，这条词条才会被用到；标为常驻的除外。",
  companionWorldBookCount: "她自己的世界书里有 {{count}} 条词条",
  companionWorldBookTriggerWords: "触发词：{{keys}}",
  companionWorldBookKeySeparator: "、",
  companionWorldBookAlwaysOn: "始终随行",
  companionWorldBookNoEntries: "她的世界书已在这里，但里面还没有词条。",
  companionWorldBookEntryText: "看看正文",

  dispositionAccepted: "已使用",
  dispositionPreserved: "原样保留",
  dispositionDropped: "未使用",
  dispositionRejected: "已拒绝",
});

export function characterLabels(locale: Locale): CharacterLabels {
  return locale === "zh-CN" ? zh : en;
}

/**
 * The player-facing name of one field the Host reported.
 *
 * The caller hands over the Host's own identifier and gets back a word the
 * player reads. The vocabulary is the Host's candidate fields
 * (`st-card-import-service.ts`) plus the card keys its decoder refuses
 * (`st-card-import.ts`, the executable-control family); an identifier from
 * outside it is spelled out from its own key rather than printed raw, so no
 * identifier reaches the DOM even when a card carries a field this list has
 * never seen.
 */
export function characterFieldLabel(field: string, labels: CharacterLabels): string {
  const key = field.toLowerCase();
  switch (key) {
    case "name":
      return labels.fieldName;
    case "scenario":
      return labels.fieldScenario;
    case "system_prompt":
      return labels.fieldVoiceDirective;
    case "persona_core":
      return labels.fieldPersona;
    case "persona_interaction_style":
      return labels.fieldPersonaInteractionStyle;
    case "persona_expression_style":
      return labels.fieldPersonaExpressionStyle;
    case "first_greeting":
      return labels.fieldOpening;
    case "alternate_greetings":
      return labels.fieldAlternateOpening;
    default:
      break;
  }
  if (/^example_\d+$/u.test(key)) return labels.fieldExampleDialogue;
  if (/^alternate_greeting_\d+$/u.test(key)) return labels.fieldAlternateOpening;
  if (/^(?:script|stscript)$/u.test(key)) return labels.fieldScript;
  if (/^regex(?:es)?(?:_scripts?)?$/u.test(key) || key === "scripts") return labels.fieldRegularExpressions;
  if (/^macros?$/u.test(key)) return labels.fieldMacros;
  if (/^quick_?repl(?:ies)?$/u.test(key)) return labels.fieldQuickReplies;
  if (key === "html") return labels.fieldHtml;
  if (/^prompt_?order$/u.test(key)) return labels.fieldPromptOrder;
  return humanizeFieldKey(field);
}

/**
 * An identifier the vocabulary does not know, spelled out from its own key. The
 * underscores are what makes a key read as an identifier; the sentence is the
 * fallback, and it is deliberately not the raw key.
 */
function humanizeFieldKey(field: string): string {
  const words = field.split(/[\s_]+/u).filter((word) => word.length > 0);
  const [first, ...rest] = words;
  if (first === undefined) return field;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
