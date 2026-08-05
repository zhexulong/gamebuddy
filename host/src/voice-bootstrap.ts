import { LocalVoiceGatewayClient, type VoiceGatewayConnection } from "./voice-gateway-client.js";

export type VoiceConnection = Pick<LocalVoiceGatewayClient, "health" | "close">;

/**
 * Acquire and health-check a local Voice port as one resource transaction.
 * A failed probe must not leave an authenticated local socket alive.
 */
export async function connectHealthyVoiceGateway(
  config: VoiceGatewayConnection | undefined,
): Promise<LocalVoiceGatewayClient | undefined> {
  return connectHealthyVoiceGatewayWith(config, LocalVoiceGatewayClient.connect);
}

/** Injectable resource-transaction seam for the local bootstrap test. */
export async function connectHealthyVoiceGatewayWith<T extends VoiceConnection>(
  config: VoiceGatewayConnection | undefined,
  connect: (config: VoiceGatewayConnection) => Promise<T>,
): Promise<T | undefined> {
  if (config === undefined) return undefined;
  const voice = await connect(config);
  try {
    await voice.health();
    return voice;
  } catch (error) {
    voice.close();
    throw error;
  }
}
