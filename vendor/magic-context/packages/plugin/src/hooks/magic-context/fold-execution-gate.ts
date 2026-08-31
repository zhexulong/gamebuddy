export function foldExecutesThisPass(foldDue: boolean, materialized: boolean): boolean {
    return foldDue && materialized;
}
