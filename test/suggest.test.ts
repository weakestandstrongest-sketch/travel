import { describe, expect, it } from "vitest";
import {
  type OverpassElement,
  buildOverpassQuery,
  fetchWikiSummaries,
  parseOverpass,
  simpleHours,
  suggestSpots,
  type Suggestion,
} from "../src/providers/suggest.js";

const kyotoSt = { lat: 34.9858, lng: 135.7588 };

const overpass: { elements: OverpassElement[] } = {
  elements: [
    // 有名なお寺（Wikipedia あり）。点と面の両方で載っている
    { type: "way", id: 1, center: { lat: 34.9949, lon: 135.785 }, tags: { amenity: "place_of_worship", name: "清水寺", "name:en": "Kiyomizu-dera", wikidata: "Q1", wikipedia: "ja:清水寺" } },
    { type: "node", id: 2, lat: 34.995, lon: 135.7851, tags: { tourism: "attraction", name: "清水寺" } },
    { type: "node", id: 3, lat: 35.0142, lon: 135.7481, tags: { historic: "castle", name: "元離宮二条城", wikidata: "Q2", wikipedia: "ja:元離宮二条城", opening_hours: "08:45-17:00" } },
    { type: "node", id: 4, lat: 34.987, lon: 135.759, tags: { tourism: "museum", name: "小さな資料館" } },
    { type: "node", id: 5, lat: 34.99, lon: 135.76, tags: { tourism: "aquarium", name: "京都水族館", wikidata: "Q3" } },
    { type: "node", id: 6, lat: 34.99, lon: 135.76, tags: { tourism: "hotel", name: "ホテル" } },
    { type: "node", id: 7, tags: { tourism: "museum", name: "座標なし" } },
  ],
};

describe("parseOverpass", () => {
  const list = parseOverpass(overpass, kyotoSt);

  it("観光地だけを有名そうな順に並べ、同じ場所はまとめる", () => {
    expect(list.map((s) => s.name)).toEqual(["清水寺", "元離宮二条城", "京都水族館", "小さな資料館"]);
  });

  it("種類・滞在時間・距離・営業時間をつける", () => {
    const byName = Object.fromEntries(list.map((s) => [s.name, s])) as Record<string, Suggestion>;
    expect(byName["清水寺"]).toMatchObject({ category: "temple", stayMinutes: 60, wikipedia: "ja:清水寺" });
    expect(byName["元離宮二条城"]).toMatchObject({ category: "history", open: "08:45", close: "17:00" });
    expect(byName["京都水族館"]).toMatchObject({ category: "fun", stayMinutes: 180 });
    expect(byName["小さな資料館"]?.distanceKm).toBeLessThan(0.2);
  });
});

describe("buildOverpassQuery", () => {
  it("広い範囲では有名な場所（wikidata あり）に絞る", () => {
    expect(buildOverpassQuery(kyotoSt, 2)).toContain('nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"]["name"](around:2000,');
    expect(buildOverpassQuery(kyotoSt, 10)).toContain('["name"]["wikidata"](around:10000,');
  });
});

describe("simpleHours", () => {
  it("単純な営業時間だけ読む", () => {
    expect(simpleHours("9:00-17:00")).toEqual({ open: "09:00", close: "17:00" });
    expect(simpleHours("Mo-Su 08:30-16:30")).toEqual({ open: "08:30", close: "16:30" });
    expect(simpleHours("Tu-Su 09:00-17:00; Mo off")).toEqual({});
    expect(simpleHours(undefined)).toEqual({});
  });
});

describe("suggestSpots", () => {
  it("1つ目のサーバーが落ちていたら次を使う", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? new Response("busy", { status: 429 }) : new Response(JSON.stringify(overpass));
    }) as unknown as typeof fetch;
    const list = await suggestSpots(kyotoSt, 10, fakeFetch);
    expect(urls).toHaveLength(2);
    expect(list[0]?.name).toBe("清水寺");
  });
});

describe("fetchWikiSummaries", () => {
  it("1行説明と写真を、OSM に書かれた記事名で引けるようにする", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          query: {
            redirects: [{ from: "元離宮二条城", to: "二条城" }],
            pages: [
              { title: "清水寺", extract: "清水寺は京都市東山区にある寺院。", thumbnail: { source: "https://upload.example/kiyomizu.jpg" } },
              { title: "二条城", extract: "二条城は京都市中京区にある城。" },
            ],
          },
        }),
      )) as unknown as typeof fetch;
    const list = parseOverpass(overpass, kyotoSt);
    const map = await fetchWikiSummaries(list, fakeFetch);
    expect(map.get("ja:清水寺")?.thumbnail).toBe("https://upload.example/kiyomizu.jpg");
    expect(map.get("ja:元離宮二条城")?.extract).toMatch(/城/);
  });
});
