export type PassDegradationKind = "degraded" | "fatal";

export interface PassDegradation {
    site: string;
    kind: PassDegradationKind;
}

export interface PassOutcome {
    degradations: PassDegradation[];
    finalized: boolean;
    record(site: string, kind?: PassDegradationKind): void;
    markFinalized(): void;
    readonly captureEligible: boolean;
    isCaptureEligible(): boolean;
}

export function createPassOutcome(): PassOutcome {
    const degradations: PassDegradation[] = [];
    let finalized = false;
    return {
        degradations,
        get finalized() {
            return finalized;
        },
        record(site, kind = "degraded") {
            degradations.push({ site, kind });
        },
        markFinalized() {
            finalized = true;
        },
        get captureEligible() {
            return finalized && degradations.length === 0;
        },
        isCaptureEligible() {
            return finalized && degradations.length === 0;
        },
    };
}
