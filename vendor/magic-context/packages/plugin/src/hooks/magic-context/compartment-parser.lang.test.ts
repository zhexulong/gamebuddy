import { describe, expect, it } from "bun:test";

import { parseCompartmentOutput } from "./compartment-parser";

const FACT_CATEGORIES = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const;

const EVENT_KINDS = ["causal_incident", "trajectory_correction"] as const;

function historianOutput(prose: {
    firstTitle: string;
    firstP1: string;
    firstP2: string;
    firstP3: string;
    secondTitle: string;
    secondP1: string;
    secondP2: string;
    secondP3: string;
    fact: string;
    incidentSummary: string;
    correctionSummary: string;
}): string {
    return `<output>
<compartments>
<compartment start="1" end="4" title="${prose.firstTitle}" episode_type="feature" importance="80">
<p1>${prose.firstP1}</p1>
<p2>${prose.firstP2}</p2>
<p3>${prose.firstP3}</p3>
<p4>src/app.ts</p4>
</compartment>
<compartment start="5" end="7" title="${prose.secondTitle}" episode_type="bug" importance="60">
<p1>${prose.secondP1}</p1>
<p2>${prose.secondP2}</p2>
<p3>${prose.secondP3}</p3>
<p4>packages/plugin</p4>
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* ${prose.fact}
</PROJECT_RULES>
</facts>
<events>
<causal_incident at_compartment="1">
<summary>${prose.incidentSummary}</summary>
<disposition>fixed</disposition>
<evidence>TC: bun test</evidence>
</causal_incident>
<trajectory_correction at_compartment="2">
<summary>${prose.correctionSummary}</summary>
<correction_source>user</correction_source>
<correction_signal>U: please narrow the test</correction_signal>
</trajectory_correction>
</events>
</output>`;
}

function shapeOf(output: string) {
    const parsed = parseCompartmentOutput(output);
    return {
        compartments: parsed.compartments.map((c) => ({
            start: c.startMessage,
            end: c.endMessage,
            episodeType: c.episodeType,
            hasTiers: Boolean(c.p1 && c.p2 && c.p3 && c.p4 !== undefined),
        })),
        factCategories: parsed.facts.map((f) => f.category),
        eventKinds: parsed.events.map((event) => event.kind),
    };
}

describe("parseCompartmentOutput with localized prose", () => {
    const english = historianOutput({
        firstTitle: "Language config work",
        firstP1: "The user asked for a language option and the code added prompt guidance.",
        firstP2: "Added directive plumbing.",
        firstP3: "Feature path is ready for tests.",
        secondTitle: "Parser guard",
        secondP1: "A regression test keeps structural tokens in English.",
        secondP2: "Tool results were checked.",
        secondP3: "The next step is verification.",
        fact: "Keep XML tags and enum names in English.",
        incidentSummary: "The first prompt forgot a runtime seam.",
        correctionSummary: "The user narrowed the requirement to synthetic fixtures.",
    });

    it("extracts the same structural shape from Turkish prose", () => {
        const turkish = historianOutput({
            firstTitle: "Dil ayarı çalışması",
            firstP1: "Kullanıcı dil seçeneği istedi ve kod istem yönlendirmesi ekledi.",
            firstP2: "Yönerge akışı eklendi.",
            firstP3: "Özellik testlere hazır.",
            secondTitle: "Ayrıştırıcı koruması",
            secondP1: "Regresyon testi yapısal belirteçleri İngilizce tutar.",
            secondP2: "Araç sonuçları incelendi.",
            secondP3: "Sonraki adım doğrulama.",
            fact: "XML etiketleri ve enum adları İngilizce kalsın.",
            incidentSummary: "İlk istem bir çalışma zamanı noktasını kaçırdı.",
            correctionSummary: "Kullanıcı gereksinimi sentetik örneklere daralttı.",
        });

        const shape = shapeOf(turkish);
        expect(shape).toEqual(shapeOf(english));
        expect(shape.factCategories.every((category) => FACT_CATEGORIES.includes(category))).toBe(
            true,
        );
        expect(shape.eventKinds.every((kind) => EVENT_KINDS.includes(kind))).toBe(true);
    });

    it("extracts the same structural shape from Spanish prose", () => {
        const spanish = historianOutput({
            firstTitle: "Trabajo de configuración de idioma",
            firstP1: "El usuario pidió una opción de idioma y el código agregó guía de prompt.",
            firstP2: "Se agregó el flujo de la directiva.",
            firstP3: "La función está lista para pruebas.",
            secondTitle: "Protección del parser",
            secondP1: "Una prueba de regresión mantiene los tokens estructurales en inglés.",
            secondP2: "Se revisaron los resultados de herramientas.",
            secondP3: "El siguiente paso es la verificación.",
            fact: "Mantener etiquetas XML y nombres de enum en inglés.",
            incidentSummary: "El primer prompt omitió una unión de ejecución.",
            correctionSummary: "El usuario limitó el requisito a fixtures sintéticos.",
        });

        const shape = shapeOf(spanish);
        expect(shape).toEqual(shapeOf(english));
        expect(shape.factCategories.every((category) => FACT_CATEGORIES.includes(category))).toBe(
            true,
        );
        expect(shape.eventKinds.every((kind) => EVENT_KINDS.includes(kind))).toBe(true);
    });
});
