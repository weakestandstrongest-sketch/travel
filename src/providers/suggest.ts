import { haversineKm } from "../core/geo.js";
import type { LatLng } from "../core/types.js";

export type SuggestCategory = "temple" | "history" | "museum" | "nature" | "fun" | "sight";

export const CATEGORY_LABEL: Record<SuggestCategory, string> = {
  temple: "神社・お寺",
  history: "城・史跡",
  museum: "博物館・美術館",
  nature: "公園・自然・景色",
  fun: "テーマパーク・動物園",
  sight: "名所",
};

/** 種類ごとの目安の滞在時間（分） */
const DEFAULT_STAY: Record<SuggestCategory, number> = {
  temple: 60,
  history: 90,
  museum: 90,
  nature: 60,
  fun: 180,
  sight: 60,
};

export interface Suggestion extends LatLng {
  id: string;
  name: string;
  category: SuggestCategory;
  stayMinutes: number;
  distanceKm: number;
  /** 有名さの目安（Wikipedia の記事があるかなど） */
  score: number;
  /** 「ja:清水寺」のような Wikipedia の記事名 */
  wikipedia?: string;
  open?: string;
  close?: string;
}

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * OpenStreetMap（Overpass API）に出す問い合わせ。
 * 範囲が広いときは Wikidata にも載っている（＝ある程度有名な）場所だけにする。
 */
export function buildOverpassQuery(center: LatLng, radiusKm: number): string {
  const r = Math.round(radiusKm * 1000);
  const around = `(around:${r},${center.lat},${center.lng})`;
  const famous = radiusKm > 3 ? `["wikidata"]` : "";
  return `[out:json][timeout:25];
(
  nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"]["name"]${famous}${around};
  nwr["historic"~"^(castle|monument|memorial|ruins|archaeological_site|city_gate|temple|shrine)$"]["name"]${famous}${around};
  nwr["amenity"="place_of_worship"]["name"]["wikidata"]${around};
  nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"]${around};
  nwr["natural"~"^(peak|waterfall|beach|hot_spring)$"]["name"]["wikidata"]${around};
);
out center tags 400;`;
}

/** Overpass の結果を、有名そうな順の候補に変える */
export function parseOverpass(json: { elements?: OverpassElement[] }, center: LatLng, limit = 40): Suggestion[] {
  const out: Suggestion[] = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = tags["name:ja"] || tags.name;
    if (lat === undefined || lng === undefined || !name) continue;
    const category = categorize(tags);
    if (!category) continue;

    let score = 0;
    if (tags.wikidata) score += 3;
    if (tags.wikipedia) score += 3;
    if (tags["name:en"]) score += 1;
    if (tags.heritage || tags["heritage:operator"]) score += 2;
    if (tags.tourism === "attraction" || tags.tourism === "theme_park" || tags.historic === "castle") score += 1;

    const distanceKm = haversineKm(center, { lat, lng });
    const hours = simpleHours(tags.opening_hours);
    out.push({
      id: `${el.type}/${el.id}`,
      name,
      lat,
      lng,
      category,
      stayMinutes: DEFAULT_STAY[category],
      distanceKm,
      score,
      wikipedia: tags.wikipedia,
      ...hours,
    });
  }

  // 同じ場所が点と面の両方で載っていることがあるので、近くの同じ名前はまとめる
  out.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  const kept: Suggestion[] = [];
  for (const s of out) {
    if (kept.some((k) => k.name === s.name && haversineKm(k, s) < 0.5)) continue;
    kept.push(s);
    if (kept.length >= limit) break;
  }
  return kept;
}

function categorize(t: Record<string, string>): SuggestCategory | null {
  if (t.amenity === "place_of_worship" || t.historic === "temple" || t.historic === "shrine") return "temple";
  if (t.tourism === "museum" || t.tourism === "gallery") return "museum";
  if (t.tourism === "zoo" || t.tourism === "aquarium" || t.tourism === "theme_park") return "fun";
  if (t.historic) return "history";
  if (t.leisure || t.natural || t.tourism === "viewpoint") return "nature";
  if (t.tourism === "attraction") return "sight";
  return null;
}

/**
 * 「09:00-17:00」「Mo-Su 08:30-17:00」のような単純な営業時間だけ読む。
 * 曜日で変わるなど複雑なものは読まない（間違った時間を入れるよりはまし）。
 */
export function simpleHours(v: string | undefined): { open?: string; close?: string } {
  const m = v && /^(?:Mo-Su\s+)?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(v.trim());
  if (!m) return {};
  const pad = (s: string) => s.padStart(5, "0");
  return { open: pad(m[1]!), close: pad(m[2]!) };
}

const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

/** 宿のまわりの観光地の候補を探す */
export async function suggestSpots(
  center: LatLng,
  radiusKm: number,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<Suggestion[]> {
  const body = new URLSearchParams({ data: buildOverpassQuery(center, radiusKm) });
  let lastError: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchFn(url, { method: "POST", body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseOverpass(await res.json(), center);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("観光地を探せませんでした");
}

export interface WikiSummary {
  extract: string;
  thumbnail?: string;
  url: string;
}

/**
 * 日本語版 Wikipedia から、候補の1行説明と写真をまとめて取る。
 * wikipedia タグが「ja:」のものだけ。取れなくても候補の表示には困らない。
 */
export async function fetchWikiSummaries(
  items: Suggestion[],
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<Map<string, WikiSummary>> {
  const titles = [...new Set(items.flatMap((s) => (s.wikipedia?.startsWith("ja:") ? [s.wikipedia.slice(3)] : [])))];
  const result = new Map<string, WikiSummary>();
  // extracts は1回に20件まで
  for (let i = 0; i < titles.length; i += 20) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      prop: "extracts|pageimages",
      exintro: "1",
      explaintext: "1",
      exsentences: "1",
      exlimit: "20",
      piprop: "thumbnail",
      pithumbsize: "160",
      pilimit: "20",
      redirects: "1",
      titles: titles.slice(i, i + 20).join("|"),
    });
    const res = await fetchFn(`https://ja.wikipedia.org/w/api.php?${params}`);
    if (!res.ok) continue;
    const json = (await res.json()) as {
      query?: {
        pages?: Array<{ title: string; extract?: string; thumbnail?: { source: string } }>;
        redirects?: Array<{ from: string; to: string }>;
        normalized?: Array<{ from: string; to: string }>;
      };
    };
    const q = json.query ?? {};
    const alias = new Map<string, string>();
    for (const r of [...(q.normalized ?? []), ...(q.redirects ?? [])]) alias.set(r.to, r.from);
    for (const p of q.pages ?? []) {
      const summary: WikiSummary = {
        extract: (p.extract ?? "").trim(),
        thumbnail: p.thumbnail?.source,
        url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
      };
      // 正規化・転送の前の名前（＝OSM に書かれている名前）でも引けるようにする
      let key: string | undefined = p.title;
      const seen = new Set<string>();
      while (key && !seen.has(key)) {
        seen.add(key);
        result.set(`ja:${key}`, summary);
        key = alias.get(key);
      }
    }
  }
  return result;
}
