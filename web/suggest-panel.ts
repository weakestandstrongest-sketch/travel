import type { Place, TravelMode } from "../src/core/types.js";
import { StraightLineEstimator } from "../src/providers/estimator.js";
import {
  CATEGORY_LABEL,
  fetchWikiSummaries,
  suggestSpots,
  type SuggestCategory,
  type Suggestion,
  type WikiSummary,
} from "../src/providers/suggest.js";

export interface SuggestHost {
  base(): Place | null;
  mode(): TravelMode;
  isAdded(s: Suggestion): boolean;
  /** 追加済みなら外し、まだなら追加する。追加したら true */
  toggle(s: Suggestion): boolean;
}

const RANGES: Array<{ km: number; label: string; note: string }> = [
  { km: 2, label: "徒歩圏", note: "2km" },
  { km: 10, label: "近場", note: "10km" },
  { km: 30, label: "遠出", note: "30km" },
  { km: 50, label: "電車で1時間", note: "50km" },
];
const DEFAULT_RANGE: Record<TravelMode, number> = { walk: 2, transit: 10, car: 30 };
const PAGE = 12;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MODE_WORD: Record<TravelMode, string> = { transit: "電車で", walk: "徒歩", car: "車で" };

/** 宿のまわりの観光地をおすすめして、タップで行きたい場所に入れるパネル */
export function mountSuggestPanel(root: HTMLElement, host: SuggestHost): { refresh(): void } {
  const estimator = new StraightLineEstimator();
  const cache = new Map<string, Suggestion[]>();
  const wiki = new Map<string, WikiSummary>();
  let open = false;
  let rangeKm: number | null = null;
  let cats = new Set<SuggestCategory>();
  let shown = PAGE;
  let loading = false;
  let error = "";
  let seq = 0;
  let currentList: Suggestion[] = [];

  const key = (b: Place, km: number) => `${b.lat.toFixed(4)},${b.lng.toFixed(4)},${km}`;

  async function load(): Promise<void> {
    const base = host.base();
    if (!base || rangeKm === null) return;
    const k = key(base, rangeKm);
    if (cache.has(k)) return;
    const my = ++seq;
    loading = true;
    error = "";
    render();
    try {
      const list = await suggestSpots(base, rangeKm);
      if (my !== seq) return;
      cache.set(k, list);
      loading = false;
      render();
      const summaries = await fetchWikiSummaries(list.filter((s) => s.wikipedia && !wiki.has(s.wikipedia))).catch(() => new Map());
      for (const [t, w] of summaries) wiki.set(t, w);
      if (my === seq) render();
    } catch (e) {
      if (my !== seq) return;
      loading = false;
      error = `観光地を探せませんでした。少し待ってからもう一度試してください（${e instanceof Error ? e.message : String(e)}）`;
      render();
    }
  }

  function render(): void {
    const base = host.base();
    if (!base) {
      root.innerHTML = `<p class="note">宿・出発地を決めると、まわりの観光地をおすすめします。</p>`;
      return;
    }
    if (!open) {
      root.innerHTML = `<button type="button" class="btn suggest-open" data-act="open">✨ ${esc(base.name)} のまわりのおすすめを見る</button>`;
      return;
    }
    const km = rangeKm ?? DEFAULT_RANGE[host.mode()];
    const all = cache.get(key(base, km)) ?? [];
    const present = [...new Set(all.map((s) => s.category))];
    const list = all.filter((s) => cats.size === 0 || cats.has(s.category));
    const mode = host.mode();

    const items = list
      .slice(0, shown)
      .map((s, i) => {
        const w = s.wikipedia ? wiki.get(s.wikipedia) : undefined;
        const minutes = estimator.estimate(base, s, mode).minutes;
        const added = host.isAdded(s);
        return `<li class="sg${added ? " added" : ""}">
          ${w?.thumbnail ? `<img src="${esc(w.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="sg-ph cat-${s.category}"></span>`}
          <div class="sg-body">
            <b>${esc(s.name)}</b>
            <small>${esc(CATEGORY_LABEL[s.category])}・${MODE_WORD[mode]}約${minutes}分${s.open ? `・${s.open}〜${s.close}` : ""}</small>
            ${w?.extract ? `<p>${esc(w.extract)}</p>` : ""}
          </div>
          <button type="button" class="sg-add" data-i="${i}" aria-pressed="${added}">${added ? "✓ 追加済み" : "＋ 追加"}</button>
        </li>`;
      })
      .join("");

    root.innerHTML = `
      <div class="suggest">
        <div class="sg-head">
          <b>${esc(base.name)} のまわりのおすすめ</b>
          <button type="button" class="link" data-act="close">閉じる</button>
        </div>
        <div class="seg sg-range" role="radiogroup">${RANGES.map(
          (r) => `<button type="button" role="radio" data-km="${r.km}" aria-checked="${r.km === km}">${r.label}<small>${r.note}</small></button>`,
        ).join("")}</div>
        ${present.length > 1 ? `<div class="chips">${present
          .map((c) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${cats.has(c)}">${CATEGORY_LABEL[c]}</button>`)
          .join("")}</div>` : ""}
        ${loading ? `<p class="muted">観光地を探しています…</p>` : ""}
        ${error ? `<p class="warn">${esc(error)}</p><button type="button" class="btn more" data-act="retry">もう一度探す</button>` : ""}
        ${!loading && !error && all.length === 0 ? `<p class="muted">この範囲では見つかりませんでした。範囲を広げてみてください</p>` : ""}
        <ul class="sg-list">${items}</ul>
        ${list.length > shown ? `<button type="button" class="btn more" data-act="more">もっと見る（あと${list.length - shown}件）</button>` : ""}
        ${all.length ? `<p class="note">データ：Wikidata・OpenStreetMap・Wikipedia。営業時間は分かるものだけ入れています。</p>` : ""}
      </div>`;
    currentList = list;
  }

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "open") {
      open = true;
      rangeKm = rangeKm ?? DEFAULT_RANGE[host.mode()];
      render();
      void load();
      return;
    }
    if (act === "close") {
      open = false;
      render();
      return;
    }
    if (act === "retry") {
      void load();
      return;
    }
    if (act === "more") {
      shown += PAGE;
      render();
      return;
    }
    const range = t.closest<HTMLElement>("[data-km]");
    if (range) {
      rangeKm = Number(range.dataset.km);
      shown = PAGE;
      render();
      void load();
      return;
    }
    const chip = t.closest<HTMLElement>("[data-cat]");
    if (chip) {
      const c = chip.dataset.cat as SuggestCategory;
      cats = new Set(cats);
      if (cats.has(c)) cats.delete(c);
      else cats.add(c);
      shown = PAGE;
      render();
      return;
    }
    const add = t.closest<HTMLButtonElement>(".sg-add");
    const s = add && currentList[Number(add.dataset.i)];
    if (s) {
      const added = host.toggle(s);
      add.setAttribute("aria-pressed", String(added));
      add.textContent = added ? "✓ 追加済み" : "＋ 追加";
      add.closest(".sg")?.classList.toggle("added", added);
    }
  });

  render();
  return {
    refresh() {
      // 宿が変わったら、いったん閉じて範囲も選び直す
      if (!host.base()) open = false;
      render();
      if (open) void load();
    },
  };
}
