import { describe, expect, it } from "vitest";
import { addDays, formatHM, parseHM } from "../src/core/time.js";
import { toIcs } from "../src/export/ics.js";
import { googleMapsDirectionsUrl, yahooTransitUrl } from "../src/export/links.js";
import { planTrip } from "../src/core/planner.js";
import { StraightLineEstimator } from "../src/providers/estimator.js";
import { NominatimGeocoder, resolveCoordinates } from "../src/providers/geocoder.js";

const kyotoSt = { name: "京都駅", station: "京都", lat: 34.9858, lng: 135.7588 };
const kiyomizu = { name: "清水寺", station: "清水五条", lat: 34.9949, lng: 135.785 };

describe("time", () => {
  it("時刻と日付を変換する", () => {
    expect(parseHM("09:05")).toBe(545);
    expect(formatHM(545)).toBe("09:05");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => parseHM("9時")).toThrow();
  });
});

describe("StraightLineEstimator", () => {
  const est = new StraightLineEstimator();
  it("近距離は徒歩、遠距離は電車・バス", () => {
    expect(est.estimate(kyotoSt, { lat: 34.9878, lng: 135.7588 }, "transit").mode).toBe("walk");
    const far = est.estimate(kyotoSt, kiyomizu, "transit");
    expect(far.mode).toBe("transit");
    expect(far.minutes).toBeGreaterThan(10);
  });
});

describe("links", () => {
  it("乗換案内のリンクに駅名と出発時刻を入れる", () => {
    const url = new URL(yahooTransitUrl(kyotoSt, kiyomizu, "2026-11-21", parseHM("10:57")));
    expect(url.hostname).toBe("transit.yahoo.co.jp");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      from: "京都",
      to: "清水五条",
      y: "2026",
      m: "11",
      d: "21",
      hh: "10",
      m1: "5",
      m2: "7",
    });
  });

  it("Google マップのリンクは緯度経度を使う", () => {
    const url = new URL(googleMapsDirectionsUrl(kyotoSt, kiyomizu, "walk"));
    expect(url.searchParams.get("destination")).toBe("34.9949,135.785");
    expect(url.searchParams.get("travelmode")).toBe("walking");
  });
});

describe("toIcs", () => {
  it("訪問ごとに予定を作る", () => {
    const itinerary = planTrip({
      startDate: "2026-11-21",
      days: 1,
      base: kyotoSt,
      spots: [{ ...kiyomizu, name: "清水寺, 本堂", stayMinutes: 60 }],
    });
    const ics = toIcs(itinerary, { now: new Date("2026-10-14T00:00:00Z"), includeMoves: false });
    expect(ics).toContain("\r\n");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("SUMMARY:清水寺\\, 本堂");
    expect(ics).toMatch(/DTSTART:20261121T09\d{4}/);
  });
});

describe("geocoder", () => {
  it("緯度経度がない場所だけ引く", async () => {
    const asked: string[] = [];
    const req = await resolveCoordinates(
      {
        startDate: "2026-11-21",
        days: 1,
        base: kyotoSt,
        spots: [{ name: "清水寺", stayMinutes: 60 }],
      },
      { geocode: async (q) => (asked.push(q), { lat: 1, lng: 2 }) },
    );
    expect(asked).toEqual(["清水寺"]);
    expect(req.spots[0]).toMatchObject({ name: "清水寺", lat: 1, lng: 2, stayMinutes: 60 });
  });

  it("見つからなければエラー", async () => {
    await expect(
      resolveCoordinates(
        { startDate: "2026-11-21", days: 1, base: { name: "どこか" }, spots: [] },
        { geocode: async () => null },
      ),
    ).rejects.toThrow(/見つかりませんでした/);
  });

  it("Nominatim の応答を緯度経度に変換する", async () => {
    let requested = "";
    const fakeFetch = (async (url: string) => {
      requested = url;
      return new Response(JSON.stringify([{ lat: "34.99", lon: "135.78" }]));
    }) as unknown as typeof fetch;
    const g = new NominatimGeocoder({ userAgent: "test", fetch: fakeFetch, minIntervalMs: 0 });
    expect(await g.geocode("清水寺")).toEqual({ lat: 34.99, lng: 135.78 });
    expect(new URL(requested).searchParams.get("q")).toBe("清水寺");
  });
});
