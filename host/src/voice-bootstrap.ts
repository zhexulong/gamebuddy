import { LocalVoiceGatewayClient, type VoiceGatewayConnection } from "./voice-gateway-client.js";

export type VoiceConnection = Readonly<{
  health: (voiceProfile?: string) => Promise<unknown>;
  close: () => void | Promise<void>;
}>;

/**
 * Acquire and health-check a local Voice port as one resource transaction.
 * A failed probe must not leave an authenticated local socket alive.
 */
export async function connectHealthyVoiceGateway(
  config: VoiceGatewayConnection | undefined,
  voiceProfile?: string,
): Promise<LocalVoiceGatewayClient | undefined> {
  return connectHealthyVoiceGatewayWith(config, LocalVoiceGatewayClient.connect, voiceProfile);
}

/** Injectable resource-transaction seam for the local bootstrap test. */
export async function connectHealthyVoiceGatewayWith<T extends VoiceConnection>(
  config: VoiceGatewayConnection | undefined,
  connect: (config: VoiceGatewayConnection) => Promise<T>,
  voiceProfile?: string,
): Promise<T | undefined> {
  if (config === undefined) return undefined;
  const voice = await connect(config);
  try {
    await voice.health(voiceProfile);
    return voice;
  } catch (error) {
    try {
      await voice.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "voice_gateway_health_failed_and_close_failed");
    }
    throw error;
  }
}
