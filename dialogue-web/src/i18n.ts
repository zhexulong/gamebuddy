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
  // The row's own name for a Chat the player never renamed. The Chats list numbers
  // those rows in the order it displays them, because a new Chat's preview is the
  // card's own opening and its stamp is a calendar day: without the number, two
  // Chats opened the same day render as one row twice. `{{index}}` is the row's
  // 1-based position among the list's unnamed rows - a fact of the list alone,
  // counted for display, never stored and never sent on the wire.
  untitledChat: "New chat {{index}}",
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
  gameActivationNotConfigured:
    "Companion play needs a Stardew Valley installation set up for this session, and none is yet. Choose your game folder in Game installation below, then enable companion play again.",
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
  // The list is read once, when the page opens, and the Host serves it only while
  // a launched game is starting up - so a launch after that read leaves it empty.
  // Naming that mismatch is the whole point: "reload the page" alone told the
  // player nothing about what happened or why a reload is the way forward.
  stardewCabinsUnavailable:
    "Cabins can only be read while the game you launched is starting up, and this page read them once, when it opened. Load your farm, then reload this page to pick a cabin - reloading only reopens this tab, and the game keeps running.",
  stardewCabinsAwaitingSession:
    "There is no game session to read cabins from yet. Finish steps 1 and 2 above: the cabins to confirm appear here once the companion moves in.",
  stardewCabinsEmpty:
    "This farm has no empty cabin, so your companion has nowhere to live yet. Build one at Robin's carpenter shop in the game, then reload this page to choose it.",
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
  // The openings chooser a New Chat opens when the companion has more than one
  // opening to start from. The options are named with the same vocabulary the
  // opening bubble's own switcher uses (`opening-variant-labels.ts`).
  openingPickerTitle: "Choose an opening",
  openingPickerHint: "This Chat begins with the opening you pick.",
  openingExpand: "Read it all",
  openingCollapse: "Show less",
  // The reveal is one of three on the same drawer, so the visible word alone cannot say which
  // opening it opens; the name carries the card's own name. The visible word is a prefix of the
  // name, so the spoken label still contains what the button says.
  openingExpandName: "Read it all: {{name}}",
  openingCollapseName: "Show less: {{name}}",
  // A created Chat whose chosen opening could not be committed: the Chat exists and
  // is durable, so the one fact to state is which opening it does start on.
  chatCreatedWithDefaultOpening:
    "The Chat was created, but it could not be started on the opening you picked. It opens with the default opening.",
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
  // The four ways a turn can fail, in the player's own words. The Host publishes
  // one of these codes on the failed turn (`BrowserTurnV1Schema.problemCode`,
  // `tavern_browser_api/v1`), and they mean four different things to the player:
  // the connection dropped mid-reply, the model answered but nothing was shown,
  // the endpoint refused the request, or the write did not land. `chatFailed` is the
  // fallback for a code a later Host version adds, so an unknown code renders a
  // sentence rather than its own enum member.
  chatFailedInterrupted: "The connection dropped before the reply arrived. You can try again.",
  chatFailedNoVisiblePresentation: "She finished, but nothing came through. You can try again.",
  // The refusal category: the turn failed before any model replied. The key keeps the exact name
  // of the code that carries it - `runtime_unavailable`, the one member the Host settles a
  // provider rejection as - so the catalogue and the wire spell this concept once. It names the
  // three things the player can fix on the settings side - a missing, wrong or revoked key; a
  // model the endpoint does not serve; an endpoint that cannot be reached - because naming the
  // product's own "runtime" pointed at nothing.
  chatFailedRuntimeUnavailable:
    "The reply never reached a model: the endpoint GameBuddy sends your messages to refused it — the API key is missing, wrong or revoked, the model you picked is not one that endpoint serves, or the endpoint could not be reached. Check the connection and model in Settings (Connection and model); repeating this message will fail the same way.",
  chatFailedStorageUnavailable: "The reply could not be saved. You can try again.",
  // The surface's own no-model state. A chat is not judged by whether a connection was saved: with
  // none saved, the Host sends through the Chat model profile this build ships, on this machine's
  // own gateway. So the sentence appears only when the Host cannot serve the model its send path
  // resolves from, and it names that outcome rather than accusing the player of never having set a
  // connection up (see `chat-model-route.ts`). The button goes to the one surface where a model is
  // chosen; neither the sentence nor the button touches the composer, because writing and choosing
  // a model are not the same act.
  chatNoModelTitle: "No model can answer right now",
  chatNoModelAction: "Open settings",

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
  chatDeliveryPacedTitle: "Replies arrive in short pieces",
  chatDeliveryPacedHint: "Like typing — each piece comes as it is ready, instead of one whole message.",
  chatDeliveryPacedOff: "Off, so each reply arrives as one whole message.",
  chatDeliveryPacedUnavailable: "Not available yet on this connection.",
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
  voicePersona: "Voice persona",
  voicePersonaDefault: "System default — {{persona}}",
  voicePersonaHint:
    "The voice style your companion speaks with. The system default uses the product's default voice. It applies from the next time your companion starts.",
  voicePersonaSoftMaid: "Soft-spoken girl",
  voicePersonaGentleMaid: "Gentle maid",
  voicePersonaEnergeticYouth: "Energetic youth",
  voicePersonaSteadyMature: "Steady and mature",
  languageSettings: "Companion language",
  languageHint: "The language your companion speaks. It applies from the next time your companion starts.",
  languageChinese: "Chinese (Simplified)",
  languageEnglish: "English",
  languageCompanionField: "Language tag",
  languageCompanionPlaceholder: "For example zh-CN, en-US, ja-JP",
  languageUiField: "Interface language",
  languageUiHint: "The language of this management interface. It does not change what your companion speaks.",
  languageUnavailable: "The companion language preference is unavailable.",
  voiceSettingsUnavailable: "Voice settings are unavailable.",

  connectionSettings: "Connection and model",
  connectionActiveLabel: "Active connection",
  // What this section configures, and where the rest of the work happens. It deliberately says
  // nothing about whether a reply can reach a model: that answer is derived in `chat-model-route.ts`
  // from the settings projections the Host's own send path resolves, and its one surface is the
  // Chat. Measured on the build this replaced (80a69c86, capture shots-final43): this sentence
  // promised that no reply could reach a model while in the same run a turn settled through the
  // shipped Chat profile, and the Chat — which had read the answer — said nothing.
  connectionSetupNotice:
    "A saved connection is a provider, the model it serves, and that provider's credential. Choose a provider and the model it serves, then save the connection here. Its row appears below: test it there, and enable it once the test passes.",
  connectionActivationNotice:
    "Connection activated. It applies from your next conversation; one already in progress is not switched.",
  connectionProvider: "Provider",
  connectionRecommended: "recommended",
  connectionEscapeHatch: "OpenAI-compatible endpoint",
  connectionEscapeHatchHint: "Runs against a compatible server you supply, such as Ollama, LM Studio or vLLM.",
  // Who provides a credential is not one fact. The operator's gateway is this machine's own
  // environment - no key the player can type - and every third-party entry is the player's own
  // account. The two are stated as two sentences so neither can be read as the other.
  connectionEnvironmentManaged: "Provided by the operator",
  connectionCredentialOperatorProvided:
    "This connection is provided by the operator of this machine through environment variables. There is no key to enter here.",
  connectionCredentialBringYourOwn:
    "Bring your own key: it comes from your own account with this provider, and GameBuddy does not supply one.",
  connectionBaseUrl: "Base URL",
  connectionBaseUrlHint: "For example http://127.0.0.1:11434/v1",
  connectionApiShape: "API shape",
  connectionApiShapeHint:
    "Which API shape this endpoint speaks. Your server has to offer it: anything else is refused.",
  connectionApiKey: "API key",
  connectionApiKeyWriteOnly: "Write-only. It is stored for your companion and is never shown again.",
  connectionApiKeyRequirement: "API key needed",
  connectionApiKeyRequirementYes: "Yes, this endpoint needs one",
  connectionApiKeyRequirementNone: "No, this endpoint needs no credential",
  connectionApiKeyRequirementHint:
    "A local server such as Ollama, LM Studio or vLLM needs no key at all; an OpenAI-compatible gateway does.",
  connectionApiKeyNotRequired: "This connection is probed without a credential.",
  connectionModel: "Model",
  connectionModelId: "Model ID",
  connectionModelIdHint: "The model name the endpoint serves, for example qwen2.5-coder:7b",
  connectionModelServed: "served by this endpoint",
  connectionModelSuggested: "suggestion",
  connectionModelSuggestionsHint:
    "Entries marked as suggestions come from GameBuddy's own catalogue. Your endpoint may serve others: type any model id it serves, and testing the connection is what proves it does.",
  connectionModelsServed: "models served by this endpoint",
  connectionModelOffered: "Models offered",
  connectionModelsOfferedAmong: "models offered; the one you picked is among them.",
  connectionModelsOfferedNotAmong: "models offered, but not the one you picked.",
  connectionTestResult: "Test result",
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
  // A disabled arrow still says WHY it cannot move - the pager is on the first or the last variant, or
  // this turn is still being generated - because the bare glyph dims to a tone that reads as nothing at
  // all. The enabled pair keeps the short word above, which is why these are keys of their own.
  swipePreviousAtFirst: "Previous variant (this is the first variant)",
  swipeNextAtLast: "Next variant (this is the last variant)",
  swipePreviousBusy: "Previous variant (unavailable while a reply is being generated)",
  swipeNextBusy: "Next variant (unavailable while a reply is being generated)",
  regenerateVariant: "Regenerate",
  // Her reply was cut off, and the player is the one who can do something about it: this line sits
  // on that reply and names the Regenerate control on the same row. It is NOT one of the failure
  // lines above and never reads as one - the reply is real and on screen, it is just a prefix - and
  // the Host publishes the fact from the model's own stop reason, never from the text.
  chatReplyCutOff: "Her reply was cut off by the model's length limit. Regenerate for a complete one.",
  // The rewind control: a message's own strip, one button, and what pressing it will remove. A
  // rewind is destructive and has no undo, so the arm states the consequence and only the confirm
  // sends it - the same shape the Chats row's archive/trash uses. The owner's later ruling
  // (2026-10-20) is what the words now say: a rewind KEEPS the message it names and drops what
  // follows, as Pi and SillyTavern both do, so the count is the rows AFTER this one and a player row
  // is a legal point - their line survives, their reply does not.
  rewindHere: "Rewind to here",
  rewindHereName: "Rewind to here: keeps this message and removes everything after it ({{count}} in all)",
  rewindConfirmPrompt: "Confirm rewind to here (keeps this message, deletes everything after it)",
  rewindConfirmYes: "Rewind to here",
  rewindConfirmNo: "Cancel",
  // The edit control: the player's own row carries one button, and pressing it opens the field their
  // words came from. Its accessible name says what saving does to the conversation - the model reads
  // the new words from the next turn on - because an edit that only changed the bubble would be a lie.
  editMessage: "Edit",
  editMessageName: "Edit this message: the model reads your new words from the next turn on",
  editMessageField: "Your message",
  editMessageSave: "Save",
  editMessageCancel: "Cancel",
  // Her reply's own control. The same operation on the other side of the exchange, so the same words
  // apart from the two that name whose side it is: whose words the field holds, and that the model
  // reads the rewritten ones from the next turn on.
  editReplyName: "Edit this reply: the model reads the new words from the next turn on",
  editReplyField: "Her reply",
  // The delete control: a message's own strip, one button, and the one row it removes. A delete is
  // destructive and has no undo, so the arm states exactly what goes - this message, not the
  // conversation after it - and only the confirm sends it, the same shape the Chats row's trash uses.
  deleteMessage: "Delete",
  deleteMessageName: "Delete this message: the model stops reading it from the next turn on",
  deleteConfirmPrompt: "Delete this message? This cannot be undone.",
  deleteConfirmYes: "Delete",
  // The negative answer to every destructive confirmation in this product is the same word -
  // `取消` / `Cancel` (the owner's ruling, 2026-10-20). It is the way OUT of the press, never a
  // second name for the state the row is already in; the affirmative is the one that says what
  // the press does.
  deleteConfirmNo: "Cancel",
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
  // The rewind refusals, one sentence each: which row is gone, which view has moved, which point is
  // the greeting, and whether a reply is still being written.
  problemChatMessageNotFoundTitle: "That message is gone",
  problemChatMessageNotFoundDetail:
    "This conversation no longer has that message. Read it again and pick another point to rewind to.",
  problemChatMessageRevisionConflictTitle: "The conversation moved",
  problemChatMessageRevisionConflictDetail:
    "This message is no longer where the page read it. Reload the page and try again.",
  problemChatRewindOpeningRetainedTitle: "That is the opening",
  problemChatRewindOpeningRetainedDetail: "The greeting this conversation started on cannot be removed.",
  problemChatRewindTurnActiveTitle: "A reply is still being written",
  problemChatRewindTurnActiveDetail: "Stop the reply that is in flight, then rewind.",
  // The edit's own two refusals: the row is neither the player's own words nor her reply, or a reply is
  // being written from the very text the edit would replace.
  problemChatEditTurnActiveTitle: "A reply is still being written",
  problemChatEditTurnActiveDetail: "Wait for the reply to finish, then edit the message.",
  // The delete's own three refusals. The last one is not about the player's choice at all: a message
  // the Host never recorded a session entry for cannot be removed on its own, and saying so is
  // better than removing a different part of what the model reads.
  problemChatDeleteOpeningRetainedTitle: "That is the opening",
  problemChatDeleteOpeningRetainedDetail: "The greeting this conversation started on cannot be deleted.",
  problemChatDeleteTurnActiveTitle: "A reply is still being written",
  problemChatDeleteTurnActiveDetail: "Wait for the reply to finish, then delete the message.",
  problemChatDeleteBindingUnavailableTitle: "This one cannot be deleted",
  problemChatDeleteBindingUnavailableDetail:
    "GameBuddy never recorded which part of the model's memory this message is, so it cannot remove only this one. Messages sent from now on can be deleted.",
  // The families the contract's remaining problem codes fall into - see `composed-problem-view.ts`,
  // which maps every member of the union to one of them. A family is one fact and one next step: the
  // ten compare-and-set refusals say what the change was based on moved, the four in-progress ones say
  // to wait, the five "not found" ones say the thing is gone. A refusal whose meaning differs from its
  // neighbours keeps its own pair.
  problemRevisionConflictTitle: "This changed while you were working",
  problemRevisionConflictDetail:
    "The conversation moved on since the page read it, so your change was not applied. Reload the chat to see the current state, then try again.",
  problemStillRunningTitle: "Something is still running",
  problemStillRunningDetail:
    "GameBuddy is still working on the last thing you asked. Wait for it to finish, then try again.",
  problemRepeatNotMatchedTitle: "That was not repeated",
  problemRepeatNotMatchedDetail:
    "GameBuddy could not match this to your earlier attempt, so it did not run it again. Reload the chat and try again.",
  problemNoSuchItemTitle: "That is not there any more",
  problemNoSuchItemDetail:
    "What this names is gone - it was removed or replaced. Reload the page and choose again from what is shown.",
  problemTurnNotRunningTitle: "There is nothing to stop",
  problemTurnNotRunningDetail: "That reply had already finished, or had not started yet, so there was nothing to stop.",
  problemServiceUnavailableTitle: "GameBuddy is not available right now",
  problemServiceUnavailableDetail:
    "One of GameBuddy's own services could not be used just now, so the chat could not go on. Try again in a moment.",
  problemStreamResyncTitle: "The live updates lost their place",
  problemStreamResyncDetail:
    "GameBuddy stopped receiving this chat's live updates, so the page is out of date. Reload the chat to catch up.",
  problemRequestRejectedTitle: "GameBuddy could not accept that",
  problemRequestRejectedDetail:
    "The request could not be taken as it was sent. Reload the chat and try again; if it carried a file or a long text, send a smaller one.",
  problemAuthoredContentInvalidTitle: "That text cannot be saved",
  problemAuthoredContentInvalidDetail:
    "What you wrote is not something GameBuddy can keep as it stands - it may be too long, or missing a field it needs. Change it and save again.",
  problemImportFormInvalidTitle: "The import could not go on",
  problemImportFormInvalidDetail:
    "The details submitted for this import are not ones GameBuddy can accept. Start the import again from the file.",
  problemCardImportRejectedTitle: "That file is not a character card",
  problemCardImportRejectedDetail:
    "GameBuddy could not read it as a Tavern character card. Check that it is the right file, then choose it again.",
  problemCardTooLargeTitle: "Her records do not fit a card",
  problemCardTooLargeDetail:
    "A Tavern card GameBuddy can import will not hold everything saved for her, and trying again will not make it fit.",
  problemCardImageAbsentTitle: "She has no picture to put in it",
  problemCardImageAbsentDetail:
    "A PNG card has to carry a picture, and she has none. Export the JSON card instead - it carries her records without one.",
  problemAvatarRejectedTitle: "That picture was not kept",
  problemAvatarRejectedDetail:
    "Her picture has to be a complete PNG within GameBuddy's size limit. Choose a smaller, complete PNG.",
  problemRecordUnreadableTitle: "Her saved record could not be read",
  problemRecordUnreadableDetail:
    "What GameBuddy has stored for this companion is incomplete or damaged. Nothing you change here can be saved until it is repaired.",
  problemOpeningLockedTitle: "The opening is already set",
  problemOpeningLockedDetail:
    "This conversation has already started, so the greeting it opened on can no longer change. Start a new chat to open on a different one.",
  problemOpeningNotReviewableTitle: "This chat has no openings to choose",
  problemOpeningNotReviewableDetail:
    "This conversation did not open on a reviewed greeting set, so there is no other opening to switch to.",
  problemOpeningVariantGoneTitle: "That opening is gone",
  problemOpeningVariantGoneDetail:
    "The greeting you picked is not part of this conversation's greeting set any more. Reload the chat to see the openings it has.",
  problemWorldBookAbsentTitle: "She has no world book yet",
  problemWorldBookAbsentDetail:
    "There is no world book saved for her, so this change had nothing to update. Save a new one to start it.",
  problemWorldBookBindingPartialTitle: "The book saved, but the chats did not follow",
  problemWorldBookBindingPartialDetail:
    "The new version is saved, but the chats that used the previous one could not be moved onto it. Reload to see where those chats stand.",
  problemWorldInfoTitleTakenTitle: "That title is already used",
  problemWorldInfoTitleTakenDetail:
    "A World Info entry already has this title. Give this one a different title and save again.",
  problemWorldInfoInUseTitle: "A chat is still reading this",
  problemWorldInfoInUseDetail:
    "The conversation in use reads this World Info entry, so it cannot be deleted. Untie it from the chat first, then delete it.",
  problemConnectionNotReadyTitle: "That connection is not ready",
  problemConnectionNotReadyDetail:
    "GameBuddy has not confirmed this connection answers yet. Test it, then make it the one in use.",
  problemConnectionConflictTitle: "The connection list moved",
  problemConnectionConflictDetail:
    "The connections changed since the page read them, or this is the connection in use and cannot be removed. Reload and try again.",
  problemConnectionLimitReachedTitle: "There are as many connections as GameBuddy keeps",
  problemConnectionLimitReachedDetail:
    "GameBuddy keeps a limited number of connections. Remove one before adding another.",
  // The game surface's own refusals. The composed shell serves two contracts: the tavern
  // `ProblemCode` above and `game_browser_api/v1`
  // (`host/src/game-browser-contract/index.ts`), whose codes name game facts the chat's
  // sentences cannot state - a connection generation that moved, an unconfirmed cabin handoff,
  // a cabin choice that expired. One pair per fact, and the next step that fact asks for.
  // `problem-code-gate.test.mjs` (`problem-code.8`/`problem-code.9`) drives every member of that
  // union through this catalogue and pins the client's mirror to the Host's declaration, so a
  // code added to the contract fails the gate until it has words here.
  gameProblemUnavailableTitle: "The game did not go ahead",
  gameProblemUnavailableDetail:
    "GameBuddy could not carry out this step of the game. The latest authoritative game state is shown; check Game installation, then try again.",
  // The one templated game pair. `game_unavailable` is the wrapper the Host answers with when a
  // step of the game's own lifecycle failed, and the bounded `stardew_*` cause it registers is
  // what says which step: without a cause, the generic sentence above is the whole truth.
  gameProblemUnavailableCauseDetail:
    "GameBuddy could not carry out this step of the game (registered cause {{cause}}). The latest authoritative game state is shown; check Game installation, then try again.",
  gameProblemPrerequisitesMissingTitle: "Companion play is not ready yet",
  gameProblemPrerequisitesMissingDetail:
    "GameBuddy has not staged this session's game yet. Enable companion play first, then try this again.",
  gameProblemCompatibilityTitle: "That game build is not supported",
  gameProblemCompatibilityDetail:
    "The Stardew Valley installation GameBuddy found is not a version it can run with. Fix the installation, then try again.",
  gameProblemInstanceGoneTitle: "That game is gone",
  gameProblemInstanceGoneDetail:
    "The game instance this page named is no longer the current one - it stopped or was replaced. Reload the game page to see what is running now.",
  gameProblemAttachmentMovedTitle: "The game connection moved",
  gameProblemAttachmentMovedDetail:
    "The game attached or detached since the page read it, so this action was not applied. Reload the game page to see the current connection, then try again.",
  gameProblemNotRepeatedTitle: "That was not repeated",
  gameProblemNotRepeatedDetail:
    "GameBuddy could not match this to your earlier attempt, so it did not run it again. Reload the game page, then start the action again.",
  gameProblemCabinChoiceStaleTitle: "That cabin choice expired",
  gameProblemCabinChoiceStaleDetail:
    "The cabin you picked is no longer one of the choices offered - the list moved, or that choice was already used. Read the cabins again and choose one.",
  gameProblemHandoffUncertainTitle: "The cabin handoff is not confirmed",
  gameProblemHandoffUncertainDetail:
    "GameBuddy could not confirm which cabin was handed over, so do not confirm again. Wait for recovery, or reload the game page to see the authoritative state.",
  gameProblemRuntimeUnavailableTitle: "The game's runtime is not available",
  gameProblemRuntimeUnavailableDetail:
    "The runtime that runs the game's side of this session is not running, so the action did not go on. Reload the game page, then start the game again.",
  gameProblemStorageUnavailableTitle: "The game session could not be stored",
  gameProblemStorageUnavailableDetail:
    "GameBuddy could not write this session's game record, so the game session was not created. Reload the game page and try again.",
  gameProblemEndgameSettlementTitle: "The game was not settled",
  gameProblemEndgameSettlementDetail:
    "The endgame request reached the game, but its settlement did not complete, so the game may still be running. Reload the game page and check before ending it again.",
  gameProblemClosedTitle: "This game page has ended",
  gameProblemClosedDetail:
    "GameBuddy ended this game page, so there is nothing left to act on. Open the game again from GameBuddy.",
  gameProblemRequestRejectedTitle: "GameBuddy could not accept that",
  gameProblemRequestRejectedDetail:
    "The request could not be taken as it was sent. Reload the game page and try again.",
  gameProblemRouteUnavailableTitle: "Unable to reach the game",
  gameProblemRouteUnavailableDetail:
    "This GameBuddy build does not serve the game route the page asked for. Update GameBuddy or reload the page.",
  gameProblemStateUnavailableTitle: "The game is not available right now",
  gameProblemStateUnavailableDetail:
    "GameBuddy could not read or settle the game's own state just now. Reload the game page to see where it stands, then try again.",

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
  gameInstallationResultUnavailable: "We couldn't read the installation search result.",
  gameInstallationModLoaderMissing:
    "We found Stardew Valley, but there is no mod loader (SMAPI) in that folder. Install SMAPI, then find again — or choose a game folder that already has it.",
  // The other selection refusal a player can fix. The file name is what they look for in
  // their folder; the sentence says what to do rather than only what is wrong.
  gameInstallationNotStardewInstallation:
    "That folder is not a Stardew Valley installation. Choose the game folder that contains Stardew Valley.exe.",
  // A registration the Host could not name a cause for. It says nothing it cannot know:
  // not that the folder is wrong, not that the search failed.
  gameInstallationSelectionUnavailable: "That folder could not be used. Choose another game folder.",
  // The registration the player just asked for is done. A scan after a
  // registration finds nothing left to offer, so this sentence is the only place
  // the outcome exists; it says what the panel will not do (nothing here) and what
  // the player does next (the two steps on the game panel above it).
  gameInstallationConfirmed: "Confirmed. Next, enable companion play and set up Stardew Valley, then load your farm.",
  gameInstallationExpired: "These search results expired. Search again.",
  gameInstallationError: "The installation search failed.",
  gameInstallationConfirm: "Confirm",
  gameInstallationChooseFolder: "Choose game folder",
  gameInstallationFindAgain: "Find again",
  // Where the scan found an installation, one sentence per source the discovery
  // session declares (`steam-registry | steam-vdf | known-location`,
  // `host/src/windows-stardew-installation-discovery/internal.ts`). The last entry
  // is the honest stand-in for a source this build has no sentence for: the Host
  // published a candidate, so "it was found" is true whatever produced it, while
  // the wire's own member is never player text (design/104 §10).
  gameInstallationSourceSteamRegistry: "Found via Steam",
  gameInstallationSourceSteamVdf: "Found in a Steam library folder",
  gameInstallationSourceKnownLocation: "Found in a common install folder",
  gameInstallationSourceOther: "Found on this computer",
  // The row's own name for the game. The Host's `label` is content but it is one
  // fixed English string for every installation (`StardewDiscoverySession.issue`), so
  // a Chinese row built from it carried English while everything around it was
  // translated; the product already names the game in both catalogues, and the wire's
  // own `label` stays as the row's attribution (`data-label`).
  gameInstallationCandidateName: "Stardew Valley",
  // Where that installation is, when several of the same game are offered: the Host
  // publishes the drive and library folder's own name (`D: · SteamLibrary`), and the
  // parentheses are the player's own punctuation rather than the Host's.
  gameInstallationCandidateLocation: "{{name}} ({{location}})",
  // The Host redacts the installation's path and says so in its own English
  // (`host/src/games/stardew/provider.ts`); the panel states that fact itself.
  gameInstallationHintPathHidden: "Its folder path is hidden.",

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
  gameGuideStepOneDetail:
    "Choose your game folder under Game installation first if it is not set yet, then do the two controls below in this order: enable companion play, then set up Stardew Valley.",
  // What each of step 1's two controls is for. They run in one order only - the
  // Host refuses setup before activation - and that order used to reach the
  // player only as a refusal after they had already picked the wrong one.
  gameActivationHint: "Gets the companion ready to play in this session.",
  gameSetupHint: "Prepares Stardew Valley and the companion's mod.",
  gameGuideStepTwoTitle: "Load your farm",
  gameGuideStepTwoDetail: "Start the game with your companion, then load the farm you want to play.",
  gameGuideStepThreeTitle: "Your companion moves in",
  gameGuideStepThreeDetail: "Choose the cabin your companion settles into.",

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
  chatRetentionArchiveConfirm: "Archive this chat? It leaves the active list. This cannot be undone.",
  // The chat transcript export: one Chat's own messages as the SillyTavern chat file the Host's
  // interchange produced. The player saves the Host's own bytes and is told what the file does not
  // carry, so a subset is never mistaken for the whole conversation.
  chatExportSaved: "Saved {{file}}.",
  chatExportFailed: "The chat could not be exported.",
  chatExportDropped: "Not in the file: {{fields}}.",
  chatRetentionArchiveConfirmYes: "Archive",
  chatRetentionTrashConfirm: "Move this chat to the trash? It leaves the active list. This cannot be undone.",
  chatRetentionTrashConfirmYes: "Move to trash",
  // The same negative as every other destructive pair in the product: `取消`. The verbs above
  // stay specific to what each press does; the way out is one word.
  chatRetentionConfirmNo: "Cancel",
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
  untitledChat: "新对话 {{index}}",
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
  gameActivationNotConfigured:
    "伙伴陪玩需要先确定《星露谷物语》的安装位置，而现在还没有。请在下面的「游戏安装」里选择游戏文件夹，然后再次启用伙伴陪玩。",
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
  stardewCabinsUnavailable:
    "小屋只能在启动游戏的过程中读取，而这个页面只在刚打开时读过一次。请先载入你的农场，再重新加载本页来选小屋——重新加载只是重开这个标签页，游戏不会停。",
  stardewCabinsAwaitingSession:
    "还没有可以读取小屋的游戏会话。先完成上面第 1、2 步；伴侣住进农舍后，可确认的小屋会出现在这里。",
  stardewCabinsEmpty:
    "这个农场还没有空着的小屋，同伴还没有地方住。请去游戏里罗宾的木匠铺建一间，然后重新加载本页来选它。",
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
  openingPickerTitle: "选择开场白",
  openingPickerHint: "会话将以您选择的开场白开始。",
  openingExpand: "展开全文",
  openingCollapse: "收起",
  openingExpandName: "展开全文：{{name}}",
  openingCollapseName: "收起：{{name}}",
  chatCreatedWithDefaultOpening: "会话已创建，但无法以您选择的开场白开始，将使用默认开场白。",
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
  // 回合失败的四种情况，见英文目录同名字段的说明。未知代码回退到 chatFailed。
  chatFailedInterrupted: "连接中断了，回复没有送达。你可以重试。",
  chatFailedNoVisiblePresentation: "她没能开口，回复没有显示出来。你可以重试。",
  // 拒绝分类：英文目录同名字段说明了承载它的 wire 代码（runtime_unavailable）和理由。
  chatFailedRuntimeUnavailable:
    "这条回复没有送达任何模型：GameBuddy 转发消息的端点拒绝了它——API Key 缺失、错误或已被吊销，你选的模型不是该端点提供的，或者根本连不上那个端点。请在「设置 → 连接与模型」里检查连接和模型；重复发送同一条消息只会以同样方式失败。",
  chatFailedStorageUnavailable: "回复没能保存下来。你可以重试。",
  chatNoModelTitle: "目前没有可以回复的模型",
  chatNoModelAction: "前往设置",

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
  chatDeliveryPacedTitle: "回复一小段一小段来",
  chatDeliveryPacedHint: "像在打字——每一小段准备好就发过来，而不是一整条消息。",
  chatDeliveryPacedOff: "关闭时，每条回复都是一整条消息。",
  chatDeliveryPacedUnavailable: "当前连接暂时还用不了这项。",
  voiceConsentRevoked: "已撤销",
  voiceDisclosureVersion: "披露版本",
  voiceDisclosureUndisclosed: "尚未披露——尚未做出授权决定",
  voiceAccept: "接受",
  voiceRevoke: "撤销",
  voiceOutputDevice: "输出设备",
  voiceDefaultOutput: "系统默认",
  voicePinnedOutputUnlisted: "已选端点（当前未列出）",
  voicePersona: "语音人格",
  voicePersonaDefault: "系统默认 — {{persona}}",
  voicePersonaHint: "伴侣说话的音色风格。系统默认会使用产品默认音色。下次伴侣启动时生效。",
  voicePersonaSoftMaid: "软糯少女音",
  voicePersonaGentleMaid: "温婉女仆音",
  voicePersonaEnergeticYouth: "元气少年音",
  voicePersonaSteadyMature: "沉稳磁性音",
  languageSettings: "伴侣语言",
  languageHint: "伴侣说话使用的语言，下次伴侣启动时生效。",
  languageChinese: "简体中文",
  languageEnglish: "English",
  languageCompanionField: "语言标签",
  languageCompanionPlaceholder: "例如 zh-CN、en-US、ja-JP",
  languageUiField: "界面语言",
  languageUiHint: "本管理界面使用的语言，不会改变伴侣说话的语言。",
  languageUnavailable: "伴侣语言偏好不可用。",
  voiceSettingsUnavailable: "语音设置不可用。",

  connectionSettings: "连接与模型",
  connectionActiveLabel: "当前连接",
  connectionSetupNotice:
    "一条保存的连接由渠道、它提供的模型和该渠道的凭据组成。选择渠道和它提供的模型，然后在这里保存连接。保存后的记录会出现在下方：在那里测试，测试通过即可启用。",
  connectionActivationNotice: "连接已启用。从下次开始对话时生效；正在进行的会话不会被切换。",
  connectionProvider: "渠道",
  connectionRecommended: "推荐",
  connectionEscapeHatch: "OpenAI 兼容端点",
  connectionEscapeHatchHint: "连接到你自己提供的兼容服务器，例如 Ollama、LM Studio 或 vLLM。",
  connectionEnvironmentManaged: "由运营方提供",
  connectionCredentialOperatorProvided: "该连接由本机运营方通过环境变量提供，这里没有需要填写的密钥。",
  connectionCredentialBringYourOwn: "自备密钥：密钥来自你在该服务商自己的账号，GameBuddy 不提供密钥。",
  connectionBaseUrl: "Base URL",
  connectionBaseUrlHint: "例如 http://127.0.0.1:11434/v1",
  connectionApiShape: "API 协议",
  connectionApiShapeHint: "该端点使用的接口协议。必须与你的服务端实际提供的协议一致，否则会被拒绝。",
  connectionApiKey: "API Key",
  connectionApiKeyWriteOnly: "只写：它保存给你的伙伴使用，之后不会再回显。",
  connectionApiKeyRequirement: "是否需要 API Key",
  connectionApiKeyRequirementYes: "需要，该端点要使用 API Key",
  connectionApiKeyRequirementNone: "不需要，该端点无需凭据",
  connectionApiKeyRequirementHint: "Ollama、LM Studio 或 vLLM 这类本地服务器完全不需要密钥；兼容 OpenAI 的网关则需要。",
  connectionApiKeyNotRequired: "该连接将在没有凭据的情况下进行测试。",
  connectionModel: "模型",
  connectionModelId: "模型 ID",
  connectionModelIdHint: "该端点提供的模型名，例如 qwen2.5-coder:7b",
  connectionModelServed: "该端点提供",
  connectionModelSuggested: "建议",
  connectionModelSuggestionsHint:
    "标记为建议的条目来自 GameBuddy 自带的推荐。你的端点可能还提供其他模型：直接输入它提供的任意模型 ID，测试连接即可确认。",
  connectionModelsServed: "个模型由该端点提供",
  connectionModelOffered: "可用模型",
  connectionModelsOfferedAmong: "个模型可选，你选的模型在其中。",
  connectionModelsOfferedNotAmong: "个模型可选，但没有你选的那个。",
  connectionTestResult: "测试结果",
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
  // 不可用的箭头也要说出「为什么」：分页已经在这一组的第一条或最后一条，或者这一轮还在生成——裸字形
  // 暗下去之后看起来像什么都没有，无障碍名称是它唯一还说得出口的地方。可用的那一对保持上面那两个短词。
  swipePreviousAtFirst: "上一个变体（这已经是第一个变体）",
  swipeNextAtLast: "下一个变体（这已经是最后一个变体）",
  swipePreviousBusy: "上一个变体（正在生成回复，暂时不可用）",
  swipeNextBusy: "下一个变体（正在生成回复，暂时不可用）",
  regenerateVariant: "重新生成",
  // 她的回复被截断了，而能改变这件事的是玩家：这句话就落在那条回复上，并点名同一行的「重新生成」。
  // 它不属于上面的失败文案，读起来也不像失败——回复是真实存在的、就在屏幕上，只是写了一半。
  // Host 依据模型自己的停止原因发布这个事实，绝不从文字里推测。
  chatReplyCutOff: "她的回复写到长度上限就被截断了。点「重新生成」可以得到完整的一条。",
  // 回退控件：消息自己的操作条上一个按钮，并说清按下去会删掉什么。回退不可撤销，所以先确认再发送，与
  // 会话行上的归档/删除同一形状。主人后来的裁定（2026-10-20）就是这里的措辞：回退**保留**它点名的那条
  // 消息、只删掉其后的内容（与 Pi、SillyTavern 一致），所以数目是这条之后的条数，玩家自己那一行也是合法
  // 的回退点——他们的话留着，回答没了，等着被重新回答。
  rewindHere: "回退到此处",
  rewindHereName: "回退到此处：保留这条消息，删除其后的全部内容（共 {{count}} 条）",
  rewindConfirmPrompt: "确认回退到此处（保留本条，删除其后全部消息）",
  rewindConfirmYes: "回退到此处",
  rewindConfirmNo: "取消",
  // 编辑控件：玩家自己的那一行只带一个按钮，按下后打开写这句话的输入框。无障碍名称说清保存后对话会发生什么
  // ——模型从下一轮开始读到你改写后的文字，因为只改气泡不改模型所见就是一种欺骗。
  editMessage: "编辑",
  editMessageName: "编辑这条消息：模型从下一轮开始读到你改写后的文字",
  editMessageField: "你的消息",
  editMessageSave: "保存",
  editMessageCancel: "取消",
  editReplyName: "编辑这条回复：模型从下一轮开始读到你改写后的文字",
  editReplyField: "她的回复",
  // 删除控件：消息自己的操作条上一个按钮，只删这一条。删除不可撤销，所以先确认、并说清删掉的是什么
  // ——是这一条，而不是它之后的整个对话，与会话行上的删除同一形状。
  deleteMessage: "删除",
  deleteMessageName: "删除这条消息：模型从下一轮开始不再读到它",
  deleteConfirmPrompt: "删除这条消息？此操作无法撤销。",
  deleteConfirmYes: "删除",
  deleteConfirmNo: "取消",
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
  problemChatMessageNotFoundTitle: "这条消息已经不在了",
  problemChatMessageNotFoundDetail: "这个对话里已经没有这条消息了。请重新读取，另选一个回退位置。",
  problemChatMessageRevisionConflictTitle: "对话已经变化",
  problemChatMessageRevisionConflictDetail: "这条消息已经不在页面上显示的位置了。请重新加载页面后重试。",
  problemChatRewindOpeningRetainedTitle: "这是开场问候",
  problemChatRewindOpeningRetainedDetail: "对话开始时的那句问候不能删除。",
  problemChatRewindTurnActiveTitle: "还有一条回复正在生成",
  problemChatRewindTurnActiveDetail: "请先停止正在生成的回复，再回退。",
  problemChatEditTurnActiveTitle: "还有一条回复正在生成",
  problemChatEditTurnActiveDetail: "请等这条回复生成完成后，再编辑这条消息。",
  problemChatDeleteOpeningRetainedTitle: "这是开场问候",
  problemChatDeleteOpeningRetainedDetail: "对话开始时的那句问候不能删除。",
  problemChatDeleteTurnActiveTitle: "还有一条回复正在生成",
  problemChatDeleteTurnActiveDetail: "请等这条回复生成完成后，再删除这条消息。",
  problemChatDeleteBindingUnavailableTitle: "这一条无法删除",
  problemChatDeleteBindingUnavailableDetail:
    "GameBuddy 没有记录这条消息在模型记忆中对应的是哪一段，因此无法只删掉这一条。从现在起发送的新消息都可以删除。",
  problemRevisionConflictTitle: "你动手的时候它变了",
  problemRevisionConflictDetail:
    "页面读取之后对话已经变化，所以这次改动没有生效。请重新加载聊天，看清当前状态后再试一次。",
  problemStillRunningTitle: "还有事情没有做完",
  problemStillRunningDetail: "GameBuddy 还在处理你刚才的请求。请等它完成后再试。",
  problemRepeatNotMatchedTitle: "这一次没有重复执行",
  problemRepeatNotMatchedDetail:
    "GameBuddy 无法确认这与刚才那次是同一个请求，因此没有再次执行。请重新加载聊天后再试一次。",
  problemNoSuchItemTitle: "那一项已经不在了",
  problemNoSuchItemDetail:
    "这次操作指向的内容已经不在了——它被删除或被替换了。请重新加载页面，从当前显示的内容里重新选择。",
  problemTurnNotRunningTitle: "没有可以停止的回复",
  problemTurnNotRunningDetail: "那条回复已经结束，或者还没有开始，所以没有需要停止的内容。",
  problemServiceUnavailableTitle: "GameBuddy 现在不可用",
  problemServiceUnavailableDetail: "GameBuddy 自己的某个服务现在用不了，聊天无法继续。请稍后再试。",
  problemStreamResyncTitle: "实时更新断开了",
  problemStreamResyncDetail: "GameBuddy 停止接收这个聊天的实时更新，页面上的内容已经过期。请重新加载聊天以同步。",
  problemRequestRejectedTitle: "GameBuddy 无法接受这次请求",
  problemRequestRejectedDetail:
    "这次请求无法按原样处理。请重新加载聊天后重试；如果它带了文件或很长的文本，请改用更小的内容。",
  problemAuthoredContentInvalidTitle: "这段内容无法保存",
  problemAuthoredContentInvalidDetail:
    "你写的内容里有 GameBuddy 无法保存的部分——可能太长，或者缺少必需的字段。请修改后重新保存。",
  problemImportFormInvalidTitle: "这次导入无法继续",
  problemImportFormInvalidDetail: "为这次导入提交的内容 GameBuddy 无法接受。请从文件重新开始导入。",
  problemCardImportRejectedTitle: "这个文件不是角色卡",
  problemCardImportRejectedDetail: "GameBuddy 无法把它读成 Tavern 角色卡。请确认文件是否正确，然后重新选择。",
  problemCardTooLargeTitle: "她的资料装不进一张卡",
  problemCardTooLargeDetail: "一张 GameBuddy 能导入的 Tavern 角色卡放不下她的全部资料，再试一次也不会让它装得下。",
  problemCardImageAbsentTitle: "她没有可以放进去的图片",
  problemCardImageAbsentDetail:
    "PNG 角色卡必须带一张图片，而她没有。请改导出 JSON 角色卡，它不需要图片就能带她的资料。",
  problemAvatarRejectedTitle: "这张图片没有保存",
  problemAvatarRejectedDetail:
    "她的图片必须是一张完整的 PNG，并且在 GameBuddy 的大小限制内。请换一张更小、完整的 PNG。",
  problemRecordUnreadableTitle: "读不出她保存的资料",
  problemRecordUnreadableDetail:
    "GameBuddy 为这个伙伴保存的资料不完整或已损坏。在修好之前，这里做的任何改动都无法保存。",
  problemOpeningLockedTitle: "开场已经定下了",
  problemOpeningLockedDetail: "这个对话已经开始，所以开场的那句问候不能再改。想换开场，请新建一个对话。",
  problemOpeningNotReviewableTitle: "这个对话没有可选的开场",
  problemOpeningNotReviewableDetail: "这个对话的开场不是一组可审阅的问候，所以没有别的开场可以切换。",
  problemOpeningVariantGoneTitle: "那个开场已经不在了",
  problemOpeningVariantGoneDetail: "你选的问候已经不在这个对话的开场集合里。请重新加载聊天，看看它现在有哪些开场。",
  problemWorldBookAbsentTitle: "她还没有世界书",
  problemWorldBookAbsentDetail: "她名下没有保存过世界书，所以这次改动没有可更新的内容。请先保存一版来开始。",
  problemWorldBookBindingPartialTitle: "世界书保存了，但聊天没有跟上",
  problemWorldBookBindingPartialDetail:
    "新版本已经保存，但用过旧版本的聊天没能一起换过去。请重新加载，查看那些聊天的当前状态。",
  problemWorldInfoTitleTakenTitle: "这个标题已经被用了",
  problemWorldInfoTitleTakenDetail: "已经有一条同名标题的世界书词条。请换一个标题再保存。",
  problemWorldInfoInUseTitle: "还有聊天在读它",
  problemWorldInfoInUseDetail: "正在使用的那个对话还在读这条世界书词条，所以不能删除。请先在对话里解除引用，再删除。",
  problemConnectionNotReadyTitle: "这个连接还没准备好",
  problemConnectionNotReadyDetail: "GameBuddy 还没有确认这个连接能应答。请先测试它，再把它设为正在使用的连接。",
  problemConnectionConflictTitle: "连接列表已经变化",
  problemConnectionConflictDetail: "页面读取之后连接已经变化，或者这是正在使用、无法删除的连接。请重新加载后再试。",
  problemConnectionLimitReachedTitle: "连接数量已经到上限",
  problemConnectionLimitReachedDetail: "GameBuddy 能保存的连接数量有限。请先删掉一个，再添加新的。",
  gameProblemUnavailableTitle: "游戏没有进行下去",
  gameProblemUnavailableDetail:
    "GameBuddy 无法完成这一步游戏操作。下面是当前权威的游戏状态；请检查「游戏安装」，再试一次。",
  gameProblemUnavailableCauseDetail:
    "GameBuddy 无法完成这一步游戏操作（登记的原因：{{cause}}）。下面是当前权威的游戏状态；请检查「游戏安装」，再试一次。",
  gameProblemPrerequisitesMissingTitle: "陪伴游览还没有准备好",
  gameProblemPrerequisitesMissingDetail: "GameBuddy 还没有为这次会话准备好游戏。请先启用陪伴游览，再重试。",
  gameProblemCompatibilityTitle: "这个游戏版本不受支持",
  gameProblemCompatibilityDetail: "GameBuddy 找到的《星露谷物语》不是它能配合运行的版本。请修好这份安装，再试一次。",
  gameProblemInstanceGoneTitle: "那个游戏已经不在了",
  gameProblemInstanceGoneDetail:
    "这个页面指的游戏实例已经不是当前的那个了 —— 它停止了，或被替换了。请重新加载游戏页面，看看现在运行的是哪一个。",
  gameProblemAttachmentMovedTitle: "游戏连接已经变化",
  gameProblemAttachmentMovedDetail:
    "页面读取之后，游戏已经连接或断开了，所以这次操作没有被执行。请重新加载游戏页面，看清当前的连接，再试一次。",
  gameProblemNotRepeatedTitle: "这次没有重放",
  gameProblemNotRepeatedDetail:
    "GameBuddy 无法把这次请求和你之前的那一次对应起来，所以没有再次执行。请重新加载游戏页面，再发起这次操作。",
  gameProblemCabinChoiceStaleTitle: "那个小屋选择已经失效",
  gameProblemCabinChoiceStaleDetail:
    "你选的小屋已经不在可选的列表里了 —— 列表变了，或者那个选择已经被用掉。请重新读取小屋列表，再选一个。",
  gameProblemHandoffUncertainTitle: "小屋的交接还没有确认",
  gameProblemHandoffUncertainDetail:
    "GameBuddy 无法确认交接的是哪个小屋，所以请不要再次确认。等待恢复，或重新加载游戏页面查看权威状态。",
  gameProblemRuntimeUnavailableTitle: "游戏的运行时不可用",
  gameProblemRuntimeUnavailableDetail:
    "运行这次会话中游戏那一侧的运行时没有在运行，所以这次操作没有进行下去。请重新加载游戏页面，再启动游戏。",
  gameProblemStorageUnavailableTitle: "游戏会话没能保存",
  gameProblemStorageUnavailableDetail:
    "GameBuddy 无法写入这次会话的游戏记录，所以游戏会话没有创建。请重新加载游戏页面，再试一次。",
  gameProblemEndgameSettlementTitle: "游戏没有完成收尾",
  gameProblemEndgameSettlementDetail:
    "结束游戏的请求已经到达游戏，但收尾没有完成，游戏可能仍在运行。请重新加载游戏页面确认状态，再决定是否再次结束。",
  gameProblemClosedTitle: "这个游戏页面已经关闭",
  gameProblemClosedDetail: "GameBuddy 关闭了这个游戏页面，已经没有可以操作的对象了。请从 GameBuddy 重新打开游戏。",
  gameProblemRequestRejectedTitle: "GameBuddy 无法接受这次请求",
  gameProblemRequestRejectedDetail: "请求不能按发送的样子被接受。请重新加载游戏页面，再试一次。",
  gameProblemRouteUnavailableTitle: "无法访问游戏",
  gameProblemRouteUnavailableDetail:
    "当前 GameBuddy 版本不提供该页面请求的游戏路由。请更新 GameBuddy，或重新加载页面。",
  gameProblemStateUnavailableTitle: "游戏现在不可用",
  gameProblemStateUnavailableDetail:
    "GameBuddy 刚才无法读取或确认游戏自身的状态。请重新加载游戏页面，看清它现在的情况，再试一次。",

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
  gameInstallationResultUnavailable: "无法读取游戏安装搜索结果。",
  gameInstallationModLoaderMissing:
    "已找到《星露谷物语》，但这个目录里没有模组加载器（SMAPI）。请先安装 SMAPI，再重新查找；也可以选择已经装有 SMAPI 的游戏文件夹。",
  gameInstallationNotStardewInstallation:
    "这个文件夹不是《星露谷物语》的安装位置。请选择包含 Stardew Valley.exe 的那个游戏文件夹。",
  gameInstallationSelectionUnavailable: "无法使用这个文件夹，请重新选择游戏文件夹。",
  gameInstallationConfirmed: "已确认。接下来启用伙伴陪玩，再设置《星露谷物语》，就可以载入你的农场。",
  gameInstallationExpired: "搜索结果已过期，请重新搜索。",
  gameInstallationError: "搜索游戏安装位置失败。",
  gameInstallationConfirm: "确认",
  gameInstallationChooseFolder: "选择游戏文件夹",
  gameInstallationFindAgain: "重新查找",
  gameInstallationSourceSteamRegistry: "通过 Steam 找到",
  gameInstallationSourceSteamVdf: "在 Steam 库文件夹中找到",
  gameInstallationSourceKnownLocation: "在常见的安装位置找到",
  gameInstallationSourceOther: "已在这台电脑上找到",
  gameInstallationCandidateName: "《星露谷物语》",
  gameInstallationCandidateLocation: "{{name}}（{{location}}）",
  gameInstallationHintPathHidden: "安装路径不显示。",

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
  gameGuideStepOneDetail:
    "如果还没选过游戏目录，先在下方「游戏安装」里选好；然后按顺序做下面两个操作：先启用伙伴陪玩，再设置《星露谷物语》。",
  gameActivationHint: "让伴侣为这次会话做好准备。",
  gameSetupHint: "准备好《星露谷物语》和伴侣模组。",
  gameGuideStepTwoTitle: "载入你的农场",
  gameGuideStepTwoDetail: "和伙伴一起启动游戏，然后载入你想玩的农场。",
  gameGuideStepThreeTitle: "同伴住进农舍",
  gameGuideStepThreeDetail: "选一间农舍，同伴就住进去。",
  // 高级配置：这里是玩家可见文案，不出现上游工具名、他人的文件名或路由；
  // 只说清楚这些设置存在文件里、本页面不能改，以及因此没有可编辑的内容。

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
  chatRetentionArchiveConfirm: "归档此会话？它将离开活动列表，此操作不可撤销。",
  chatExportSaved: "已保存 {{file}}。",
  chatExportFailed: "无法导出这个会话。",
  chatExportDropped: "文件中不包含：{{fields}}。",
  chatRetentionArchiveConfirmYes: "归档",
  chatRetentionTrashConfirm: "将此会话移入回收站？它将离开活动列表，此操作不可撤销。",
  chatRetentionTrashConfirmYes: "移入回收站",
  chatRetentionConfirmNo: "取消",
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
