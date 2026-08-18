/**
 * Conservative classification rules for edges reached from a normal-player
 * command ingress.  These rules are audit-only: classifying an edge never
 * exposes an Agent action.  Unknown calls deliberately remain unresolved.
 */

const NON_GAMEPLAY_CALLS = [
  // Do not classify Utility.* generically: target-game Utility contains real
  // placement, interaction, and transaction rules as well as pure helpers.
  /^(?:Math|Console|GC|Thread|Task|Enumerable)\./,
  /^(?:input|keyboardDispatcher|spriteBatch|screenFade|viewport|localMultiplayerWindow)\./,
  /^(?:getMouse|setMouse|GetKeyboardState|isOneOfTheseKeysDown|areAllOfTheseKeysUp|isAnyGamePadButtonBeingPressed|isGamePadThumbstickInMotion|PushUIMode|PopUIMode)\b/,
  /^(?:playSound|changeMusicTrack|stopMusicTrack|showRedMessage|showGlobalMessage)\b/,
  /^(?:oldMouseState|oldKBState|oldPadState)\b/,
];

const SUPPORTING_CALLS = [
  /^(?:currentMinigame\.)?(?:tick|unload|forceQuit)\b/,
  /^(?:CurrentEvent\.)?(?:skipEvent)\b/,
  /^(?:chatBox|textEntry)\.(?:update|performHoverAction|releaseLeftClick|leftClickHeld|gamePadButtonHeld|receiveScrollWheelAction)\b/,
];

/** Return an explicit audit classification or null for a still-unresolved call. */
export function classifyIngressReachableCall(callExpression) {
  if (typeof callExpression !== "string" || callExpression.length === 0) return null;
  if (NON_GAMEPLAY_CALLS.some((pattern) => pattern.test(callExpression))) {
    return { classification: "non_gameplay_path", reason: "input_framework_rendering_or_presentation_helper" };
  }
  if (SUPPORTING_CALLS.some((pattern) => pattern.test(callExpression))) {
    return { classification: "supporting_path", reason: "native_lifecycle_or_continuous_control_progression" };
  }
  return null;
}

/**
 * Classify branch-local calls from the two core world command dispatchers.
 * This stays deliberately small: a call is only marked supporting or
 * non-gameplay when its source role cannot independently express a player
 * command. All native interaction/placement/tool calls stay unresolved.
 */
export function classifyWorldDispatcherCall(dispatcherMethod, callExpression) {
  const base = classifyIngressReachableCall(callExpression);
  if (base) return base;
  if (dispatcherMethod === "pressActionButton") {
    if (
      /^(?:getOldMouse[XY]|value\d?\.Normalize|value2\.Normalize|Vector2(?:\.Dot)?|currentObjectDialogue\.(?:Peek|Dequeue)|currentSpeaker\.(?:Name\.Equals|CurrentDialogue\.(?:Peek|Pop))|getCurrentDialogue|isOnFinalDialogue|objectData\.TryGetValue|questionChoices\.Clear|didPlayerJustRightClick|isFestival|IsPerformingMousePlacement|obj\.getMineArea|player\.(?:ActiveObject\.(?:HasContextTag|isPlaceable)|currentLocation\.isCharacterAtTile|faceDirection|FarmerSprite\.setCurrentSingleAnimation|GetGrabTile|hasBuff|isRidingHorse|team\.SpecialOrderRuleActive))$/.test(
        callExpression,
      )
    ) {
      return { classification: "supporting_path", reason: "dialogue_or_target_selection_helper" };
    }
    if (/^(?:HUDMessage|addHUDMessage|content\.LoadString)$/.test(callExpression)) {
      return { classification: "non_gameplay_path", reason: "player_feedback_or_localized_presentation" };
    }
  }
  if (dispatcherMethod === "pressUseToolButton") {
    if (
      /^(?:getOldMouse[XY]|GetPlacementGrabTile|CanPlayerStowItem|didPlayerJustLeftClick|IsPerformingMousePlacement|CurrentEvent\.canPlayerUseTool|currentLocation\.(?:Objects\.TryGetValue|terrainFeatures\.TryGetValue|doesPositionCollideWithCharacter)|player\.(?:GetToolLocation|getGeneralDirectionTowards|FarmerSprite\.(?:IsPlayingBasicAnimation|StopAnimation)|isRidingHorse|IsSitting)|value\.(?:getHealth|IsTwig)|ItemRegistry\.Create|Location|Microsoft\.Xna\.Framework\.Rectangle|Vector2)$/.test(
        callExpression,
      )
    ) {
      return { classification: "supporting_path", reason: "target_resolution_or_native_tool_setup" };
    }
    if (
      /^(?:random\.Next|TemporaryAnimatedSprite|uiOverlayTempSprites\.Add|updateCursorTileHint)$/.test(callExpression)
    ) {
      return { classification: "non_gameplay_path", reason: "presentation_or_cursor_feedback_helper" };
    }
  }
  return null;
}
