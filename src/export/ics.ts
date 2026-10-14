import type { Itinerary } from "../core/types.js";

/**
 * iCalendar (.ics) 形式に変換する。Google カレンダー / iPhone のカレンダーなど
 * 多くのカレンダーアプリに取り込める。時刻は現地時刻（フローティングタイム）で出力する。
 */
export function toIcs(itinerary: Itinerary, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//travel-planner//JA", "CALSCALE:GREGORIAN"];

  for (const day of itinerary.days) {
    for (const [i, item] of day.items.entries()) {
      if (item.kind !== "visit") continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${day.date}-${i}-${stamp}@travel-planner`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsDateTime(day.date, item.start)}`,
        `DTEND:${icsDateTime(day.date, item.end)}`,
        `SUMMARY:${escapeText(item.spot.name)}`,
        `GEO:${item.spot.lat};${item.spot.lng}`,
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function icsDateTime(date: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${date.replace(/-/g, "")}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`;
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
