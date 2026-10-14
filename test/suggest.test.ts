import { describe, expect, it } from "vitest";
import {
  type OverpassElement,
  buildOverpassQuery,
  buildWikidataQuery,
  parseWikidata,
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
    expect(buildOverpassQuery(kyotoSt, 2)).toContain('nw["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"]["name"](around:2000,');
    expect(buildOverpassQuery(kyotoSt, 10)).toContain('["name"]["wikidata"](around:10000,');
    const wide = buildOverpassQuery(kyotoSt, 50);
    expect(wide).toContain('nw["amenity"="place_of_worship"]["name"]["wikipedia"]["name:en"](around:50000,');
    expect(wide).not.toContain('["name"]["wikidata"]');
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

const wikidata = {
  results: {
    bindings: [
      // 同じ寺が2つの種類で返ってくる
      { item: { value: "http://www.wikidata.org/entity/Q1" }, label: { value: "清水寺" }, loc: { value: "Point(135.785 34.9949)" }, class: { value: "http://www.wikidata.org/entity/Q5393308" }, links: { value: "52" }, article: { value: "https://ja.wikipedia.org/wiki/%E6%B8%85%E6%B0%B4%E5%AF%BA" } },
      { item: { value: "http://www.wikidata.org/entity/Q1" }, label: { value: "清水寺" }, loc: { value: "Point(135.785 34.9949)" }, class: { value: "http://www.wikidata.org/entity/Q570116" }, links: { value: "52" } },
      { item: { value: "http://www.wikidata.org/entity/Q2" }, label: { value: "大阪城" }, loc: { value: "Point(135.5259 34.6873)" }, class: { value: "http://www.wikidata.org/entity/Q92026" }, links: { value: "60" }, article: { value: "https://ja.wikipedia.org/wiki/%E5%A4%A7%E9%98%AA%E5%9F%8E" } },
      { item: { value: "http://www.wikidata.org/entity/Q3" }, label: { value: "京都水族館" }, loc: { value: "Point(135.747 34.9875)" }, class: { value: "http://www.wikidata.org/entity/Q2281788" }, links: { value: "8" } },
      { item: { value: "http://www.wikidata.org/entity/Q4" }, label: { value: "知らない種類" }, loc: { value: "Point(135.7 34.9)" }, class: { value: "http://www.wikidata.org/entity/Q999" }, links: { value: "99" } },
    ],
  },
};

describe("Wikidata", () => {
  it("有名な順（Wikipedia の言語数）に並べ、同じ場所はまとめる", () => {
    const list = parseWikidata(wikidata, kyotoSt);
    expect(list.map((s) => s.name)).toEqual(["大阪城", "清水寺", "京都水族館"]);
    expect(list[1]).toMatchObject({ category: "temple", wikipedia: "ja:清水寺", lat: 34.9949, lng: 135.785, stayMinutes: 60 });
    expect(list[0]?.category).toBe("history");
  });

  it("中心・半径・有名さのしきいを問い合わせに入れる", () => {
    const q = buildWikidataQuery({ lat: 34.816, lng: 135.562 }, 50);
    expect(q).toContain('"Point(135.562 34.816)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:radius "50"');
    expect(q).toContain("FILTER(?links >= 10)");
  });
});

describe("suggestSpots", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("Wikidata を先に使う", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => (urls.push(url), json(wikidata))) as unknown as typeof fetch;
    const list = await suggestSpots(kyotoSt, 10, fakeFetch);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).hostname).toBe("query.wikidata.org");
    expect(list[0]?.name).toBe("大阪城");
  });

  it("Wikidata がだめなら OpenStreetMap、1つ目のサーバーが落ちていたら次を使う", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("wikidata")) return json({}, 500);
      return urls.length === 2 ? new Response("busy", { status: 429 }) : json(overpass);
    }) as unknown as typeof fetch;
    const list = await suggestSpots(kyotoSt, 10, fakeFetch);
    expect(urls).toHaveLength(3);
    expect(list[0]?.name).toBe("清水寺");
  });

  it("どちらもだめなら理由をまとめて知らせる", async () => {
    const fakeFetch = (async (url: string) => {
      if (url.includes("wikidata")) return json({}, 503);
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;
    await expect(suggestSpots(kyotoSt, 10, fakeFetch)).rejects.toThrow(/Wikidata: Wikidata HTTP 503、OpenStreetMap: overpass-api.de Load failed/);
  });

  it("どちらも0件なら空", async () => {
    const fakeFetch = (async (url: string) => json(url.includes("wikidata") ? { results: { bindings: [] } } : { elements: [] })) as unknown as typeof fetch;
    expect(await suggestSpots(kyotoSt, 2, fakeFetch)).toEqual([]);
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
