import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTrip } from "../src/core/planner.js";
import { parseHM } from "../src/core/time.js";
import type { Spot, TripRequest, Visit } from "../src/core/types.js";

const kyoto = JSON.parse(readFileSync(new URL("../examples/kyoto.json", import.meta.url), "utf8")) as TripRequest;

const visits = (req: TripRequest) =>
  planTrip(req).days.flatMap((d) => d.items.filter((i): i is Visit => i.kind === "visit").map((v) => ({ day: d.day, v })));

describe("planTrip", () => {
  it("京都の例ですべての場所を2日に割り振る", () => {
    const plan = planTrip(kyoto);
    expect(plan.unscheduled).toEqual([]);
    expect(plan.days.map((d) => d.date)).toEqual(["2026-11-21", "2026-11-22"]);
    expect(visits(kyoto)).toHaveLength(kyoto.spots.length);
    // 日ごとの偏りが大きすぎない
    for (const day of plan.days) expect(day.items.some((i) => i.kind === "visit")).toBe(true);
  });

  it("営業時間と帰着リミットを守る", () => {
    const plan = planTrip(kyoto);
    for (const day of plan.days) {
      expect(day.end).toBeLessThanOrEqual(parseHM(kyoto.dayEnd!));
      for (const item of day.items) {
        if (item.kind !== "visit") continue;
        if (item.spot.open) expect(item.start).toBeGreaterThanOrEqual(parseHM(item.spot.open));
        if (item.spot.close) expect(item.end).toBeLessThanOrEqual(parseHM(item.spot.close));
      }
    }
  });

  it("時刻が連続している（移動の到着 = 次の予定の到着）", () => {
    for (const day of planTrip(kyoto).days) {
      let t = day.start;
      for (const item of day.items) {
        if (item.kind === "move") {
          expect(item.depart).toBe(t);
          t = item.arrive;
        } else {
          expect(item.arrive).toBe(t);
          t = item.end;
        }
      }
      expect(t).toBe(day.end);
    }
  });

  it("日付指定を守る", () => {
    const req: TripRequest = {
      ...kyoto,
      spots: kyoto.spots.map((s) => (s.name === "金閣寺" ? { ...s, day: 1 } : s)),
    };
    const kinkaku = visits(req).find(({ v }) => v.spot.name === "金閣寺");
    expect(kinkaku?.day).toBe(1);
  });

  it("時間が足りないときは must を優先し、残りを理由つきで返す", () => {
    const base = kyoto.base;
    const spot = (name: string, priority: Spot["priority"]): Spot => ({
      name,
      lat: base.lat + 0.001,
      lng: base.lng,
      stayMinutes: 240,
      priority,
    });
    const req: TripRequest = {
      ...kyoto,
      days: 1,
      spots: [spot("A", "want"), spot("B", "want"), spot("C", "must")],
    };
    const plan = planTrip(req);
    expect(visits(req).map(({ v }) => v.spot.name)).toContain("C");
    expect(plan.unscheduled).toHaveLength(1);
    expect(plan.unscheduled[0]?.reason).toMatch(/時間が足りず/);
  });

  it("どうやっても入らない場所・期間外の日付指定は理由を返す", () => {
    const req: TripRequest = {
      ...kyoto,
      spots: [
        { name: "長すぎ", lat: 35, lng: 135.76, stayMinutes: 700 },
        { name: "期間外", lat: 35, lng: 135.76, stayMinutes: 30, day: 5 },
      ],
    };
    const reasons = Object.fromEntries(planTrip(req).unscheduled.map((u) => [u.spot.name, u.reason]));
    expect(reasons["長すぎ"]).toMatch(/収まりません/);
    expect(reasons["期間外"]).toMatch(/期間外/);
  });

  it("開場前に着いたら待つ", () => {
    const req: TripRequest = {
      ...kyoto,
      days: 1,
      spots: [{ name: "朝遅い店", lat: 34.986, lng: 135.759, stayMinutes: 30, open: "11:00" }],
    };
    const v = visits(req)[0]!.v;
    expect(v.arrive).toBeLessThan(parseHM("11:00"));
    expect(v.start).toBe(parseHM("11:00"));
  });

  it("不正な入力はエラーにする", () => {
    expect(() => planTrip({ ...kyoto, days: 0 })).toThrow(/days/);
    expect(() => planTrip({ ...kyoto, dayStart: "20:00" })).toThrow(/dayStart/);
    expect(() => planTrip({ ...kyoto, spots: [{ name: "x", lat: NaN, lng: 0, stayMinutes: 10 }] })).toThrow(/緯度経度/);
  });
});
