import { migrateMagicContextConfigLocations } from "@magic-context/core/config/migrate-config-location";

export interface ConfigLocationMigrationLogSink {
    warn(message: string): void;
    info?(message: string): void;
    message?(message: string): void;
}

export function migrateConfigLocationsForCli(
    cwd: string,
    logs: ConfigLocationMigrationLogSink,
): string[] {
    return migrateMagicContextConfigLocations(cwd, {
        warn: (message) => logs.warn(message),
        info: (message) => (logs.info ?? logs.message)?.(message),
    });
}

export function hasUserConfigLocationMigrationRefusal(warnings: readonly string[]): boolean {
    return warnings.some((warning) =>
        warning.includes("Magic Context user config migration refused"),
    );
}
