import { formatHM } from "../core/time.js";
import type { Itinerary, Move, Visit } from "../core/types.js";
import { norikaeAppUrl, transitName } from "../providers/norikae.js";

export interface IcsOptions {
  /** 移動も予定にする（既定 true。10分未満の徒歩は入れない） */
  includeMoves?: boolean;
  /** のりかえの URL。あれば移動の予定のメモにリンクを入れる */
  norikaeUrl?: string;
  now?: Date;
}

const MODE_LABEL = { transit: "電車・バス", walk: "徒歩", car: "車" } as const;

/**
 * iCalendar (.ics) 形式に変換する。ひび手帳（設定 → .ics ファイルを読み込む）や
 * iPhone / Google のカレンダーに取り込める。時刻は現地時刻（フローティングタイム）で出力する。
 * UID は内容から決めるので、同じ旅程を2回取り込んでもひび手帳では重複しない。
 */
export function toIcs(itinerary: Itinerary, opts: IcsOptions = {}): string {
  const stamp = icsUtc(opts.now ?? new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//travel-planner//JA", "CALSCALE:GREGORIAN"];

  for (const day of itinerary.days) {
    for (const item of day.items) {
      let event: { start: number; end: number; summary: string; location?: string; description: string } | null;
      if (item.kind === "visit") {
        event = { start: item.start, end: item.end, summary: item.spot.name, location: item.spot.name, description: visitNote(item) };
      } else if (opts.includeMoves !== false && (item.mode !== "walk" || item.minutes >= 10)) {
        event = {
          start: item.depart,
          end: item.arrive,
          summary: `${transitName(item.from)} → ${transitName(item.to)}`,
          description: moveNote(item, day.date, opts.norikaeUrl),
        };
      } else {
        event = null;
      }
      if (!event || event.end <= event.start) continue;

      lines.push(
        "BEGIN:VEVENT",
        `UID:${day.date.replace(/-/g, "")}-${hash(`${event.start}|${event.end}|${event.summary}`)}@travel-planner`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsLocal(day.date, event.start)}`,
        `DTEND:${icsLocal(day.date, event.end)}`,
        `SUMMARY:${escapeText(event.summary)}`,
      );
      if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
      if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
      if (item.kind === "visit") lines.push(`GEO:${item.spot.lat};${item.spot.lng}`);
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function visitNote(v: Visit): string {
  const notes = [`滞在 ${v.spot.stayMinutes}分`];
  if (v.start > v.arrive) notes.push(`${formatHM(v.arrive)}着・開場待ち ${v.start - v.arrive}分`);
  if (v.warning) notes.push(v.warning);
  return notes.join("\n");
}

function moveNote(m: Move, date: string, norikaeUrl?: string): string {
  const notes: string[] = [];
  if (m.transit) {
    const s = m.transit.summary;
    for (const step of m.transit.steps) {
      if (step.kind === "station") {
        notes.push([step.arr && `${step.arr}着`, step.dep && `${step.dep}発`, step.name].filter(Boolean).join(" "));
      } else {
        notes.push(`　${[step.line, step.destination, step.platform].filter(Boolean).join(" ")}`);
      }
    }
    notes.push(
      [s.duration, s.transfers != null ? `乗換${s.transfers}回` : "", s.fare != null ? `${s.fare.toLocaleString()}円` : ""]
        .filter(Boolean)
        .join("・"),
    );
  } else {
    notes.push(`${MODE_LABEL[m.mode]}で約${m.minutes}分（概算）`);
    if (m.transitNote) notes.push(m.transitNote);
  }
  if (norikaeUrl && m.mode === "transit") {
    notes.push(`のりかえ: ${norikaeAppUrl(norikaeUrl, m.from, m.to, date, formatHM(m.depart))}`);
  }
  return notes.join("\n");
}

function icsLocal(date: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${date.replace(/-/g, "")}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`;
}

function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 の行の折り返し（75オクテットごと。UTF-8 の文字の途中では切らない） */
function fold(line: string): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** 短い安定したハッシュ（FNV-1a） */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
