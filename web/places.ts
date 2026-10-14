import type { LatLng } from "../src/core/types.js";

export interface PlaceCandidate extends LatLng {
  name: string;
  /** 「京都府京都市東山区」のような短い住所 */
  area: string;
}

/**
 * 場所の名前から候補を探す。OpenStreetMap（Nominatim）で見つからなければ
 * 国土地理院の地名検索も試す。どちらも API キー不要で、ブラウザから直接呼べる。
 */
export async function searchPlaces(query: string): Promise<PlaceCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const fromOsm = await searchNominatim(q).catch(() => []);
  if (fromOsm.length) return fromOsm;
  return searchGsi(q).catch(() => []);
}

async function searchNominatim(q: string): Promise<PlaceCandidate[]> {
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "6",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hits = (await res.json()) as Array<{ lat: string; lon: string; name?: string; display_name: string }>;
  return dedupe(
    hits.map((h) => {
      const parts = h.display_name.split(",").map((s) => s.trim());
      // 「清水寺, 1丁目, 清水, 東山区, 京都市, 京都府, 605-0862, 日本」→ 京都府京都市東山区
      const area = parts
        .slice(1)
        .filter((s) => s !== "日本" && !/^\d{3}-?\d{4}$/.test(s))
        .reverse()
        .filter((s) => /[都道府県市区町村郡]$/.test(s))
        .slice(0, 3)
        .join("");
      return { name: h.name || parts[0] || q, area, lat: Number(h.lat), lng: Number(h.lon) };
    }),
  );
}

async function searchGsi(q: string): Promise<PlaceCandidate[]> {
  const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hits = (await res.json()) as Array<{ geometry: { coordinates: [number, number] }; properties: { title: string } }>;
  return dedupe(
    hits.slice(0, 6).map((h) => ({
      name: h.properties.title,
      area: "",
      lat: h.geometry.coordinates[1],
      lng: h.geometry.coordinates[0],
    })),
  );
}

function dedupe(list: PlaceCandidate[]): PlaceCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = `${c.name}|${c.lat.toFixed(3)}|${c.lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(c.lat) && Number.isFinite(c.lng);
  });
}
