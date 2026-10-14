import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTrip } from "../src/core/planner.js";
import { formatHM, parseHM } from "../src/core/time.js";
import { refineWithTransit, type TransitProvider } from "../src/core/transit.js";
import type { Place, TransitRoute, TripRequest } from "../src/core/types.js";
import { toIcs } from "../src/export/ics.js";
import { toMarkdown } from "../src/export/markdown.js";
import { NorikaeProvider, norikaeAppUrl } from "../src/providers/norikae.js";

const kyoto = JSON.parse(readFileSync(new URL("../examples/kyoto.json", import.meta.url), "utf8")) as TripRequest;

/** のりかえ /api/search の応答と同じ形の経路を作る */
function fakeRoute(from: Place, to: Place, dep: string, minutes: number): TransitRoute {
  const arr = formatHM(parseHM(dep) + minutes);
  return {
    summary: { dep, arr, duration: `${minutes}分`, transfers: 0, fare: 230, fareNote: "", tags: ["早"] },
    steps: [
      { kind: "station", name: from.station ?? from.name, arr: "", dep },
      { kind: "access", line: "京都市営地下鉄烏丸線", destination: "国際会館行", color: "#00a33e", platform: "2番線", stops: "3駅", walk: false },
      { kind: "station", name: to.station ?? to.name, arr, dep: "" },
    ],
  };
}

describe("refineWithTransit", () => {
  it("実際の電車の到着時刻で後ろの予定を組み直す", async () => {
    const calls: string[] = [];
    // 5分待ってから乗る、乗車は概算より長い 40分
    const provider: TransitProvider = {
      async route(from, to, date, depart) {
        calls.push(`${date} ${depart} ${from.name}→${to.name}`);
        return fakeRoute(from, to, formatHM(parseHM(depart) + 5), 40);
      },
    };
    const plan = planTrip(kyoto);
    const refined = await refineWithTransit(plan, provider);
    const transitMoves = plan.days.flatMap((d) => d.items).filter((i) => i.kind === "move" && i.mode === "transit");
    expect(calls).toHaveLength(transitMoves.length);
    expect(calls[0]).toMatch(/^2026-11-21 09:00 京都駅→/);

    for (const day of refined.days) {
      let t = day.start;
      for (const item of day.items) {
        if (item.kind === "move") {
          expect(item.depart).toBe(t);
          if (item.transit) expect(item.arrive).toBe(t + 45);
          t = item.arrive;
        } else {
          expect(item.arrive).toBe(t);
          t = item.end;
        }
      }
      expect(day.end).toBe(t);
    }
  });

  it("間に合わなくなったら警告、調べられない区間は概算のまま", async () => {
    let n = 0;
    const provider: TransitProvider = {
      async route(from, to, _date, depart) {
        n++;
        if (n === 1) throw new Error("network");
        if (n === 2) return null;
        return fakeRoute(from, to, depart, 300);
      },
    };
    const refined = await refineWithTransit(planTrip(kyoto), provider);
    const moves = refined.days.flatMap((d) => d.items).filter((i) => i.kind === "move" && i.mode === "transit");
    expect(moves[0]?.kind === "move" && moves[0].transitNote).toMatch(/つながらなかった/);
    expect(moves[1]?.kind === "move" && moves[1].transitNote).toMatch(/見つからなかった/);
    expect(refined.days.some((d) => d.warning)).toBe(true);
  });
});

describe("NorikaeProvider", () => {
  it("/api/search を駅名・日時つきで呼ぶ", async () => {
    let requested = "";
    const route = fakeRoute(kyoto.base, kyoto.spots[0]!, "09:03", 10);
    const fakeFetch = (async (url: string) => {
      requested = url;
      return new Response(JSON.stringify({ routes: [route], total: 1 }));
    }) as unknown as typeof fetch;
    const p = new NorikaeProvider("https://norikae.example.workers.dev/", fakeFetch);
    expect(await p.route(kyoto.base, kyoto.spots[0]!, "2026-11-21", "09:00")).toEqual(route);
    const url = new URL(requested);
    expect(url.pathname).toBe("/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "京都",
      to: "稲荷",
      date: "2026-11-21",
      time: "09:00",
      type: "dep",
    });
  });

  it("経路なし（400 や空）は null", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "出発駅と到着駅を入力してください" }), { status: 400 })) as unknown as typeof fetch;
    expect(await new NorikaeProvider("https://x.workers.dev", fakeFetch).route(kyoto.base, kyoto.base, "2026-11-21", "09:00")).toBeNull();
  });

  it("のりかえの画面を開くリンク", () => {
    const url = new URL(norikaeAppUrl("https://x.workers.dev", kyoto.base, kyoto.spots[1]!, "2026-11-21", "10:50"));
    expect(url.searchParams.get("to")).toBe("清水五条");
    expect(url.searchParams.get("go")).toBe("1");
  });
});

describe("ひび手帳向けの書き出し", () => {
  it("観光と電車の移動を予定にし、経路をメモに入れる", async () => {
    const provider: TransitProvider = { route: async (f, t, _d, dep) => fakeRoute(f, t, dep, 20) };
    const refined = await refineWithTransit(planTrip(kyoto), provider);
    const ics = toIcs(refined, { norikaeUrl: "https://x.workers.dev", now: new Date(0) });
    // ひび手帳の parseICS と同じく、折り返しを戻してから読む
    const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
    const summaries = lines.filter((l) => l.startsWith("SUMMARY:"));
    expect(summaries).toContain("SUMMARY:京都 → 稲荷");
    expect(summaries).toContain("SUMMARY:伏見稲荷大社");
    const desc = lines.find((l) => l.startsWith("DESCRIPTION:") && l.includes("烏丸線"));
    expect(desc).toMatch(/230円/);
    expect(desc).toMatch(/のりかえ: https:\/\/x\.workers\.dev/);
    // 1行は 75 バイト以内
    for (const raw of ics.split("\r\n")) expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
    // 同じ旅程なら同じ UID（ひび手帳で二重に取り込まれない）
    expect(toIcs(refined, { now: new Date(1e12) }).match(/UID:.*/g)).toEqual(
      toIcs(refined, { now: new Date(0) }).match(/UID:.*/g),
    );
  });

  it("Markdown は実際の電車を表示し、のりかえへのリンクを出す", async () => {
    const provider: TransitProvider = { route: async (f, t, _d, dep) => fakeRoute(f, t, dep, 20) };
    const md = toMarkdown(await refineWithTransit(planTrip(kyoto), provider), { norikaeUrl: "https://x.workers.dev" });
    expect(md).toContain("京都市営地下鉄烏丸線");
    expect(md).toContain("[のりかえ](https://x.workers.dev/?");
    expect(md).not.toContain("概算です。");
  });
});
