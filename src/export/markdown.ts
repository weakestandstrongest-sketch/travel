import { formatHM } from "../core/time.js";
import type { Itinerary, TravelMode } from "../core/types.js";
import { googleMapsDirectionsUrl, yahooTransitUrl } from "./links.js";

const MODE_LABEL: Record<TravelMode, string> = {
  transit: "電車・バス",
  walk: "徒歩",
  car: "車",
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

export function toMarkdown(itinerary: Itinerary): string {
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
        const waitNote = wait > 0 ? `（開場待ち ${wait}分）` : "";
        lines.push(`- **${formatHM(item.start)}–${formatHM(item.end)} ${item.spot.name}**${waitNote}`);
      } else {
        const links = [`[Google マップ](${googleMapsDirectionsUrl(item.from, item.to, item.mode)})`];
        if (item.mode === "transit") {
          links.unshift(`[乗換案内](${yahooTransitUrl(item.from, item.to, day.date, item.depart)})`);
        }
        lines.push(
          `  - ${formatHM(item.depart)} 発 → ${item.to.name}　${MODE_LABEL[item.mode]} 約${item.minutes}分` +
            `（${item.distanceKm.toFixed(1)}km）　${links.join(" / ")}`,
        );
      }
    }
    lines.push("", `宿に ${formatHM(day.end)} ごろ帰着`, "");
  }

  if (itinerary.unscheduled.length > 0) {
    lines.push("## 入らなかった場所", "");
    for (const { spot, reason } of itinerary.unscheduled) {
      lines.push(`- ${spot.name}: ${reason}`);
    }
    lines.push("");
  }

  lines.push("※ 移動時間は直線距離からの概算です。実際の時刻は乗換案内のリンクで確認してください。", "");
  return lines.join("\n");
}
