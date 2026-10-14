import { formatHM, parseHM } from "./time.js";
import type { DayPlan, Itinerary, Move, Place, TransitRoute, Visit } from "./types.js";

/** 実際の電車の経路を調べる（のりかえ など） */
export interface TransitProvider {
  /** date の depart 以降に出発する経路。見つからなければ null */
  route(from: Place, to: Place, date: string, depart: string): Promise<TransitRoute | null>;
}

export interface RefineOptions {
  /** 1区間調べるごとに呼ばれる（進み具合の表示用） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 概算で組んだ旅程の電車移動を、実際の電車で調べ直して時刻を組み直す。
 * 訪問の順番は変えない。営業時間や帰着リミットに間に合わなくなったら warning をつける。
 * 調べられなかった区間は概算のまま残す。
 */
export async function refineWithTransit(
  itinerary: Itinerary,
  provider: TransitProvider,
  opts: RefineOptions = {},
): Promise<Itinerary> {
  const total = itinerary.days.reduce(
    (n, d) => n + d.items.filter((i) => i.kind === "move" && i.mode === "transit").length,
    0,
  );
  let done = 0;
  const dayEnd = parseHM(itinerary.request.dayEnd ?? "19:00");

  const days: DayPlan[] = [];
  for (const day of itinerary.days) {
    const items: Array<Visit | Move> = [];
    let t = day.start;
    for (const item of day.items) {
      if (item.kind === "move") {
        let move: Move = { ...item, depart: t, arrive: t + item.minutes, transit: undefined, transitNote: undefined };
        if (item.mode === "transit") {
          try {
            const route = await provider.route(item.from, item.to, day.date, formatHM(t));
            if (route && /^\d{1,2}:\d{2}$/.test(route.summary.arr)) {
              let arrive = parseHM(route.summary.arr);
              if (arrive < t) arrive += 24 * 60; // 日付をまたいだ
              move = { ...move, arrive, minutes: arrive - t, transit: route };
            } else {
              move.transitNote = "経路が見つからなかったので概算です";
            }
          } catch {
            move.transitNote = "乗換案内につながらなかったので概算です";
          }
          opts.onProgress?.(++done, total);
        }
        items.push(move);
        t = move.arrive;
      } else {
        const { spot } = item;
        const start = spot.open ? Math.max(t, parseHM(spot.open)) : t;
        const end = start + spot.stayMinutes;
        const visit: Visit = { kind: "visit", spot, arrive: t, start, end };
        if (spot.close && end > parseHM(spot.close)) {
          visit.warning = `閉場（${spot.close}）までに見終わりません`;
        }
        items.push(visit);
        t = end;
      }
    }
    const refined: DayPlan = { ...day, items, end: t };
    if (t > dayEnd) refined.warning = `宿に戻るのが ${formatHM(t)} になり、予定（${formatHM(dayEnd)}）より遅れます`;
    days.push(refined);
  }
  return { ...itinerary, days };
}
