export const CONFIG_SAVE_REFUSAL_MESSAGE =
  "Refusing to save — existing config couldn't be read or parsed; fix or delete it first.";

export interface ConfigSaveGuardInput {
  exists: boolean;
  readError?: string | null;
  parseError?: string | null;
}

export function configSaveBlocker(input: ConfigSaveGuardInput): string | null {
  if (!input.exists) {
    return null;
  }
  if (input.readError) {
    return `${CONFIG_SAVE_REFUSAL_MESSAGE} Read error: ${input.readError}`;
  }
  if (input.parseError) {
    return `${CONFIG_SAVE_REFUSAL_MESSAGE} Parse error: ${input.parseError}`;
  }
  return null;
}

export function assertConfigSaveAllowed(input: ConfigSaveGuardInput): void {
  const blocker = configSaveBlocker(input);
  if (blocker) {
    throw new Error(blocker);
  }
}
