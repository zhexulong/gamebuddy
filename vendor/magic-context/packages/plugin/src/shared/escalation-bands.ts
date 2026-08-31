export const MAX_EXECUTE_THRESHOLD = 90;
export const ABSOLUTE_EMERGENCY_PERCENTAGE = 95;

export interface EscalationBands {
    forceMaterializationPercentage: number;
    emergencyPercentage: number;
}

/** Keep force cleanup above normal execution while preserving the absolute 95% wall. */
export function escalationBands(effectiveThresholdPercentage: number): EscalationBands {
    const threshold = Number.isFinite(effectiveThresholdPercentage)
        ? Math.min(effectiveThresholdPercentage, MAX_EXECUTE_THRESHOLD)
        : 65;
    return {
        forceMaterializationPercentage: Math.max(85, threshold + 2),
        emergencyPercentage: ABSOLUTE_EMERGENCY_PERCENTAGE,
    };
}
