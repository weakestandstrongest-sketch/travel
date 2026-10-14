export interface LatLng {
  lat: number;
  lng: number;
}

/** 地図上の地点。station は乗換案内で検索するときの最寄り駅名（任意）。 */
export interface Place extends LatLng {
  name: string;
  station?: string;
}

export type Priority = "must" | "want";

export interface Spot extends Place {
  /** 滞在時間（分） */
  stayMinutes: number;
  /** 開場時刻 "HH:MM"（省略時は制限なし） */
  open?: string;
  /** 閉場時刻 "HH:MM"（省略時は制限なし） */
  close?: string;
  /** must: 必ず入れたい / want: 時間があれば（省略時 want） */
  priority?: Priority;
  /** この日に行きたい（1始まり）。省略時はプランナーが決める */
  day?: number;
}

export type TravelMode = "transit" | "walk" | "car";

export interface TripRequest {
  /** 初日 "YYYY-MM-DD" */
  startDate: string;
  days: number;
  /** 毎日の出発時刻 "HH:MM"（既定 09:00） */
  dayStart?: string;
  /** 毎日の宿への帰着リミット "HH:MM"（既定 19:00） */
  dayEnd?: string;
  /** 宿（毎日ここから出発してここへ戻る） */
  base: Place;
  mode?: TravelMode;
  spots: Spot[];
}

/** 2地点間の移動の見積もり */
export interface TravelEstimate {
  minutes: number;
  distanceKm: number;
  /** 実際に使う手段（transit 指定でも近距離なら walk になる等） */
  mode: TravelMode;
}

export interface Visit {
  kind: "visit";
  spot: Spot;
  /** 到着時刻（0時からの分） */
  arrive: number;
  /** 見学開始（開場待ちがあれば arrive より後） */
  start: number;
  end: number;
  /** 実際の電車に合わせたら営業時間に間に合わなくなった、など */
  warning?: string;
}

export interface Move {
  kind: "move";
  from: Place;
  to: Place;
  depart: number;
  arrive: number;
  minutes: number;
  distanceKm: number;
  mode: TravelMode;
  /** 乗換案内で調べた実際の経路（調べていなければなし） */
  transit?: TransitRoute;
  /** 調べたが使えなかった理由（概算のまま） */
  transitNote?: string;
}

/** のりかえ（/api/search）が返す経路の1区間 */
export type TransitStep =
  | { kind: "station"; name: string; arr: string; dep: string }
  | {
      kind: "access";
      line: string;
      destination: string;
      color: string;
      platform: string;
      stops: string;
      walk: boolean;
      stopList?: Array<{ name: string; time: string }>;
    };

/** のりかえ（/api/search）が返す経路 */
export interface TransitRoute {
  summary: {
    dep: string;
    arr: string;
    duration: string;
    transfers: number | null;
    fare: number | null;
    fareNote: string;
    tags: string[];
  };
  steps: TransitStep[];
}

export interface DayPlan {
  day: number;
  date: string;
  items: Array<Visit | Move>;
  start: number;
  end: number;
  warning?: string;
}

export interface Unscheduled {
  spot: Spot;
  reason: string;
}

export interface Itinerary {
  request: TripRequest;
  days: DayPlan[];
  unscheduled: Unscheduled[];
}
