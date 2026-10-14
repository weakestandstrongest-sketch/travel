import type { TransitProvider } from "../core/transit.js";
import type { Place, TransitRoute } from "../core/types.js";

/** 乗換案内で検索するときの地点名（駅名があれば駅名） */
export const transitName = (p: Place): string => p.station ?? p.name;

/**
 * 自作の乗換案内「のりかえ」（Cloudflare Worker）の /api/search を使う。
 * のりかえは *.github.io と localhost からの呼び出しだけ許可しているので、
 * この旅行アプリも GitHub Pages で公開して使う。
 */
export class NorikaeProvider implements TransitProvider {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchFn = fetchFn ?? ((...args) => fetch(...args));
  }

  async route(from: Place, to: Place, date: string, depart: string): Promise<TransitRoute | null> {
    const params = new URLSearchParams({
      from: transitName(from),
      to: transitName(to),
      date,
      time: depart,
      type: "dep",
    });
    const res = await this.fetchFn(`${this.base}/api/search?${params}`);
    if (!res.ok && res.status !== 400) throw new Error(`のりかえがエラーを返しました（HTTP ${res.status}）`);
    const body = (await res.json()) as { routes?: TransitRoute[] };
    return body.routes?.[0] ?? null;
  }
}

/** のりかえの画面で同じ区間を開くリンク */
export function norikaeAppUrl(baseUrl: string, from: Place, to: Place, date: string, depart: string): string {
  const params = new URLSearchParams({
    from: transitName(from),
    to: transitName(to),
    date,
    time: depart,
    type: "dep",
    go: "1",
  });
  return `${baseUrl.replace(/\/+$/, "")}/?${params}`;
}
