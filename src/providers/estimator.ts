import { haversineKm } from "../core/geo.js";
import type { LatLng, TravelEstimate, TravelMode } from "../core/types.js";

/**
 * 2地点間の所要時間を返す。プランナーは組み合わせを大量に試すので、
 * ここは同期・高速である必要がある。
 *
 * 乗換案内 API などの実データを使う場合は、事前に全地点間の所要時間を
 * まとめて取得・キャッシュし、その値を返す実装に差し替える想定
 * （API 呼び出し回数を地点数^2 に抑えられる）。
 */
export interface TravelTimeEstimator {
  estimate(from: LatLng, to: LatLng, mode: TravelMode): TravelEstimate;
}

export interface StraightLineOptions {
  /** 直線距離に対する実際の道のりの倍率 */
  detourFactor: number;
  walkKmh: number;
  /** この距離（実距離 km）以下は transit 指定でも徒歩にする */
  walkThresholdKm: number;
  transitKmh: number;
  /** これより遠い分は快速・特急など速い電車で行ける想定にする（km） */
  transitFastAfterKm: number;
  transitFastKmh: number;
  /** 駅までの徒歩・待ち時間など、電車・バス利用時の固定ロス（分） */
  transitOverheadMin: number;
  carKmh: number;
  /** 駐車などの固定ロス（分） */
  carOverheadMin: number;
}

const DEFAULTS: StraightLineOptions = {
  detourFactor: 1.3,
  walkKmh: 4.5,
  walkThresholdKm: 1.2,
  transitKmh: 25,
  transitFastAfterKm: 10,
  transitFastKmh: 55,
  transitOverheadMin: 12,
  carKmh: 25,
  carOverheadMin: 8,
};

/** 直線距離からざっくり所要時間を見積もる。API キー不要で動く既定の実装。 */
export class StraightLineEstimator implements TravelTimeEstimator {
  private readonly opts: StraightLineOptions;

  constructor(opts: Partial<StraightLineOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  estimate(from: LatLng, to: LatLng, mode: TravelMode): TravelEstimate {
    const o = this.opts;
    const distanceKm = haversineKm(from, to) * o.detourFactor;
    const walkMinutes = (distanceKm / o.walkKmh) * 60;

    if (mode === "walk" || (mode === "transit" && distanceKm <= o.walkThresholdKm)) {
      return { minutes: Math.ceil(walkMinutes), distanceKm, mode: "walk" };
    }
    if (mode === "car") {
      const minutes = o.carOverheadMin + (distanceKm / o.carKmh) * 60;
      return { minutes: Math.ceil(minutes), distanceKm, mode: "car" };
    }
    const near = Math.min(distanceKm, o.transitFastAfterKm);
    const far = distanceKm - near;
    const transitMinutes = o.transitOverheadMin + (near / o.transitKmh + far / o.transitFastKmh) * 60;
    // 電車を待つより歩いた方が早い距離なら歩く
    if (walkMinutes <= transitMinutes) {
      return { minutes: Math.ceil(walkMinutes), distanceKm, mode: "walk" };
    }
    return { minutes: Math.ceil(transitMinutes), distanceKm, mode: "transit" };
  }
}
