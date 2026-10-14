import { formatHM } from "../core/time.js";
import type { Itinerary, TransitStep, TravelMode } from "../core/types.js";
import { norikaeAppUrl } from "../providers/norikae.js";
import { googleMapsDirectionsUrl, yahooTransitUrl } from "./links.js";

export const MODE_LABEL: Record<TravelMode, string> = {
  transit: "電車・バス",
  walk: "徒歩",
  car: "車",
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

export interface MarkdownOptions {
  /** のりかえの URL。あれば乗換案内のリンクをのりかえにする */
  norikaeUrl?: string;
}

export function toMarkdown(itinerary: Itinerary, opts: MarkdownOptions = {}): string {
  const lines: string[] = [];
  const { request } = itinerary;
  lines.push(`# 旅程（${request.startDate} から ${request.days}日間）`, "");
  lines.push(`宿: ${request.base.name}`, "");

  for (const day of itinerary.days) {
    lines.push(`## ${day.day}日目 ${day.date}（${weekday(day.date)}）`, "");
    if (day.items.length === 0) {
      lines.push("予定なし（自由行動）", "");
      continue;
    }
    for (const item of day.items) {
      if (item.kind === "visit") {
        const wait = item.start - item.arrive;
        const notes = [wait > 0 ? `開場待ち ${wait}分` : "", item.warning ?? ""].filter(Boolean);
        const note = notes.length ? `（${notes.join("・")}）` : "";
        lines.push(`- **${formatHM(item.start)}–${formatHM(item.end)} ${item.spot.name}**${note}`);
      } else {
        const links = [`[Google マップ](${googleMapsDirectionsUrl(item.from, item.to, item.mode)})`];
        if (item.mode === "transit") {
          const depart = formatHM(item.depart);
          links.unshift(
            opts.norikaeUrl
              ? `[のりかえ](${norikaeAppUrl(opts.norikaeUrl, item.from, item.to, day.date, depart)})`
              : `[乗換案内](${yahooTransitUrl(item.from, item.to, day.date, item.depart)})`,
          );
        }
        const how = item.transit
          ? `${item.transit.summary.dep}発 ${transitLines(item.transit.steps)} ${item.transit.summary.arr}着` +
            (item.transit.summary.fare != null ? `・${item.transit.summary.fare.toLocaleString()}円` : "")
          : `${MODE_LABEL[item.mode]} 約${item.minutes}分（${item.distanceKm.toFixed(1)}km）`;
        lines.push(`  - ${formatHM(item.depart)} → ${item.to.name}　${how}　${links.join(" / ")}`);
      }
    }
    lines.push("", `宿に ${formatHM(day.end)} ごろ帰着${day.warning ? `（${day.warning}）` : ""}`, "");
  }

  if (itinerary.unscheduled.length > 0) {
    lines.push("## 入らなかった場所", "");
    for (const { spot, reason } of itinerary.unscheduled) {
      lines.push(`- ${spot.name}: ${reason}`);
    }
    lines.push("");
  }

  const refined = itinerary.days.some((d) => d.items.some((i) => i.kind === "move" && i.transit));
  if (!refined) {
    lines.push("※ 移動時間は直線距離からの概算です。実際の時刻は乗換案内のリンクで確認してください。", "");
  }
  return lines.join("\n");
}

export function transitLines(steps: TransitStep[]): string {
  return steps.flatMap((s) => (s.kind === "access" && !s.walk ? [s.line] : [])).join(" → ");
}
