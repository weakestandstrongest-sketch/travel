import type { LatLng, Place, Spot, TripRequest } from "../core/types.js";

/** 場所の名前から緯度経度を引く */
export interface Geocoder {
  geocode(query: string): Promise<LatLng | null>;
}

export interface NominatimOptions {
  /** Nominatim の利用規約上、連絡先がわかる User-Agent が必須 */
  userAgent: string;
  countryCodes?: string;
  /** 利用規約は 1リクエスト/秒まで */
  minIntervalMs?: number;
  fetch?: typeof fetch;
}

/** OpenStreetMap の Nominatim を使ったジオコーダ（API キー不要） */
export class NominatimGeocoder implements Geocoder {
  private lastRequestAt = 0;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: NominatimOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async geocode(query: string): Promise<LatLng | null> {
    const wait = this.lastRequestAt + (this.opts.minIntervalMs ?? 1100) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();

    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
      countrycodes: this.opts.countryCodes ?? "jp",
      "accept-language": "ja",
    });
    const res = await this.fetchFn(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": this.opts.userAgent },
    });
    if (!res.ok) throw new Error(`ジオコーディングに失敗しました（HTTP ${res.status}）: ${query}`);
    const results = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = results[0];
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  }
}

type WithOptionalCoords<T extends LatLng> = Omit<T, "lat" | "lng"> & Partial<LatLng>;

/** 緯度経度を省略できる入力形式（場所の名前だけ書けばよい） */
export type TripInput = Omit<TripRequest, "base" | "spots"> & {
  base: WithOptionalCoords<Place>;
  spots: Array<WithOptionalCoords<Spot>>;
};

/** 緯度経度が書かれていない場所をジオコーディングで埋める */
export async function resolveCoordinates(input: TripInput, geocoder: Geocoder): Promise<TripRequest> {
  const resolve = async <T extends Place>(p: WithOptionalCoords<T>): Promise<T> => {
    if (p.lat !== undefined && p.lng !== undefined) return p as T;
    const hit = await geocoder.geocode(p.name);
    if (!hit) throw new Error(`場所が見つかりませんでした: ${p.name}（lat / lng を直接指定してください）`);
    return { ...p, ...hit } as T;
  };

  const base = await resolve<Place>(input.base);
  const spots: Spot[] = [];
  for (const spot of input.spots) spots.push(await resolve<Spot>(spot));
  return { ...input, base, spots };
}
