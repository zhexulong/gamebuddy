export type Locale = "en" | "zh-CN";

const STORAGE_KEY = "gamebuddy.tavern.ui-locale";

const en = {
  // The product's own name, and nothing more: the architecture noun behind it is
  // internal vocabulary a player never needs, and printing it beside the brand
  // made the app bar read as two products.
  appName: "GameBuddy",
  skipToChat: "Skip to chat",
  readOnlyChat: "Read-only chat",
  online: "Online",
  generating: "Thinking…",
  voiceUnavailable: "Voice unavailable",
  voiceReady: "Voice ready — press to talk",
  voiceSpeaking: "Companion speaking…",
  you: "You",
  companion: "Companion",
  chatTranscript: "Chat transcript",
  emptyChatOpening: "A new journey with {{name}} begins here…",
  untitledChat: "New chat",
  // The Chat row's own last-activity stamp: two relative words and, beyond them,
  // the locale's own numeric date. Nothing invented, and nothing that reads as a
  // duration the Host never measured.
  chatRowToday: "Today",
  chatRowYesterday: "Yesterday",
  savedDraft: "Saved draft",
  unsavedDraft: "Unsaved draft",
  openingChat: "Opening chat…",
  gameState: "Game state",
  gameSetup: "Set up Stardew Valley",
  gameSetupFailed: "Game setup could not be verified. The latest authoritative game state is shown.",
  gameActivation: "Enable companion play",
  gameActivationInProgress: "Enabling companion play…",
  gameActivationFailed: "Companion play could not be enabled. The latest authoritative game state is shown.",
  gameActivationUnavailable: "This build cannot enable companion play. Update GameBuddy or reload the page.",
  gameActivationRequired: "Companion play is not ready yet. Enable companion play, then try again.",
  gameStop: "Stop game",
  gameStopFailed: "The game stop result is uncertain. The latest authoritative game state is shown.",
  gameDisconnect: "Disconnect game",
  gameDisconnectFailed: "The game could not be disconnected. Its attachment was retained.",
  gameResume: "Resume game",
  gameResumeInProgress: "Resuming the game connection...",
  gameResumeFailed: "The game could not be resumed. The latest authoritative game state is shown.",
  gameResumeUnavailable: "The game could not be resumed right now. Reload the page or try again later.",
  gameActionsPaused: "Game actions are paused.",
  gameReopen: "Resume actions",
  gameReopenInProgress: "Resuming game actions...",
  gameReopenFailed: "The game actions could not be resumed. The latest authoritative game state is shown.",
  gameReopenUnavailable: "The game actions could not be resumed right now. Reload the page or try again later.",
  gameRetry: "Retry",
  gameResumeCancel: "Cancel",
  gameResumeCancelInProgress: "Cancelling the reconnect...",
  gameResumeCancelFailed: "The reconnect could not be cancelled. The latest authoritative game state is shown.",
  gameCreate: "Start new game",
  gameCreateFormTitle: "Start a new game session",
  gameCreateIntegration: "Game integration",
  gameCreateContinuityBinding: "Continuity binding",
  gameCreateContinuityBindingHint:
    "Optional. Leave empty to create the session without binding it to your continuity identity.",
  gameCreateInProgress: "Creating the game session...",
  gameCreateFailed:
    "The game session could not be created. No partial session was left behind; the latest authoritative game state is shown.",
  gameCreateUnavailable: "The game session could not be created right now. Reload the page or try again.",
  gameSyncing: "Syncing the game connection...",
  gameLaunch: "Play with companion",
  gameLaunchFailed: "The game launch result is uncertain. The latest authoritative game state is shown.",
  stardewCabinSelection: "Stardew cabin selection",
  stardewCabinsLoading: "Loading available cabins…",
  stardewCabinsUnavailable:
    "The cabin list could not be read: the Host returned no cabin list. Reload the page and try again.",
  stardewCabinsAwaitingSession:
    "There is no game session to read cabins from yet. Finish steps 1 and 2 above: the cabins to confirm appear here once the companion moves in.",
  stardewCabinsEmpty: "No cabins are currently available.",
  stardewCabinConfirm: "Confirm cabin",
  stardewManifestAdmitted: "Cabin request admitted. Waiting for the next game setup step.",
  stardewCabinConfirmationUncertain:
    "Confirmation is still awaiting verification. Do not confirm again. Wait for recovery or reload the page to recover manually.",

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
  // The rename button's own affordance is `renameChat`; this names the FIELD that button opens,
  // so the affordance and the field it edits are two controls with two accessible names.
  renameChatTitleField: "Chat title",
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
  worldInfoLocked: "World Info binding is locked after this chat has messages.",

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
  // Whose memory a row is. Shown as a badge so a player can tell their own writing from what the
  // companion remembers, and can audit or correct either.
  originPlayer: "I told her this",
  originCompanion: "She remembers this",
  memoryChapters: "Her long story",
  memoryChaptersHint: "Stretches of your time together that she has already taken in. Hers to keep, yours to correct.",
  memoryChapterSealed: "She wrote this",
  memoryChapterEdited: "You corrected this",
  memoryChapterDeleted: "Removed",
  memoryChapterEdit: "Correct",
  memoryChapterRemove: "Remove",
  memoryChapterSave: "Save",
  memoryChapterCancel: "Cancel",
  // The Memory panel's origin filter. One chip, one dimension, and the two
  // origin chips reuse the row labels above: the filter never needs its own
  // vocabulary for the same split.
  memoryFilterAll: "All",

  // Composer
  typeMessagePlaceholder: "Type a message to your companion… (Enter to send, Shift+Enter for newline)",
  // The compact band's own hint: the composer's field is 212px wide at a 400px
  // viewport, where the sentence above needs three lines and names a key no phone
  // has. The compact wording keeps the invitation and drops the keystroke.
  typeMessagePlaceholderCompact: "Message your companion…",
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
  voiceSettings: "Voice settings",
  voiceDisclosure: "Assistant text may be sent to Xiaomi MiMo cloud TTS.",
  voiceConsent: "Cloud TTS consent",
  voiceConsentUndecided: "Not decided",
  voiceConsentAccepted: "Accepted",
  voiceConsentRevoked: "Revoked",
  voiceDisclosureVersion: "Disclosure version",
  // The disclosure version is null until a consent decision is made, and a bare
  // dash there reads as a value the surface failed to load. The row says the
  // honest state instead: nothing has been disclosed, because nobody decided yet.
  voiceDisclosureUndisclosed: "Not disclosed — no consent decision yet",
  voiceAccept: "Accept",
  voiceRevoke: "Revoke",
  voiceOutputDevice: "Output device",
  voiceDefaultOutput: "System default",
  voicePinnedOutputUnlisted: "Selected endpoint (not currently listed)",
  languageSettings: "Companion language",
  languageHint: "The language your companion speaks. It applies from the next time your companion starts.",
  languageChinese: "Chinese (Simplified)",
  languageEnglish: "English",
  languageCompanionField: "Companion language tag",
  languageCompanionPlaceholder: "For example zh-CN, en-US, ja-JP",
  languageUiField: "Interface language",
  languageUiHint: "The language of this management interface. It does not change what your companion speaks.",
  languageUnavailable: "The companion language preference is unavailable.",
  voiceSettingsUnavailable: "Voice settings are unavailable.",

  connectionSettings: "Connection and model",
  connectionActiveLabel: "Active connection",
  connectionNoneActive: "No connection selected",
  connectionNoSelectionNotice:
    "No connection has been selected. Until one is activated, the assistant keeps using the built-in default connection.",
  connectionActivationNotice:
    "Connection activated. It applies from your next conversation; one already in progress is not switched.",
  connectionProvider: "Provider",
  connectionRecommended: "recommended",
  connectionEscapeHatch: "OpenAI-compatible endpoint",
  connectionEscapeHatchHint: "Runs against a compatible server you supply, such as Ollama, LM Studio or vLLM.",
  connectionEnvironmentManaged: "Managed by the operator environment; it has no editable credential here.",
  connectionBaseUrl: "Base URL",
  connectionBaseUrlHint: "For example http://127.0.0.1:11434/v1",
  connectionApiShape: "API shape",
  connectionApiShapeHint:
    "Which API shape this endpoint speaks. Your server has to offer it: anything else is refused.",
  connectionApiKey: "API key",
  connectionApiKeyWriteOnly: "Write-only. It is stored for your companion and is never shown again.",
  connectionApiKeyLocalHint:
    "A local server that needs no key still needs some value here (for example `ollama`); the endpoint ignores it.",
  connectionModel: "Model",
  connectionModelId: "Model ID",
  connectionModelIdHint: "The model name the endpoint serves, for example qwen2.5-coder:7b",
  connectionThinkingLevel: "Thinking level",
  connectionReadiness: "Readiness",
  connectionReadinessUnconfigured: "Not configured",
  connectionReadinessConfigured: "Configured, not tested",
  connectionReadinessReady: "Ready",
  connectionReadinessFailed: "Test failed",
  connectionSave: "Save connection",
  connectionTest: "Test connection",
  connectionActivate: "Save and activate",
  connectionActivateRequiresReady: "Test the connection before activating it.",
  connectionRemove: "Remove",
  connectionRemoveActiveRefused: "An active connection cannot be removed. Activate another connection first.",
  connectionPending: "Working…",
  connectionFailureInvalidEndpoint: "This endpoint cannot be used.",
  connectionFailureNotConfigured: "No credential is available for this endpoint.",
  connectionFailureUnauthorized: "The endpoint rejected the credential.",
  connectionFailureNotFound: "The endpoint did not offer the selected model.",
  connectionFailureUnreachable: "The endpoint could not be reached.",
  connectionFailureTimeout: "The endpoint did not answer in time.",
  connectionFailureInvalidResponse: "The endpoint answered in an unexpected way.",
  connectionListTitle: "Saved connections",
  connectionBusy: "A reply is being generated. Activation is available once the turn finishes.",
  connectionRevisionConflict: "This connection changed elsewhere. Reopen the panel and try again.",
  connectionLevelLow: "Low",
  connectionLevelOff: "Off",
  connectionLevelMinimal: "Minimal",
  connectionLevelMedium: "Medium",
  connectionLevelHigh: "High",
  connectionLevelXHigh: "Extra high",
  connectionLevelMax: "Max",

  modelProfilesTitle: "Model profiles",
  modelProfilesHint:
    "The model each surface uses. You can type any model name your endpoint serves — the suggestions below are only a starting point.",
  modelProfilesChat: "Chat",
  modelProfilesGame: "Game companion",
  modelProfilesModelId: "Model ID",
  modelProfilesThinkingLevel: "Thinking level",
  modelProfilesRecommended: "Suggested models",
  modelProfilesApply: "Save",
  modelProfilesApplied: "Saved. It applies the next time that surface's runtime starts.",
  modelProfilesRevisionConflict: "This profile changed elsewhere. Reopen the panel and try again.",
  modelProfilesUnavailable: "Model profiles are unavailable.",
  modelProfilesModelRequired: "Enter a model ID.",
  chatModelSettings: "Chat model settings",
  // The companion's message affordances (design/26 §6.3: one declared icon family,
  // never an emoji standing in for a structural control).
  swipeNavigation: "Message variants",
  swipePrevious: "Previous variant",
  swipeNext: "Next variant",
  regenerateVariant: "Regenerate",
  // The Host's own name for the greeting variant a new chat opened on: it labels
  // the greeting set's entries `Default` / `Alternate N` (the card's own 1-based
  // order). The catalogue carries that vocabulary so a zh-CN UI never prints the
  // Host's English literal. `{{index}}` is the card's own order, not the set
  // position the indicator already shows beside it.
  openingVariantDefault: "Default",
  openingVariantAlternate: "Alternate {{index}}",

  problemBootstrapUnavailableTitle: "Unable to open chat",
  problemBootstrapUnavailableDetail: "The bootstrap handoff is unavailable.",
  problemTemporarilyUnavailableTitle: "Unable to read chat",
  problemTemporarilyUnavailableDetail: "The chat state is temporarily unavailable.",
  problemReconciliationFailedTitle: "Unable to read chat",
  problemReconciliationFailedDetail: "The chat state could not be safely reconciled.",
  problemSessionExpiredTitle: "Your session ended",
  problemSessionExpiredDetail:
    "Your GameBuddy session is gone, so there is nothing to read. Start GameBuddy again and reload the page it opens.",
  problemRouteUnavailableTitle: "Unable to reach chat",
  problemRouteUnavailableDetail:
    "This GameBuddy build does not serve the route the page asked for. Update GameBuddy or reload the page.",
  problemInternalErrorTitle: "Unable to read chat",
  problemInternalErrorDetail: "GameBuddy reported an internal error (code {{code}}).",
  problemInternalErrorCauseDetail: "GameBuddy reported an internal error (code {{code}}; cause {{cause}}).",
  problemInternalErrorNoCode: "none reported",

  // Characters (design/28 §2) — companion library + persona/scenario/greeting
  charactersTitle: "Characters",
  charactersUnavailable: "Character management is unavailable in this profile.",
  companionListTitle: "Companions",
  companionListEmpty: "No companions yet.",
  companionCurrent: "current",
  companionCreateTitle: "New companion",
  companionCreateHint: "A display name only; GameBuddy mints every identity.",
  companionCreateSubmit: "Create companion",
  companionDetailTitle: "Companion details",
  companionDetailName: "Name",
  personaEditTitle: "Your Persona",
  personaEditHint: "How you want the companion to see you.",
  personaPresentHint: "Present",
  personaNotPresent: "No persona saved yet.",
  personaSave: "Save Persona",
  scenarioEditTitle: "Scenario",
  scenarioEditHint: "The setting the companion assumes.",
  scenarioNotPresent: "No scenario saved yet.",
  scenarioSave: "Save Scenario",
  greetingEditTitle: "Greeting",
  greetingEditHint: "Opening lines the companion can say.",
  greetingNotPresent: "No greeting saved yet.",
  greetingSave: "Save Greeting",
  greetingVariantLabel: "Variant label",
  greetingVariantText: "Variant text",
  greetingAddVariant: "Add variant",
  authoredContentSaving: "Saving…",
  authoredContentSaved: "Saved.",
  authoredContentError: "Could not save. The content changed elsewhere; reload and retry.",
  chatRetentionArchive: "Archive",
  chatRetentionRestore: "Restore",
  chatRetentionTrash: "Trash",
  chatRetentionFailed: "The chat lifecycle could not be changed.",
  cardImportTitle: "Import card",
  cardImportHint:
    "Paste a character card (SillyTavern V2/V3 JSON). You review what is included before it becomes a companion.",
  cardImportStage: "Review card",
  cardImportStaging: "Reviewing…",
  cardImportFieldsTitle: "Included fields",
  cardImportDispositionsTitle: "Not included",
  cardImportReviewSelectionTitle: "Review before creating",
  cardImportReviewSelected: "Confirm & create companion",
  cardImportConfirming: "Creating…",
  cardImportCreated: "Imported companion created.",
  cardImportError: "The card could not be imported. Paste a valid character card and try again.",
  cardImportLongHint: "This description is long ({{chars}} chars); it may raise per-turn token use.",
  cardImportHistoryTitle: "Import history",
  cardImportHistoryHint: "Every confirmed import and what it kept or dropped, by class.",
  cardImportHistoryEmpty: "No confirmed imports yet.",
  cardImportHistoryFailed: "The import history could not be read.",

  // Shell (design/104 §2): brand mark, single contextual drawer, panel groups.
  appMark: "GB",
  chatPanel: "Chat",
  gamePanel: "Game",
  chatsPanel: "Chats",
  charactersPanel: "Characters",
  settingsPanel: "Settings",
  memoryPanel: "Memory",
  loading: "Loading...",
  chatsEmpty: "No chats yet.",
  untitled: "Untitled",
  memoryEmpty: "No memories yet.",
  selected: "Selected",
  voiceAccepted: "Accepted",
  voiceRevoked: "Revoked",
  voiceUndecided: "Undecided",
  gameStateUnavailable: "Game state is unavailable for this profile.",
  gameGroupConnection: "Connection",
  gameGroupNextStep: "Next step",
  gameGroupSession: "Session",
  gameGroupRecovery: "Recovery",

  // Game facts. Every value is a localized player outcome; the raw Host enum
  // (`connected_idle`, `state_unavailable`, ...) is never rendered (design/104 §10).
  gameFactConnection: "Connection",
  gameFactInstance: "Instance",
  gameFactWorld: "World",
  gameFactSave: "Save",
  gameFactCompatibility: "Compatibility",
  gameFactCapabilities: "Capabilities",
  gameFactExecution: "Execution",
  gameFactOutcome: "Last result",
  gameValueNone: "None",
  gameCapabilityCount: "{{count}} available",
  gameCapabilitiesUnavailable: "Not published",

  gameConnectionNone: "No game connection",
  gameConnectionDiscovering: "Looking for your game…",
  gameConnectionLaunchPending: "Starting your game…",
  gameConnectionAttachPending: "Connecting your companion…",
  gameConnectionCompatibilityWarning: "This game version needs attention",
  gameConnectionAwaitingConfirmation: "Waiting for your confirmation",
  gameConnectionConnecting: "Connecting your companion…",
  gameConnectionConnectedIdle: "Connected",
  gameConnectionActive: "Connected, companion playing",
  gameConnectionStopping: "Stopping…",
  gameConnectionReconnecting: "Reconnecting…",
  gameConnectionSyncing: "Syncing…",
  gameConnectionStopped: "Stopped",
  gameConnectionFailed: "Connection failed",
  gameConnectionDisconnected: "Disconnected",

  gameInstanceNone: "Not running",
  gameInstanceDetected: "Found, not started",
  gameInstanceLaunching: "Starting…",
  gameInstanceRunning: "Running",
  gameInstanceStopped: "Stopped",
  gameInstanceCrashed: "Stopped unexpectedly",

  gameCompatibilityUnchecked: "Not checked yet",
  gameCompatibilityCompatible: "Compatible",
  gameCompatibilityIncompatible: "Not compatible",
  gameCompatibilityWarning: "Needs attention",

  gameAuthorityUnavailable: "Not available",
  gameAuthorityActive: "Companion can act",
  gameAuthorityPaused: "Paused",

  gameOutcomeNone: "No activity yet",
  gameOutcomeSucceeded: "Completed successfully",
  gameOutcomeFailed: "Did not complete",
  gameOutcomeCancelled: "Stopped by you",

  // Installation discovery (design/104 §5.1). The panel's `data-state` stays the
  // typed state for the tests; the text a player reads is one of these.
  gameInstallationAria: "Game installation setup",
  gameInstallationTitle: "Game installation",
  gameInstallationNotConfigured: "GameBuddy needs to find your Stardew Valley installation.",
  gameInstallationLoading: "Looking for your Stardew Valley installation…",
  gameInstallationCandidates: "We found possible installations. Choose one to connect.",
  gameInstallationConfirming: "Confirming the installation…",
  gameInstallationRetrying: "Searching again…",
  gameInstallationCancelled: "Search cancelled.",
  gameInstallationSourceUnavailable: "The installation search is unavailable right now.",
  gameInstallationNoCandidates: "No Stardew Valley installation was found.",
  gameInstallationExpired: "These search results expired. Search again.",
  gameInstallationError: "The installation search failed.",
  gameInstallationConfirm: "Confirm",
  gameInstallationChooseFolder: "Choose game folder",
  gameInstallationFindAgain: "Find again",

  // Game data disclosure. The dump is what the composed state route publishes
  // (`game.state.read`); the contract's separate `game.instances.read` and
  // `game.diagnostics.read` commands have no route on this shell, so the
  // diagnostics half says exactly that rather than showing an empty box.
  gameDiagnostics: "Game data and diagnostics",
  gameDiagnosticsPublished: "Published by the Host, read-only: the instance and session projection.",
  gameDiagnosticsNoChannel: "No diagnostics are published on this route.",
  gameDiagnosticsJson: "Instance and session projection, as published",
  gameDiagnosticsUnavailable: "No game data is published for this profile, so there is nothing to show.",
  // The one control that holds the app bar's trailing peers on a 400 px strip.
  appBarMore: "More",

  // The companion capability board and the three-step start guide.
  //
  // The board is derived from the capability surface the composed game
  // projection actually publishes (`capabilitySummary`, `role`/`companionName`,
  // `actionAuthority`); it is never a hand-written list of abilities. Every
  // sentence here is player language for one published fact, so a raw enum, an
  // operation id or an ability id is never rendered (design/104 §10).
  gameBoardTitle: "What you can do together",
  gameBoardPublishedLead: "The game reports {{count}} things your companion can do with you.",
  gameBoardUnpublishedLead: "This session has not published what your companion can do with you yet.",
  gameBoardWaiting:
    "The companion's abilities come from the game itself. They appear here once the game reports them for the farm you are playing.",
  gameBoardCompanionTitle: "Your companion",
  gameBoardCompanionPresent: "{{name}} is with you in the farm.",
  gameBoardCompanionAbsent: "No companion has taken a cabin in your farm yet.",
  gameBoardAbilitiesPublished: "{{count}} things published",
  gameBoardAbilitiesUnpublished: "Nothing published yet",
  gameBoardAbilitiesPublishedDetail: "These are the abilities the game itself reported for this session.",
  gameBoardAbilitiesUnpublishedDetail: "The game has not reported any ability for this session.",
  gameBoardActingActive: "Your companion may act in your farm.",
  gameBoardActingPaused: "Your companion waits for your word before acting.",
  gameBoardActingUnavailable: "Your companion has no way into your farm yet.",
  gameStartGuide: "Getting started together",
  gameGuideStepOneTitle: "Start Stardew",
  gameGuideStepOneDetail: "Prepare Stardew and the companion mod.",
  gameGuideStepTwoTitle: "Load your farm",
  gameGuideStepTwoDetail: "Start the game with your companion, then load the farm you want to play.",
  gameGuideStepThreeTitle: "Your companion moves in",
  gameGuideStepThreeDetail: "Choose the cabin your companion settles into.",
  /* The advanced configuration block (design/104 §3). This is player copy, so it names no
     upstream tool, no file of another product and no route: it says which settings live in the
     file, what the file is for the player, and - because this screen cannot change it -
     that there is nothing to edit here. `advancedPiSettings*` are the key names, not the copy. */
  advancedPiSettingsTitle: "Advanced configuration",
  advancedPiSettingsHint:
    "Edit the full settings file directly: each entry under `providers` is one connection your companion reads (baseUrl, api, apiKey, models, …).",
  advancedPiSettingsSave: "Save advanced configuration",
  advancedPiSettingsApplied: "Saved. It is read the next time your companion starts.",
  advancedPiSettingsNoRoute:
    "Your companion's model and connection settings live in one settings file. The provider, model and key you set above are written into it along with everything else, and this screen cannot change that file - so there is nothing to edit here.",
  advancedPiSettingsInvalidJson:
    "This is not valid JSON. Check brackets, commas and quotes and try again. Nothing was written.",
  advancedPiSettingsInvalidShape:
    "This is not the settings file: the only top-level key is providers, and each provider entry must be an object. Nothing was written.",

  // --- endgame lane: the one deliberate complete-game-termination control ----
  // The terminal operation is set apart from Stop/Disconnect: it reads as its
  // own block, and its wording must not promise reversibility it does not have.
  gameEndgame: "End the game",
  gameEndgameConfirm: "This ends and permanently closes the player's game world. This cannot be undone. Continue?",
  gameEndgameConfirmYes: "End the game",
  gameEndgameConfirmNo: "Keep playing",
  gameEndgameInProgress: "Ending the game...",
  gameEndgameFailed: "The game could not be ended. The latest authoritative game state is shown.",

  // --- chat selection lane: switching the mounted Chat is turn-level ---
  chatSelectSwitchedNotice: "Chat switched.",

  // --- optimistic send lane: the sent text is visible before the Host answers ---
  chatSending: "Sending...",

  // --- class A/B action split lane (appended): a focus transfer aborts, a state change waits ---
  // The transient acknowledgement while a Chat switch is in flight. The row stays enabled, so this
  // says the request is out rather than that the switch was refused.
  chatSelectSwitching: "Switching...",
  // The fail-closed answer: the mounted turn could not be aborted, so the runtime deliberately stays
  // where it is instead of being torn down under that turn. The selection itself is recorded.
  chatSelectTurnNotAbortable:
    "The switch is recorded, but this conversation still has a turn that cannot be interrupted, so the runtime stayed where it is.",

  // --- ruling-and-ui-defects lane block (U-05): a row's destructive action is a
  // deliberate one. Same shape as the endgame block below it in the product: the
  // first click arms, only the confirm button sends, and the cancel keeps the
  // current state. The words state the consequence and never promise
  // reversibility the action does not have.
  chatRetentionArchiveConfirm: "Archive this chat? It leaves the active list and can be restored later. Continue?",
  chatRetentionArchiveConfirmYes: "Archive",
  chatRetentionTrashConfirm:
    "Move this chat to the trash? It leaves the active list and can be restored later. Continue?",
  chatRetentionTrashConfirmYes: "Move to trash",
  chatRetentionConfirmNo: "Keep the chat",
} as const;

type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

const zh: Messages = {
  appName: "GameBuddy",
  skipToChat: "跳至聊天内容",
  readOnlyChat: "只读会话",
  online: "在线",
  generating: "思考中…",
  voiceUnavailable: "语音不可用",
  voiceReady: "语音就绪 — 可按键说话",
  voiceSpeaking: "角色正在说话…",
  you: "你",
  companion: "角色",
  chatTranscript: "聊天记录",
  emptyChatOpening: "与 {{name}} 开启一段新的旅程…",
  untitledChat: "新对话",
  chatRowToday: "今天",
  chatRowYesterday: "昨天",
  savedDraft: "已保存草稿",
  unsavedDraft: "未保存草稿",
  openingChat: "正在读取聊天…",
  gameState: "游戏状态",
  gameSetup: "设置《星露谷物语》",
  gameSetupFailed: "无法验证游戏设置结果；当前显示的是最新权威游戏状态。",
  gameActivation: "启用伙伴陪玩",
  gameActivationInProgress: "正在启用伙伴陪玩…",
  gameActivationFailed: "无法启用伙伴陪玩；当前显示的是最新权威游戏状态。",
  gameActivationUnavailable: "当前版本无法启用伙伴陪玩。请更新 GameBuddy 或重新加载页面。",
  gameActivationRequired: "伙伴陪玩尚未准备完成。请先启用伙伴陪玩，然后重试。",
  gameStop: "停止游戏",
  gameStopFailed: "游戏停止结果尚不确定；当前显示的是最新权威游戏状态。",
  gameDisconnect: "断开游戏连接",
  gameDisconnectFailed: "无法断开游戏连接；当前连接已保留。",
  gameResume: "恢复游戏连接",
  gameResumeInProgress: "正在恢复游戏连接...",
  gameResumeFailed: "无法恢复游戏连接;当前显示的是最新权威游戏状态。",
  gameResumeUnavailable: "目前无法恢复游戏连接。请重新加载页面,或稍后重试。",
  gameActionsPaused: "游戏行动已暂停。",
  gameReopen: "恢复行动",
  gameReopenInProgress: "正在恢复游戏行动...",
  gameReopenFailed: "无法恢复游戏行动;当前显示的是最新权威游戏状态。",
  gameReopenUnavailable: "目前无法恢复游戏行动。请重新加载页面,或稍后重试。",
  gameRetry: "重试",
  gameResumeCancel: "取消",
  gameResumeCancelInProgress: "正在取消重新连接...",
  gameResumeCancelFailed: "无法取消重新连接；当前显示的是最新权威游戏状态。",
  gameCreate: "开始新游戏",
  gameCreateFormTitle: "开始新游戏会话",
  gameCreateIntegration: "游戏集成",
  gameCreateContinuityBinding: "连续性绑定",
  gameCreateContinuityBindingHint: "可选。留空表示创建不绑定连续性身份的会话。",
  gameCreateInProgress: "正在创建游戏会话...",
  gameCreateFailed: "无法创建游戏会话；未留下任何可恢复的部分会话，当前显示的是最新权威游戏状态。",
  gameCreateUnavailable: "目前无法创建游戏会话。请重新加载页面，或稍后重试。",
  gameSyncing: "正在同步游戏连接...",
  gameLaunch: "与伙伴一起玩",
  gameLaunchFailed: "游戏启动结果不确定；当前显示的是最新权威游戏状态。",
  stardewCabinSelection: "星露谷小屋选择",
  stardewCabinsLoading: "正在读取可用小屋…",
  stardewCabinsUnavailable: "无法读取小屋选项：Host 没有返回小屋列表。请重新加载页面后再试。",
  stardewCabinsAwaitingSession:
    "还没有可以读取小屋的游戏会话。先完成上面第 1、2 步；伴侣住进农舍后，可确认的小屋会出现在这里。",
  stardewCabinsEmpty: "当前没有可用小屋。",
  stardewCabinConfirm: "确认小屋",
  stardewManifestAdmitted: "小屋请求已接纳，正在等待下一步游戏设置。",
  stardewCabinConfirmationUncertain: "确认结果仍在等待验证。请勿再次确认；等待恢复，或重新加载页面进行手动恢复。",

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
  renameChatTitleField: "会话标题",
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
  worldInfoLocked: "当前对话已有消息，世界书绑定已锁定。",

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
  originPlayer: "我告诉她的",
  originCompanion: "她自己记得的",
  memoryChapters: "她记得的长故事",
  memoryChaptersHint: "你们一起经历过的段落，她已经记下了。她留着，你可以改。",
  memoryChapterSealed: "她写的",
  memoryChapterEdited: "你改过的",
  memoryChapterDeleted: "已移除",
  memoryChapterEdit: "修改",
  memoryChapterRemove: "移除",
  memoryChapterSave: "保存",
  memoryChapterCancel: "取消",
  memoryFilterAll: "全部",

  // Composer
  typeMessagePlaceholder: "给伴侣发送消息… (Enter 发送, Shift+Enter 换行)",
  // 紧凑布局的提示：见英文目录同名字段的说明。
  typeMessagePlaceholderCompact: "给伴侣发送消息…",
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
  voiceSettings: "语音设置",
  voiceDisclosure: "助手文本可能会发送到 Xiaomi MiMo 云端 TTS。",
  voiceConsent: "云端 TTS 授权",
  voiceConsentUndecided: "未决定",
  voiceConsentAccepted: "已接受",
  voiceConsentRevoked: "已撤销",
  voiceDisclosureVersion: "披露版本",
  voiceDisclosureUndisclosed: "尚未披露——尚未做出授权决定",
  voiceAccept: "接受",
  voiceRevoke: "撤销",
  voiceOutputDevice: "输出设备",
  voiceDefaultOutput: "系统默认",
  voicePinnedOutputUnlisted: "已选端点（当前未列出）",
  languageSettings: "伴侣语言",
  languageHint: "伴侣说话使用的语言，下次伴侣启动时生效。",
  languageChinese: "简体中文",
  languageEnglish: "English",
  languageCompanionField: "伴侣语言标签",
  languageCompanionPlaceholder: "例如 zh-CN、en-US、ja-JP",
  languageUiField: "界面语言",
  languageUiHint: "本管理界面使用的语言，不会改变伴侣说话的语言。",
  languageUnavailable: "伴侣语言偏好不可用。",
  voiceSettingsUnavailable: "语音设置不可用。",

  connectionSettings: "连接与模型",
  connectionActiveLabel: "当前连接",
  connectionNoneActive: "未选择连接",
  connectionNoSelectionNotice: "尚未选择连接。在启用之前，助手继续使用内置默认连接。",
  connectionActivationNotice: "连接已启用。从下次开始对话时生效；正在进行的会话不会被切换。",
  connectionProvider: "渠道",
  connectionRecommended: "推荐",
  connectionEscapeHatch: "OpenAI 兼容端点",
  connectionEscapeHatchHint: "连接到你自己提供的兼容服务器，例如 Ollama、LM Studio 或 vLLM。",
  connectionEnvironmentManaged: "由运行环境管理，此处没有可编辑的凭据。",
  connectionBaseUrl: "Base URL",
  connectionBaseUrlHint: "例如 http://127.0.0.1:11434/v1",
  connectionApiShape: "API 协议",
  connectionApiShapeHint: "该端点使用的接口协议。必须与你的服务端实际提供的协议一致，否则会被拒绝。",
  connectionApiKey: "API Key",
  connectionApiKeyWriteOnly: "只写：它保存给你的伙伴使用，之后不会再回显。",
  connectionApiKeyLocalHint: "不需要密钥的本地服务也需要在这里填一个占位值（例如 `ollama`），该端点会忽略它。",
  connectionModel: "模型",
  connectionModelId: "模型 ID",
  connectionModelIdHint: "该端点提供的模型名，例如 qwen2.5-coder:7b",
  connectionThinkingLevel: "思考强度",
  connectionReadiness: "状态",
  connectionReadinessUnconfigured: "未配置",
  connectionReadinessConfigured: "已配置，未测试",
  connectionReadinessReady: "可用",
  connectionReadinessFailed: "测试失败",
  connectionSave: "保存连接",
  connectionTest: "测试连接",
  connectionActivate: "保存并启用",
  connectionActivateRequiresReady: "请先测试连接，再启用它。",
  connectionRemove: "删除",
  connectionRemoveActiveRefused: "当前启用的连接不能删除。请先启用另一个连接。",
  connectionPending: "处理中…",
  connectionFailureInvalidEndpoint: "该端点不可用。",
  connectionFailureNotConfigured: "该端点没有可用的凭据。",
  connectionFailureUnauthorized: "端点拒绝了该凭据。",
  connectionFailureNotFound: "端点没有提供所选模型。",
  connectionFailureUnreachable: "无法连接到该端点。",
  connectionFailureTimeout: "端点未及时响应。",
  connectionFailureInvalidResponse: "端点的响应无法识别。",
  connectionListTitle: "已保存的连接",
  connectionBusy: "正在生成回复。本轮结束后才能启用连接。",
  connectionRevisionConflict: "该连接已在其它地方被修改，请重新打开面板后再试。",
  connectionLevelLow: "低",
  connectionLevelOff: "关闭",
  connectionLevelMinimal: "最低",
  connectionLevelMedium: "中",
  connectionLevelHigh: "高",
  connectionLevelXHigh: "极高",
  connectionLevelMax: "最大",

  modelProfilesTitle: "模型配置",
  modelProfilesHint: "每个界面使用的模型。可以直接填写端点提供的任何模型名；下面的建议只是起点。",
  modelProfilesChat: "聊天",
  modelProfilesGame: "游戏陪玩",
  modelProfilesModelId: "模型 ID",
  modelProfilesThinkingLevel: "思考强度",
  modelProfilesRecommended: "建议模型",
  modelProfilesApply: "保存",
  modelProfilesApplied: "已保存。将在该界面下次启动运行时生效。",
  modelProfilesRevisionConflict: "该配置已在其它地方被修改，请重新打开面板后再试。",
  modelProfilesUnavailable: "模型配置不可用。",
  modelProfilesModelRequired: "请填写模型 ID。",
  chatModelSettings: "聊天模型配置",
  // 伴侣消息上的控件(design/26 §6.3:只用一套已声明的图标族,不用 emoji 冒充结构控件)。
  swipeNavigation: "消息变体",
  swipePrevious: "上一个变体",
  swipeNext: "下一个变体",
  regenerateVariant: "重新生成",
  openingVariantDefault: "默认",
  openingVariantAlternate: "备用 {{index}}",

  problemBootstrapUnavailableTitle: "无法打开聊天",
  problemBootstrapUnavailableDetail: "Bootstrap 令牌不可用。",
  problemTemporarilyUnavailableTitle: "无法读取聊天",
  problemTemporarilyUnavailableDetail: "聊天状态暂时不可用。",
  problemReconciliationFailedTitle: "无法读取聊天",
  problemReconciliationFailedDetail: "聊天状态未能安全对齐。",
  problemSessionExpiredTitle: "会话已失效",
  problemSessionExpiredDetail:
    "你的 GameBuddy 会话已失效，因此没有可读取的内容。请重新启动 GameBuddy，并重新加载它打开的页面。",
  problemRouteUnavailableTitle: "无法访问聊天",
  problemRouteUnavailableDetail: "当前 GameBuddy 版本不提供该页面请求的路由。请更新 GameBuddy，或重新加载页面。",
  problemInternalErrorTitle: "无法读取聊天",
  problemInternalErrorDetail: "GameBuddy 报告了内部错误（代码 {{code}}）。",
  problemInternalErrorCauseDetail: "GameBuddy 报告了内部错误（代码 {{code}}；原因 {{cause}}）。",
  problemInternalErrorNoCode: "未报告任何代码",

  // Characters (design/28 §2)
  charactersTitle: "角色",
  charactersUnavailable: "当前配置不支持角色管理。",
  companionListTitle: "伙伴列表",
  companionListEmpty: "还没有伙伴。",
  companionCurrent: "当前",
  companionCreateTitle: "新建伙伴",
  companionCreateHint: "只需填写显示名称；所有身份由 GameBuddy 铸造。",
  companionCreateSubmit: "创建伙伴",
  companionDetailTitle: "伙伴详情",
  companionDetailName: "名称",
  personaEditTitle: "你的用户设定",
  personaEditHint: "你希望伙伴如何认识你。",
  personaPresentHint: "已设置",
  personaNotPresent: "还没有保存用户设定。",
  personaSave: "保存用户设定",
  scenarioEditTitle: "场景",
  scenarioEditHint: "伙伴所假设的情境。",
  scenarioNotPresent: "还没有保存场景。",
  scenarioSave: "保存场景",
  greetingEditTitle: "开场白",
  greetingEditHint: "伙伴可以说的开场白。",
  greetingNotPresent: "还没有保存开场白。",
  greetingSave: "保存开场白",
  greetingVariantLabel: "变体标签",
  greetingVariantText: "变体文本",
  greetingAddVariant: "添加变体",
  authoredContentSaving: "保存中…",
  authoredContentSaved: "已保存。",
  authoredContentError: "无法保存。内容已在其他位置更改；请重新加载后再试。",
  chatRetentionArchive: "归档",
  chatRetentionRestore: "恢复",
  chatRetentionTrash: "删除",
  chatRetentionFailed: "无法更改聊天生命周期。",
  cardImportTitle: "导入角色卡",
  cardImportHint: "粘贴角色卡（SillyTavern V2/V3 JSON）。它会先经过审查，确认包含哪些内容后才会成为同伴。",
  cardImportStage: "审查卡片",
  cardImportStaging: "审查中…",
  cardImportFieldsTitle: "将包含的内容",
  cardImportDispositionsTitle: "未包含的内容",
  cardImportReviewSelectionTitle: "创建前确认",
  cardImportReviewSelected: "确认并创建同伴",
  cardImportConfirming: "创建中…",
  cardImportCreated: "已导入并创建同伴。",
  cardImportError: "无法导入该卡片。请粘贴有效角色卡后重试。",
  cardImportLongHint: "该描述较长（{{chars}} 字符），可能会增加每轮 Token 消耗。",
  cardImportHistoryTitle: "导入历史",
  cardImportHistoryHint: "每次已确认的导入，以及按类别保留或丢弃的内容。",
  cardImportHistoryEmpty: "暂无已确认的导入。",
  cardImportHistoryFailed: "无法读取导入历史。",

  // 外壳（design/104 §2）：品牌标记、唯一上下文抽屉、面板分组。
  appMark: "GB",
  chatPanel: "聊天",
  gamePanel: "游戏",
  chatsPanel: "会话",
  charactersPanel: "角色",
  settingsPanel: "设置",
  memoryPanel: "记忆",
  loading: "加载中...",
  chatsEmpty: "还没有聊天。",
  untitled: "未命名",
  memoryEmpty: "还没有记忆。",
  selected: "已选择",
  voiceAccepted: "已接受",
  voiceRevoked: "已撤销",
  voiceUndecided: "未决定",
  gameStateUnavailable: "当前配置下没有游戏状态。",
  gameGroupConnection: "连接",
  gameGroupNextStep: "下一步",
  gameGroupSession: "当前会话",
  gameGroupRecovery: "恢复",

  // 游戏事实。每个取值都是本地化的玩家结果，绝不显示 Host 原始枚举
  // （`connected_idle`、`state_unavailable` 等，design/104 §10）。
  gameFactConnection: "连接",
  gameFactInstance: "实例",
  gameFactWorld: "世界",
  gameFactSave: "存档",
  gameFactCompatibility: "兼容性",
  gameFactCapabilities: "可用能力",
  gameFactExecution: "执行",
  gameFactOutcome: "最近结果",
  gameValueNone: "无",
  gameCapabilityCount: "{{count}} 项可用",
  gameCapabilitiesUnavailable: "未发布",

  gameConnectionNone: "尚未连接游戏",
  gameConnectionDiscovering: "正在查找你的游戏…",
  gameConnectionLaunchPending: "正在启动游戏…",
  gameConnectionAttachPending: "正在连接伙伴…",
  gameConnectionCompatibilityWarning: "该游戏版本需要留意",
  gameConnectionAwaitingConfirmation: "等待你的确认",
  gameConnectionConnecting: "正在连接伙伴…",
  gameConnectionConnectedIdle: "已连接",
  gameConnectionActive: "已连接，伙伴正在游戏",
  gameConnectionStopping: "正在停止…",
  gameConnectionReconnecting: "正在重新连接…",
  gameConnectionSyncing: "正在同步…",
  gameConnectionStopped: "已停止",
  gameConnectionFailed: "连接失败",
  gameConnectionDisconnected: "已断开连接",

  gameInstanceNone: "未运行",
  gameInstanceDetected: "已发现，未启动",
  gameInstanceLaunching: "正在启动…",
  gameInstanceRunning: "运行中",
  gameInstanceStopped: "已停止",
  gameInstanceCrashed: "意外退出",

  gameCompatibilityUnchecked: "尚未检查",
  gameCompatibilityCompatible: "兼容",
  gameCompatibilityIncompatible: "不兼容",
  gameCompatibilityWarning: "需要留意",

  gameAuthorityUnavailable: "尚未提供",
  gameAuthorityActive: "伙伴可以行动",
  gameAuthorityPaused: "已暂停",

  gameOutcomeNone: "尚无执行记录",
  gameOutcomeSucceeded: "已成功完成",
  gameOutcomeFailed: "未完成",
  gameOutcomeCancelled: "已由你停止",

  // 游戏安装发现（design/104 §5.1）。面板的 `data-state` 仍保留类型化状态供测试使用，
  // 玩家看到的文字来自这里。
  gameInstallationAria: "游戏安装设置",
  gameInstallationTitle: "游戏安装",
  gameInstallationNotConfigured: "GameBuddy 需要找到你的《星露谷物语》安装位置。",
  gameInstallationLoading: "正在查找《星露谷物语》安装位置…",
  gameInstallationCandidates: "已找到可能的安装位置，请选择一个进行连接。",
  gameInstallationConfirming: "正在确认安装位置…",
  gameInstallationRetrying: "正在重新搜索…",
  gameInstallationCancelled: "搜索已取消。",
  gameInstallationSourceUnavailable: "目前无法搜索游戏安装位置。",
  gameInstallationNoCandidates: "未找到《星露谷物语》安装位置。",
  gameInstallationExpired: "搜索结果已过期，请重新搜索。",
  gameInstallationError: "搜索游戏安装位置失败。",
  gameInstallationConfirm: "确认",
  gameInstallationChooseFolder: "选择游戏文件夹",
  gameInstallationFindAgain: "重新查找",

  gameDiagnostics: "游戏数据与诊断",
  gameDiagnosticsPublished: "由 Host 发布，只读：实例与会话投影。",
  gameDiagnosticsNoChannel: "此路由未发布诊断信息。",
  gameDiagnosticsJson: "按发布内容呈现的实例与会话投影",
  gameDiagnosticsUnavailable: "该档案未发布游戏数据，因此没有可显示的内容。",
  appBarMore: "更多",

  // 伴玩能力台与三步起步指引。能力台由游戏投影真正发布的能力面推导而来
  // （`capabilitySummary`、`role`/`companionName`、`actionAuthority`），
  // 绝不是手写的能力清单：每句话都是某一个已发布事实的玩家语言，
  // 因此原始枚举、操作 id 或能力 id 永远不会出现在界面上（design/104 §10）。
  gameBoardTitle: "和同伴一起能做的事",
  gameBoardPublishedLead: "游戏公布了 {{count}} 件同伴可以和你一起做的事。",
  gameBoardUnpublishedLead: "这次会话还没有公布同伴可以和你一起做的事。",
  gameBoardWaiting: "同伴能做的事由游戏本身决定。游戏为你正在玩的农场报上来之后，它们会出现在这里。",
  gameBoardCompanionTitle: "你的同伴",
  gameBoardCompanionPresent: "{{name}} 已经在农场里陪你。",
  gameBoardCompanionAbsent: "农场里还没有同伴住进农舍。",
  gameBoardAbilitiesPublished: "已公布 {{count}} 件事",
  gameBoardAbilitiesUnpublished: "还没有公布",
  gameBoardAbilitiesPublishedDetail: "这些是游戏为这次会话报上来的能力。",
  gameBoardAbilitiesUnpublishedDetail: "游戏还没有为这次会话报上能力。",
  gameBoardActingActive: "同伴可以在你的农场里动手。",
  gameBoardActingPaused: "同伴会先等你发话再动手。",
  gameBoardActingUnavailable: "同伴还没有接到你的农场。",
  gameStartGuide: "怎么开始",
  gameGuideStepOneTitle: "启动星露谷",
  gameGuideStepOneDetail: "先把星露谷和同伴模组准备好。",
  gameGuideStepTwoTitle: "载入你的农场",
  gameGuideStepTwoDetail: "和伙伴一起启动游戏，然后载入你想玩的农场。",
  gameGuideStepThreeTitle: "同伴住进农舍",
  gameGuideStepThreeDetail: "选一间农舍，同伴就住进去。",
  // 高级配置：这里是玩家可见文案，不出现上游工具名、他人的文件名或路由；
  // 只说清楚这些设置存在文件里、本页面不能改，以及因此没有可编辑的内容。
  advancedPiSettingsTitle: "高级配置",
  advancedPiSettingsHint:
    "直接编辑完整设置文件：`providers` 下每个条目就是伙伴读取的一条连接（baseUrl、api、apiKey、models 等）。",
  advancedPiSettingsSave: "保存高级配置",
  advancedPiSettingsApplied: "已保存。将在伙伴下次启动时读取。",
  advancedPiSettingsNoRoute:
    "伙伴的模型与连接设置保存在同一个设置文件里：你在上方设置的服务商、模型和密钥，会和其他设置一起写进这个文件。本页面无法修改该文件，所以这里没有可编辑的内容。",
  advancedPiSettingsInvalidJson: "这不是合法的 JSON：请检查括号、逗号和引号后重试。未写入任何内容。",
  advancedPiSettingsInvalidShape:
    "这不是合法的设置文件：顶层只能有 providers，且每个 provider 条目必须是对象。未写入任何内容。",

  // --- 终局操作 lane：唯一会彻底结束游戏世界的刻意控件 ---
  gameEndgame: "结束游戏",
  gameEndgameConfirm: "这会终止并永久关闭玩家的游戏世界，且无法撤销。确定继续吗？",
  gameEndgameConfirmYes: "结束游戏",
  gameEndgameConfirmNo: "继续游玩",
  gameEndgameInProgress: "正在结束游戏...",
  gameEndgameFailed: "无法结束游戏；当前显示的是最新权威游戏状态。",

  // --- 会话选择 lane：挂载会话的切换是 turn 级的 ---
  chatSelectSwitchedNotice: "已切换会话。",

  // --- 乐观发送 lane：在 Host 回应前先显示已发送文本 ---
  chatSending: "发送中...",

  // --- Class A/B 动作分层 lane（追加）：焦点转移会中止，状态变更等待 ---
  // 切换会话进行中的临时提示：该行仍可点击，所以它表示请求已发出，而不是切换被拒绝。
  chatSelectSwitching: "正在切换…",
  // 失败关闭的答复：挂载中的回合无法中止，运行时宁可留在原会话，也不在该回合之下被拆除。
  // 选择本身已记录。
  chatSelectTurnNotAbortable: "切换已记录，但该会话仍有一个无法中断的回合，运行时保持在原会话。",

  // --- ruling-and-ui-defects lane block（U-05）：某一行的破坏性动作属于“刻意动作”。
  // 与产品中的结束游戏分组同一形状：首次点击只是预置，只有确认按钮才会发出请求，
  // 取消则保持当前状态。措辞说明后果，绝不承诺该动作并不具备的可逆性。
  chatRetentionArchiveConfirm: "归档此会话？它将离开活动列表，之后可以从归档中恢复。是否继续？",
  chatRetentionArchiveConfirmYes: "归档",
  chatRetentionTrashConfirm: "将此会话移入回收站？它将离开活动列表，之后可以恢复。是否继续？",
  chatRetentionTrashConfirmYes: "移入回收站",
  chatRetentionConfirmNo: "保留会话",
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
