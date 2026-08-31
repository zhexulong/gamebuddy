/**
 * Tiny, dependency-free cron helpers for the dreamer schedule UI.
 *
 * `describeCron` renders a human-readable summary for the common 5-field cron
 * shapes the dreamer UI produces (presets + simple custom entries). It is
 * deliberately CONSERVATIVE: anything it can't confidently describe falls back to
 * the raw expression rather than risk a wrong description. The plugin's cron
 * evaluator remains authoritative for actual scheduling.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Loose 5-field shape check for inline UI feedback (not full cron validation). */
export function isValidCronShape(value: string): boolean {
  const v = value.trim();
  if (v === "") return true; // empty = disabled, valid
  const fields = v.split(/\s+/);
  if (fields.length !== 5) return false;
  // Each field is one of: *, */n, a, a-b, a,b,c (digits only here — the plugin
  // does the authoritative parse; this just rejects obvious garbage).
  return fields.every((f) => /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/.test(f));
}

function fmtTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute.toString().padStart(2, "0");
  return `${h12}:${mm} ${period}`;
}

/** Human-readable description, or the raw cron when not confidently describable. */
export function describeCron(cron: string): string {
  const v = cron.trim();
  if (v === "") return "Disabled";
  if (!isValidCronShape(v)) return v;

  const [minute, hour, dom, month, dow] = v.split(/\s+/);

  // Every N minutes — "*/15 * * * *"
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${minStep[1]} minutes`;
  }
  // Every minute
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  // Every N hours on the minute — "0 */6 * * *"
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && hourStep && dom === "*" && month === "*" && dow === "*") {
    const m = Number(minute);
    const at = m === 0 ? "" : ` at minute ${m}`;
    return `Every ${hourStep[1]} hours${at}`;
  }
  // Hourly — "0 * * * *"
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const m = Number(minute);
    return m === 0 ? "Every hour" : `Every hour at minute ${m}`;
  }

  // Fixed time-of-day cases need numeric minute + hour.
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const m = Number(minute);
    const h = Number(hour);
    if (m < 60 && h < 24) {
      const time = fmtTime(h, m);
      // Daily — "0 3 * * *"
      if (dom === "*" && month === "*" && dow === "*") return `Every day at ${time}`;
      // Weekly on one weekday — "0 4 * * 0"
      if (dom === "*" && month === "*" && /^\d+$/.test(dow)) {
        const d = Number(dow) % 7;
        return `Every ${DAY_NAMES[d]} at ${time}`;
      }
      // Monthly on a day-of-month — "0 3 1 * *"
      if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
        const d = Number(dom);
        const ord = d === 1 ? "1st" : d === 2 ? "2nd" : d === 3 ? "3rd" : `${d}th`;
        return `Monthly on the ${ord} at ${time}`;
      }
    }
  }

  // Confidently un-describable → show the raw cron (never guess wrong).
  return v;
}
