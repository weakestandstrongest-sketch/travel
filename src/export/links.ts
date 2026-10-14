import type { Place, TravelMode } from "../core/types.js";

/**
 * Yahoo!乗換案内の検索結果ページへのリンク（指定時刻に出発）。
 * 駅名で検索した方が精度が高いので、station があればそちらを使う。
 */
export function yahooTransitUrl(from: Place, to: Place, date: string, departMinutes: number): string {
  const [y, m, d] = date.split("-");
  const hh = Math.floor(departMinutes / 60);
  const mm = Math.round(departMinutes % 60);
  const params = new URLSearchParams({
    from: from.station ?? from.name,
    to: to.station ?? to.name,
    y: y ?? "",
    m: m ?? "",
    d: d ?? "",
    hh: String(hh).padStart(2, "0"),
    m1: String(Math.floor(mm / 10)),
    m2: String(mm % 10),
    type: "1", // 出発時刻指定
  });
  return `https://transit.yahoo.co.jp/search/result?${params}`;
}

const GOOGLE_TRAVEL_MODE: Record<TravelMode, string> = {
  transit: "transit",
  walk: "walking",
  car: "driving",
};

/** Google マップの経路案内へのリンク（緯度経度で指定するので名前の揺れに強い） */
export function googleMapsDirectionsUrl(from: Place, to: Place, mode: TravelMode): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
    travelmode: GOOGLE_TRAVEL_MODE[mode],
  });
  return `https://www.google.com/maps/dir/?${params}`;
}
