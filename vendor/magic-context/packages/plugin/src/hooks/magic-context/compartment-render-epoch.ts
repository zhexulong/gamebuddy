export const COMPARTMENT_RENDER_EPOCH = "cre2";

const EPOCH_COMPONENT_PREFIX = "|compartment-render:";

export interface CachedM0UpgradeIdentity {
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
}

/**
 * Store the compartment renderer epoch in the existing cached upgrade-state marker.
 * Renderer byte changes must change this identity so each cached m[0] folds exactly once.
 */
export function encodeCachedM0UpgradeIdentity(
    upgradeState: string | null,
    compartmentRenderEpoch: string | null = COMPARTMENT_RENDER_EPOCH,
): string | null {
    if (compartmentRenderEpoch === null) return upgradeState;
    return `${upgradeState ?? ""}${EPOCH_COMPONENT_PREFIX}${compartmentRenderEpoch}`;
}

export function decodeCachedM0UpgradeIdentity(value: string | null): CachedM0UpgradeIdentity {
    if (value === null) {
        return { upgradeState: null, compartmentRenderEpoch: null };
    }
    const componentIndex = value.lastIndexOf(EPOCH_COMPONENT_PREFIX);
    if (componentIndex < 0) {
        return { upgradeState: value, compartmentRenderEpoch: null };
    }
    const upgradeState = value.slice(0, componentIndex);
    const compartmentRenderEpoch = value.slice(componentIndex + EPOCH_COMPONENT_PREFIX.length);
    return {
        upgradeState: upgradeState.length > 0 ? upgradeState : null,
        compartmentRenderEpoch: compartmentRenderEpoch.length > 0 ? compartmentRenderEpoch : null,
    };
}
