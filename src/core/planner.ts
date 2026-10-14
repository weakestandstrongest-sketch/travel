import { StraightLineEstimator, type TravelTimeEstimator } from "../providers/estimator.js";
import { addDays, parseHM } from "./time.js";
import type {
  DayPlan,
  Itinerary,
  Move,
  Place,
  Spot,
  TravelMode,
  TripRequest,
  Unscheduled,
  Visit,
} from "./types.js";

export interface PlanOptions {
  estimator?: TravelTimeEstimator;
}

interface Context {
  base: Place;
  mode: TravelMode;
  dayStart: number;
  dayEnd: number;
  estimator: TravelTimeEstimator;
}

interface Simulation {
  feasible: boolean;
  end: number;
  items: Array<Visit | Move>;
}

/**
 * 行きたい場所のリストから日ごとの行程を組み立てる。
 *
 * 方針（ヒューリスティック）:
 *  1. 各日について「日付指定 → must → want」の順に候補を入れていく。
 *     最終日以外は、残りの滞在時間を残り日数で均した量に達したらその日は締める。
 *  2. その日の最初の1件は宿から最も遠い場所を選ぶ（エリアごとに日が分かれやすくなる）。
 *  3. 以降は「宿へ戻る時刻が最も早くなる位置」に1件ずつ挿入する（最安挿入法）。
 *     営業時間・帰着リミットを守れない挿入は採用しない。
 *  4. 最後に 2-opt で訪問順を改善する。
 *  入りきらなかった場所は理由つきで unscheduled に返す。
 */
export function planTrip(req: TripRequest, opts: PlanOptions = {}): Itinerary {
  validateRequest(req);
  const ctx: Context = {
    base: req.base,
    mode: req.mode ?? "transit",
    dayStart: parseHM(req.dayStart ?? "09:00"),
    dayEnd: parseHM(req.dayEnd ?? "19:00"),
    estimator: opts.estimator ?? new StraightLineEstimator(),
  };

  const remaining = new Set<Spot>(req.spots);
  const days: DayPlan[] = [];

  for (let day = 1; day <= req.days; day++) {
    const eligible = (s: Spot) => remaining.has(s) && (s.day === undefined || s.day === day);
    const tiers: Array<(s: Spot) => boolean> = [
      (s) => s.day === day,
      (s) => s.priority === "must",
      () => true,
    ];

    // 余裕があるときに初日へ詰め込みすぎないよう、残りの滞在時間を残り日数で割った分を目安にする
    const daysLeft = req.days - day + 1;
    const share =
      sumStay([...remaining].filter((s) => s.day === undefined || (s.day >= day && s.day <= req.days))) / daysLeft;

    let route: Spot[] = [];
    for (const [tierIndex, tier] of tiers.entries()) {
      for (;;) {
        if (tierIndex > 0 && daysLeft > 1 && sumStay(route) >= share) break;
        const candidates = req.spots.filter((s) => eligible(s) && tier(s));
        const next = route.length === 0 ? pickSeed(candidates, ctx) : pickInsertion(route, candidates, ctx);
        if (!next) break;
        route = next.route;
        remaining.delete(next.spot);
      }
    }
    route = improveByTwoOpt(route, ctx);

    const sim = simulate(route, ctx);
    days.push({
      day,
      date: addDays(req.startDate, day - 1),
      items: sim.items,
      start: ctx.dayStart,
      end: sim.end,
    });
  }

  const unscheduled: Unscheduled[] = [...remaining].map((spot) => ({
    spot,
    reason: unscheduledReason(spot, req.days, ctx),
  }));

  return { request: req, days, unscheduled };
}

function sumStay(spots: Spot[]): number {
  return spots.reduce((sum, s) => sum + s.stayMinutes, 0);
}

function pickSeed(candidates: Spot[], ctx: Context): { route: Spot[]; spot: Spot } | null {
  let best: { route: Spot[]; spot: Spot; distance: number } | null = null;
  for (const spot of candidates) {
    if (!simulate([spot], ctx).feasible) continue;
    const distance = ctx.estimator.estimate(ctx.base, spot, ctx.mode).minutes;
    if (!best || distance > best.distance) best = { route: [spot], spot, distance };
  }
  return best;
}

function pickInsertion(
  route: Spot[],
  candidates: Spot[],
  ctx: Context,
): { route: Spot[]; spot: Spot } | null {
  let best: { route: Spot[]; spot: Spot; end: number } | null = null;
  for (const spot of candidates) {
    for (let i = 0; i <= route.length; i++) {
      const candidate = [...route.slice(0, i), spot, ...route.slice(i)];
      const sim = simulate(candidate, ctx);
      if (sim.feasible && (!best || sim.end < best.end)) {
        best = { route: candidate, spot, end: sim.end };
      }
    }
  }
  return best;
}

function improveByTwoOpt(route: Spot[], ctx: Context): Spot[] {
  let best = route;
  let bestEnd = simulate(route, ctx).end;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const sim = simulate(candidate, ctx);
        if (sim.feasible && sim.end < bestEnd) {
          best = candidate;
          bestEnd = sim.end;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** 宿を出発して route の順に回り、宿へ戻るまでを時刻つきで計算する */
function simulate(route: Spot[], ctx: Context): Simulation {
  const items: Array<Visit | Move> = [];
  let t = ctx.dayStart;
  let pos: Place = ctx.base;

  const move = (to: Place) => {
    const est = ctx.estimator.estimate(pos, to, ctx.mode);
    items.push({
      kind: "move",
      from: pos,
      to,
      depart: t,
      arrive: t + est.minutes,
      minutes: est.minutes,
      distanceKm: est.distanceKm,
      mode: est.mode,
    });
    t += est.minutes;
    pos = to;
  };

  for (const spot of route) {
    move(spot);
    const arrive = t;
    const start = spot.open ? Math.max(arrive, parseHM(spot.open)) : arrive;
    const end = start + spot.stayMinutes;
    if (spot.close && end > parseHM(spot.close)) {
      return { feasible: false, end: Infinity, items };
    }
    items.push({ kind: "visit", spot, arrive, start, end });
    t = end;
  }
  if (route.length > 0) move(ctx.base);

  return { feasible: t <= ctx.dayEnd, end: t, items };
}

function unscheduledReason(spot: Spot, days: number, ctx: Context): string {
  if (spot.day !== undefined && (spot.day < 1 || spot.day > days)) {
    return `指定日（${spot.day}日目）が旅行期間外です`;
  }
  if (!simulate([spot], ctx).feasible) {
    return "宿からの往復と滞在時間が、営業時間または1日の行動時間に収まりません";
  }
  return "時間が足りず入りませんでした（日数を増やす・滞在時間を短くする・優先度を見直す）";
}

function validateRequest(req: TripRequest): void {
  if (!Number.isInteger(req.days) || req.days < 1) {
    throw new Error(`days は1以上の整数で指定してください: ${req.days}`);
  }
  addDays(req.startDate, 0);
  const dayStart = parseHM(req.dayStart ?? "09:00");
  const dayEnd = parseHM(req.dayEnd ?? "19:00");
  if (dayStart >= dayEnd) throw new Error("dayStart は dayEnd より前にしてください");
  assertPlace(req.base, "base");
  for (const spot of req.spots) {
    assertPlace(spot, spot.name);
    if (!(spot.stayMinutes >= 0)) throw new Error(`${spot.name}: stayMinutes が不正です`);
    const open = spot.open ? parseHM(spot.open) : undefined;
    const close = spot.close ? parseHM(spot.close) : undefined;
    if (open !== undefined && close !== undefined && open >= close) {
      throw new Error(`${spot.name}: open は close より前にしてください`);
    }
  }
}

function assertPlace(p: Place, label: string): void {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
    throw new Error(`${label}: 緯度経度がありません（lat / lng を指定するか、ジオコーディングしてください）`);
  }
}
