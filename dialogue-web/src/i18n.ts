export type Locale = "en" | "zh-CN";

const STORAGE_KEY = "gamebuddy.tavern.ui-locale";

const en = {
  appName: "GameBuddy Tavern",
  skipToChat: "Skip to chat",
  readOnlyChat: "Read-only chat",
  online: "Online",
  generating: "Thinking…",
  you: "You",
  companion: "Companion",
  chatTranscript: "Chat transcript",
  emptyChat: "No messages in this chat.",
  untitledChat: "Untitled chat",
  savedDraft: "Saved draft",
  noSavedDraft: "No saved draft.",
  openingChat: "Opening chat…",

  // Navigation & Drawers
  chats: "Chats",
  characters: "Characters",
  worldInfo: "World Info",
  persona: "Persona",
  memory: "Memory",
  settings: "Settings",

  // Chat Actions
  newChat: "New Chat",
  exportChat: "Export Chat",
  renameChat: "Rename Chat",
  deleteChat: "Delete Chat",
  chatHistory: "Chat History",

  // Character Actions
  activeCharacter: "Active Character",
  allCharacters: "All Characters",
  newCharacter: "New Character",
  characterName: "Character Name",
  importCharacterCard: "Import Character Card",
  pasteCardJson: "Paste Card JSON",
  reviewDetails: "Review Details",
  confirmCharacter: "Confirm Character",
  create: "Create",
  import: "Import",

  // World Info
  worldInfoEntries: "World Info Entries",
  addEntry: "Add Entry",
  entryKey: "Key / Keyword",
  entryTitle: "Title",
  entryContent: "Content",
  attachToChat: "Attach to Chat",
  worldInfoBindingTitle: "World Info Binding",
  worldInfoBind: "Bind",
  worldInfoUnbind: "Unbind",
  worldInfoEmpty: "No World Info revisions are available to bind.",
  worldInfoLocked: "World Info binding is locked after this chat has messages.",
  worldInfoUnavailable: "World Info binding is temporarily unavailable.",
  worldInfoBindingFailure: "World Info binding could not be updated.",

  // Persona
  userPersona: "User Persona",
  personaName: "Your Display Name",
  personaDescription: "Persona Description",
  save: "Save",
  discard: "Discard",

  // Memory
  semanticMemory: "Semantic Memory",
  noMemories: "No recorded memories yet.",
  refreshMemory: "Refresh Memory",
  memoryContent: "Memory content",
  editMemory: "Edit memory",
  archiveMemory: "Archive memory",
  deleteMemory: "Delete memory",

  // Composer
  typeMessagePlaceholder: "Type a message to your companion… (Enter to send, Shift+Enter for newline)",
  send: "Send",
  stop: "Stop",
  chatStopped: "Reply stopped. You can send another message.",
  chatFailed: "The reply failed. You can try again.",

  // Settings & System
  language: "Language",
  english: "English",
  chinese: "Simplified Chinese",
  modelProfile: "Model Profile",
  chatModelProfile: "Chat Model Profile",
  gameModelProfile: "Game Companion Profile",
  surface: "Surface",
  model: "Model",
  thinkingLevel: "Thinking Level",
  high: "High",
  active: "Active",
  independent: "Independent",
  noWorldInfo: "No World Info entries yet.",
  noChats: "No saved chats yet.",
  theme: "Theme",
  close: "Close",
  back: "Back",
  success: "Saved successfully.",
  failure: "Operation failed.",

  problemBootstrapUnavailableTitle: "Unable to open chat",
  problemBootstrapUnavailableDetail: "The bootstrap handoff is unavailable.",
  problemTemporarilyUnavailableTitle: "Unable to read chat",
  problemTemporarilyUnavailableDetail: "The chat state is temporarily unavailable.",
  problemReconciliationFailedTitle: "Unable to read chat",
  problemReconciliationFailedDetail: "The chat state could not be safely reconciled.",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

const zh: Messages = {
  appName: "GameBuddy 酒馆",
  skipToChat: "跳至聊天内容",
  readOnlyChat: "只读会话",
  online: "在线",
  generating: "思考中…",
  you: "你",
  companion: "角色",
  chatTranscript: "聊天记录",
  emptyChat: "当前聊天暂无消息。",
  untitledChat: "未命名聊天",
  savedDraft: "已保存草稿",
  noSavedDraft: "无本地草稿。",
  openingChat: "正在读取聊天…",

  // Navigation & Drawers
  chats: "会话",
  characters: "角色",
  worldInfo: "世界书",
  persona: "用户设定",
  memory: "记忆",
  settings: "设置",

  // Chat Actions
  newChat: "新建会话",
  exportChat: "导出聊天",
  renameChat: "重命名会话",
  deleteChat: "删除会话",
  chatHistory: "历史会话",

  // Character Actions
  activeCharacter: "当前活动角色",
  allCharacters: "全部角色",
  newCharacter: "新建角色",
  characterName: "角色名称",
  importCharacterCard: "导入角色卡",
  pasteCardJson: "粘贴角色卡 JSON",
  reviewDetails: "确认角色信息",
  confirmCharacter: "确认创建角色",
  create: "创建",
  import: "导入",

  // World Info
  worldInfoEntries: "世界书词条",
  addEntry: "添加词条",
  entryKey: "触发关键字",
  entryTitle: "词条标题",
  entryContent: "词条内容",
  attachToChat: "关联至当前对话",
  worldInfoBindingTitle: "世界书绑定",
  worldInfoBind: "绑定",
  worldInfoUnbind: "解除绑定",
  worldInfoEmpty: "没有可绑定的世界书版本。",
  worldInfoLocked: "当前对话已有消息，世界书绑定已锁定。",
  worldInfoUnavailable: "世界书绑定暂时不可用。",
  worldInfoBindingFailure: "无法更新世界书绑定。",

  // Persona
  userPersona: "用户设定 (Persona)",
  personaName: "你的显示名称",
  personaDescription: "设定描述 (外貌、身份、习惯等)",
  save: "保存",
  discard: "丢弃",

  // Memory
  semanticMemory: "长期记忆 (Semantic Memory)",
  noMemories: "暂未记录任何长期记忆。",
  refreshMemory: "刷新记忆",
  memoryContent: "记忆内容",
  editMemory: "编辑记忆",
  archiveMemory: "归档记忆",
  deleteMemory: "删除记忆",

  // Composer
  typeMessagePlaceholder: "给伴侣发送消息… (Enter 发送, Shift+Enter 换行)",
  send: "发送",
  stop: "停止生成",
  chatStopped: "回复已停止。你可以发送另一条消息。",
  chatFailed: "回复失败。你可以重试。",

  // Settings & System
  language: "语言",
  english: "English",
  chinese: "简体中文",
  modelProfile: "模型配置",
  chatModelProfile: "会话模型配置",
  gameModelProfile: "游戏伴侣模型配置",
  surface: "作用域",
  model: "模型",
  thinkingLevel: "思考强度",
  high: "高",
  active: "已生效",
  independent: "独立配置",
  noWorldInfo: "暂无世界书词条。",
  noChats: "暂无历史会话。",
  theme: "主题",
  close: "关闭",
  back: "返回",
  success: "保存成功。",
  failure: "操作失败。",

  problemBootstrapUnavailableTitle: "无法打开聊天",
  problemBootstrapUnavailableDetail: "Bootstrap 令牌不可用。",
  problemTemporarilyUnavailableTitle: "无法读取聊天",
  problemTemporarilyUnavailableDetail: "聊天状态暂时不可用。",
  problemReconciliationFailedTitle: "无法读取聊天",
  problemReconciliationFailedDetail: "聊天状态未能安全对齐。",
} satisfies Record<MessageKey, string>;

export function messages(locale: Locale): Messages {
  return locale === "zh-CN" ? zh : en;
}

export function resolveLocale(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null,
  nav: Pick<Navigator, "languages" | "language"> | null = typeof navigator !== "undefined" ? navigator : null,
): Locale {
  const saved = storage?.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "zh-CN") return saved;

  const languages = nav ? [...(nav.languages ?? []), nav.language] : [];
  return languages.some((value) => value?.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

export function applyDocumentLocale(
  locale: Locale,
  doc: { documentElement: { lang: string } } | null = typeof document !== "undefined" ? document : null,
): void {
  if (doc) {
    doc.documentElement.lang = locale;
  }
}

export function persistLocale(
  locale: Locale,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null,
): void {
  storage?.setItem(STORAGE_KEY, locale);
}
