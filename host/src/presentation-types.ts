/** Surface-neutral presentation port contract; importing this module does not load any Voice implementation. */
export type PresentationProfile = Readonly<{
  locale: string;
  text: boolean;
  speech: Readonly<{ voiceProfile: string }> | null;
}>;
export type CompanionTextExpression = Readonly<{ expressionId: string; sessionId: string; sourceEventId: string; text: string; locale: string }>;
export interface CompanionTextPort { present(expression: CompanionTextExpression): Promise<void> | void; }
/** Chat-compatible output port; Game may adapt this to its independent speech implementation. */
export interface CompanionSpeechPort { enqueue(expression: Readonly<{ expressionId: string; sessionId: string; sourceEventId: string; text: string; locale: string; voiceProfile: string; epoch: number; expiresAtMs: number }>): Promise<void> | void; }
export type PresentationRuntime = Readonly<{ profile: PresentationProfile; surface?: "chat" | "game"; sessionId: string; textPort?: CompanionTextPort; speechPort?: CompanionSpeechPort }>;
