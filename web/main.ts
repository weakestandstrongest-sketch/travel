import sample from "../examples/kyoto.json" with { type: "json" };
import { haversineKm } from "../src/core/geo.js";
import { planTrip } from "../src/core/planner.js";
import { addDays, formatHM } from "../src/core/time.js";
import { refineWithTransit } from "../src/core/transit.js";
import type { Itinerary, Move, Place, Spot, TravelMode, TripRequest, Visit } from "../src/core/types.js";
import { toIcs } from "../src/export/ics.js";
import { googleMapsDirectionsUrl, yahooTransitUrl } from "../src/export/links.js";
import { MODE_LABEL, toMarkdown, weekday } from "../src/export/markdown.js";
import { NorikaeProvider, norikaeAppUrl, stationName } from "../src/providers/norikae.js";
import { CATEGORY_LABEL, type Suggestion } from "../src/providers/suggest.js";
import { TripMap, dayColor } from "./map.js";
import { searchPlaces, type PlaceCandidate } from "./places.js";
import { mountSuggestPanel } from "./suggest-panel.js";

/* ---------- 状態 ---------- */

interface SpotItem extends Spot {
  id: string;
  area?: string;
  /** おすすめから追加したときの OSM の ID */
  sid?: string;
}

interface BasePlace extends Place {
  area?: string;
  /** 最寄り駅の位置（分かれば、旅程やおすすめの起点にする） */
  stationLat?: number;
  stationLng?: number;
}

interface State {
  startDate: string;
  days: number;
  dayStart: string;
  dayEnd: string;
  mode: TravelMode;
  base: BasePlace | null;
  spots: SpotItem[];
  norikaeUrl: string;
  useNorikae: boolean;
}

const STATE_KEY = "travel.state.v1";
const PLAN_KEY = "travel.itinerary.v1";
const DEFAULT_NORIKAE = "https://norikae.gohanoishi.workers.dev";
const STAY_OPTIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360];

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const defaults = (): State => ({
  startDate: addDays(todayISO(), 7),
  days: 1,
  dayStart: "09:00",
  dayEnd: "19:00",
  mode: "transit",
  base: null,
  spots: [],
  norikaeUrl: DEFAULT_NORIKAE,
  useNorikae: true,
});

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function store(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

const state: State = { ...defaults(), ...load<Partial<State>>(STATE_KEY) };
let itinerary: Itinerary | null = load<Itinerary>(PLAN_KEY);
let dirty = false;
let planSeq = 0;
const openDetails = new Set<string>();

const save = () => store(STATE_KEY, state);
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------- DOM ---------- */

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${weekday(date)}）`;

let toastTimer = 0;
function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2600);
}

const map = new TripMap($("#map"));

/** 旅程・おすすめの起点。最寄り駅の位置が分かっていれば駅から考える */
function origin(): Place | null {
  const b = state.base;
  if (!b) return null;
  const st = b.station ? stationName(b.station) : "";
  const atStation = st && b.stationLat !== undefined && b.stationLng !== undefined;
  return {
    name: atStation ? `${st}駅` : b.name,
    station: b.station,
    lat: atStation ? b.stationLat! : b.lat,
    lng: atStation ? b.stationLng! : b.lng,
  };
}

/** 「茨木（茨木駅）」のような宿の表示名 */
function baseLabel(p: Place): string {
  const st = p.station ? stationName(p.station) : "";
  return st && p.name !== `${st}駅` ? `${p.name}（${st}駅）` : p.name;
}

/** 最寄り駅の名前から駅の位置を調べる */
async function locateStation(): Promise<void> {
  const b = state.base;
  if (!b?.station) return;
  const st = stationName(b.station);
  const hits = await searchPlaces(`${st}駅`);
  if (state.base !== b || b.station === undefined || stationName(b.station) !== st) return; // 途中で変わった
  const hit = hits.find((h) => h.name.includes(st)) ?? null;
  b.stationLat = hit?.lat;
  b.stationLng = hit?.lng;
  const note = document.querySelector("#stationNote");
  if (note) note.textContent = hit ? `${st}駅 を起点にして、おすすめと移動時間を考えます` : `${st}駅 の場所が見つかりませんでした（乗換案内には使います）`;
  save();
  suggest.refresh();
  if (!itinerary) map.showPlaces(origin(), state.spots);
}

/** おすすめの場所が、もう行きたい場所に入っているか */
const findSuggested = (s: Suggestion) =>
  state.spots.find((x) => x.sid === s.id || (x.name === s.name && haversineKm(x, s) < 0.5));

const suggest = mountSuggestPanel($("#suggest"), {
  base: () => origin(),
  mode: () => state.mode,
  isAdded: (s) => !!findSuggested(s),
  toggle(s) {
    const found = findSuggested(s);
    if (found) {
      state.spots = state.spots.filter((x) => x !== found);
      toast(`${s.name} を外しました`);
    } else {
      state.spots.push({
        id: uid(),
        sid: s.id,
        name: s.name,
        area: CATEGORY_LABEL[s.category],
        lat: s.lat,
        lng: s.lng,
        stayMinutes: s.stayMinutes,
        open: s.open,
        close: s.close,
        priority: "want",
      });
      toast(`${s.name} を追加しました`);
    }
    renderSpots();
    changed();
    return !found;
  },
});

/* ---------- 場所の検索ボックス（宿と行きたい場所で共用） ---------- */

function searchBox(container: HTMLElement, placeholder: string, onPick: (c: PlaceCandidate) => void): void {
  container.innerHTML = `
    <form class="search">
      <input type="search" placeholder="${esc(placeholder)}" enterkeyhint="search" autocomplete="off" />
      <button class="btn" type="submit">探す</button>
    </form>
    <ul class="cands" hidden></ul>`;
  const form = $<HTMLFormElement>("form", container);
  const input = $<HTMLInputElement>("input", container);
  const list = $<HTMLUListElement>(".cands", container);
  let results: PlaceCandidate[] = [];

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    list.hidden = false;
    list.innerHTML = `<li class="muted">探しています…</li>`;
    results = await searchPlaces(q);
    list.innerHTML = results.length
      ? results
          .map((c, i) => `<li><button type="button" data-i="${i}"><b>${esc(c.name)}</b><small>${esc(c.area)}</small></button></li>`)
          .join("")
      : `<li class="muted">見つかりませんでした。別の書き方（正式名称・地名をつける）で試してください</li>`;
  });
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
    const c = b && results[Number(b.dataset.i)];
    if (!c) return;
    onPick(c);
    input.value = "";
    list.hidden = true;
    list.innerHTML = "";
  });
}

/* ---------- 入力欄 ---------- */

function renderTrip(): void {
  $<HTMLInputElement>("#startDate").value = state.startDate;
  $("#days").textContent = `${state.days}日`;
  $<HTMLInputElement>("#dayStart").value = state.dayStart;
  $<HTMLInputElement>("#dayEnd").value = state.dayEnd;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === state.mode));
  }
  $<HTMLInputElement>("#norikaeUrl").value = state.norikaeUrl;
  $<HTMLInputElement>("#useNorikae").checked = state.useNorikae;
}

function renderBase(): void {
  suggest.refresh();
  const box = $("#base");
  if (state.base) {
    const b = state.base;
    box.innerHTML = `
      <div class="base">
        <div class="nm"><b>${esc(b.name)}</b><small>${esc(b.area ?? "")}</small></div>
        <button type="button" class="link" id="changeBase">変更</button>
      </div>
      <label class="field sub">最寄り駅（乗換案内と、おすすめの起点に使う）<input id="baseStation" value="${esc(b.station ?? "")}" placeholder="例：京都" /></label>
      <p class="note" id="stationNote">${b.station && b.stationLat !== undefined ? `${esc(stationName(b.station))}駅 を起点にして、おすすめと移動時間を考えます` : ""}</p>`;
    $("#changeBase").addEventListener("click", () => {
      state.base = null;
      changed();
      renderBase();
    });
    $<HTMLInputElement>("#baseStation").addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (!state.base) return;
      state.base.station = v || undefined;
      state.base.stationLat = state.base.stationLng = undefined;
      $("#stationNote").textContent = v ? "駅の場所を調べています…" : "";
      changed();
      suggest.refresh();
      if (v) void locateStation();
    });
    if (b.station && b.stationLat === undefined) void locateStation();
  } else {
    searchBox(box, "ホテル名・駅名など", (c) => {
      state.base = { name: c.name, area: c.area, lat: c.lat, lng: c.lng };
      changed();
      renderBase();
    });
  }
}

function renderSpots(): void {
  const list = $("#spots");
  $("#spotCount").textContent = state.spots.length ? `${state.spots.length}か所` : "";
  $("#spotsEmpty").hidden = state.spots.length > 0;
  const dayOptions = (sel?: number) =>
    `<option value="">おまかせ</option>` +
    Array.from({ length: state.days }, (_, i) => `<option value="${i + 1}"${sel === i + 1 ? " selected" : ""}>${i + 1}日目</option>`).join("");
  const stayOptions = (v: number) =>
    [...new Set([...STAY_OPTIONS, v])]
      .sort((a, b) => a - b)
      .map((m) => `<option value="${m}"${m === v ? " selected" : ""}>${m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`}</option>`)
      .join("");

  list.innerHTML = state.spots
    .map(
      (s) => `
    <li class="spot" data-id="${s.id}">
      <div class="row1">
        <button type="button" class="star" data-act="star" aria-pressed="${s.priority === "must"}" title="必ず行きたい">★</button>
        <div class="nm"><b>${esc(s.name)}</b><small>${esc(s.area ?? "")}</small></div>
        <select data-f="stayMinutes" aria-label="滞在時間">${stayOptions(s.stayMinutes)}</select>
        <button type="button" class="del" data-act="del" aria-label="削除">×</button>
      </div>
      <details${openDetails.has(s.id) ? " open" : ""}>
        <summary>${detailSummary(s)}</summary>
        <div class="grid2">
          <label class="field sub">開く<input type="time" data-f="open" value="${s.open ?? ""}" step="300" /></label>
          <label class="field sub">閉まる<input type="time" data-f="close" value="${s.close ?? ""}" step="300" /></label>
          <label class="field sub">行く日<select data-f="day">${dayOptions(s.day)}</select></label>
          <label class="field sub">最寄り駅<input data-f="station" value="${esc(s.station ?? "")}" placeholder="乗換案内で使う" /></label>
        </div>
      </details>
    </li>`,
    )
    .join("");
}

function detailSummary(s: SpotItem): string {
  const bits = [
    s.open || s.close ? `${s.open ?? ""}〜${s.close ?? ""}` : "",
    s.day ? `${s.day}日目` : "",
    s.station ? `${s.station}駅` : "",
  ].filter(Boolean);
  return bits.length ? esc(bits.join("・")) : "営業時間・行く日・最寄り駅";
}

function bindInputs(): void {
  $("#startDate").addEventListener("change", (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (v) state.startDate = v;
    changed();
  });
  for (const id of ["dayStart", "dayEnd"] as const) {
    $(`#${id}`).addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value;
      if (v) state[id] = v;
      changed();
    });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>(".stepper button")) {
    b.addEventListener("click", () => {
      state.days = Math.min(14, Math.max(1, state.days + Number(b.dataset.step)));
      for (const s of state.spots) if (s.day && s.day > state.days) s.day = undefined;
      renderTrip();
      renderSpots();
      changed();
    });
  }
  $("#mode").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (!b) return;
    state.mode = b.dataset.mode as TravelMode;
    renderTrip();
    suggest.refresh();
    changed();
  });
  $("#norikaeUrl").addEventListener("change", (e) => {
    state.norikaeUrl = (e.target as HTMLInputElement).value.trim();
    save();
  });
  $("#useNorikae").addEventListener("change", (e) => {
    state.useNorikae = (e.target as HTMLInputElement).checked;
    save();
  });

  const list = $("#spots");
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    const li = b?.closest<HTMLElement>(".spot");
    const spot = li && state.spots.find((s) => s.id === li.dataset.id);
    if (!b || !spot) return;
    if (b.dataset.act === "del") {
      state.spots = state.spots.filter((s) => s !== spot);
      renderSpots();
      suggest.refresh();
    } else {
      spot.priority = spot.priority === "must" ? "want" : "must";
      b.setAttribute("aria-pressed", String(spot.priority === "must"));
    }
    changed();
  });
  list.addEventListener("change", (e) => {
    const field = e.target as HTMLInputElement | HTMLSelectElement;
    const li = field.closest<HTMLElement>(".spot");
    const spot = li && state.spots.find((s) => s.id === li.dataset.id);
    const key = field.dataset.f;
    if (!spot || !key) return;
    const v = field.value.trim();
    if (key === "stayMinutes") spot.stayMinutes = Number(v);
    else if (key === "day") spot.day = v ? Number(v) : undefined;
    else if (key === "open" || key === "close" || key === "station") spot[key] = v || undefined;
    const summary = li.querySelector("summary");
    if (summary) summary.innerHTML = detailSummary(spot);
    changed();
  });
  list.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    const id = d.closest<HTMLElement>(".spot")?.dataset.id;
    if (!id) return;
    if (d.open) openDetails.add(id);
    else openDetails.delete(id);
  }, true);

  searchBox($("#spotSearch"), "清水寺、東京タワー など", (c) => {
    if (state.spots.some((s) => s.name === c.name && Math.abs(s.lat - c.lat) < 1e-4)) {
      toast(`${c.name} はもう入っています`);
      return;
    }
    state.spots.push({ id: uid(), name: c.name, area: c.area, lat: c.lat, lng: c.lng, stayMinutes: 60, priority: "want" });
    renderSpots();
    changed();
    toast(`${c.name} を追加しました`);
  });

  $("#loadSample").addEventListener("click", () => {
    const req = sample as TripRequest;
    Object.assign(state, {
      startDate: req.startDate,
      days: req.days,
      dayStart: req.dayStart ?? "09:00",
      dayEnd: req.dayEnd ?? "19:00",
      mode: req.mode ?? "transit",
      base: { ...req.base, area: "京都府京都市下京区" },
      spots: req.spots.map((s) => ({ ...s, id: uid() })),
    });
    renderTrip();
    renderBase();
    renderSpots();
    changed();
  });

  $("#planBtn").addEventListener("click", () => void makePlan());
  $("#saveIcs").addEventListener("click", () => void saveIcs());
  $("#copyText").addEventListener("click", () => void copyText());
}

/** 入力が変わったとき：保存して、地図と「つくり直してね」の表示を更新する */
function changed(): void {
  save();
  if (itinerary) {
    dirty = true;
    renderStatus();
  } else {
    map.showPlaces(origin(), state.spots);
  }
}

/* ---------- 旅程をつくる ---------- */

function buildRequest(): TripRequest | null {
  if (!state.base) {
    toast("宿・出発地を決めてください");
    $("#base input")?.focus();
    return null;
  }
  if (!state.spots.length) {
    toast("行きたい場所を追加してください");
    $("#spotSearch input")?.focus();
    return null;
  }
  const base = origin()!;
  base.name = state.base.name;
  return {
    startDate: state.startDate,
    days: state.days,
    dayStart: state.dayStart,
    dayEnd: state.dayEnd,
    mode: state.mode,
    base,
    spots: state.spots.map(({ id: _i, area: _a, ...s }) => s),
  };
}

let statusText = "";

async function makePlan(): Promise<void> {
  const req = buildRequest();
  if (!req) return;
  let plan: Itinerary;
  try {
    plan = planTrip(req);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return;
  }
  const seq = ++planSeq;
  itinerary = plan;
  dirty = false;
  statusText = "";
  renderResult();
  $(".col-result").scrollIntoView({ behavior: "smooth", block: "start" });

  const transitCount = plan.days.reduce((n, d) => n + d.items.filter((i) => i.kind === "move" && i.mode === "transit").length, 0);
  if (state.useNorikae && state.norikaeUrl && transitCount > 0) {
    statusText = `のりかえで電車を調べています… 0/${transitCount}`;
    renderStatus();
    const refined = await refineWithTransit(plan, new NorikaeProvider(state.norikaeUrl), {
      onProgress: (done, total) => {
        if (seq !== planSeq) return;
        statusText = `のりかえで電車を調べています… ${done}/${total}`;
        renderStatus();
      },
    });
    if (seq !== planSeq) return; // 途中でつくり直した
    const moves = refined.days.flatMap((d) => d.items).filter((i): i is Move => i.kind === "move" && i.mode === "transit");
    const found = moves.filter((m) => m.transit).length;
    statusText =
      found === moves.length
        ? "のりかえで調べた実際の電車に合わせました"
        : found === 0
          ? "のりかえで電車を調べられなかったので、移動時間は概算です（設定の URL を確認してください）"
          : `${moves.length}区間のうち${found}区間を実際の電車に合わせました（残りは概算）`;
    itinerary = refined;
    renderResult();
  } else {
    statusText = "移動時間は直線距離からの概算です";
    renderStatus();
  }
}

function renderResult(): void {
  store(PLAN_KEY, itinerary);
  renderStatus();
  const box = $("#itinerary");
  $("#export").hidden = !itinerary;
  if (!itinerary) {
    box.innerHTML = "";
    map.showPlaces(origin(), state.spots);
    return;
  }
  map.showItinerary(itinerary);
  const it = itinerary;
  box.innerHTML =
    it.days.map((d) => renderDay(d, it)).join("") +
    (it.unscheduled.length
      ? `<div class="card unscheduled"><h3>入らなかった場所</h3><ul>${it.unscheduled
          .map((u) => `<li><b>${esc(u.spot.name)}</b><small>${esc(u.reason)}</small></li>`)
          .join("")}</ul></div>`
      : "");
}

function renderStatus(): void {
  const el = $("#status");
  const msgs: string[] = [];
  if (dirty) msgs.push(`<span>条件が変わりました。</span><button type="button" class="link" data-replan>つくり直す</button>`);
  else if (statusText) msgs.push(`<span>${esc(statusText)}</span>`);
  el.hidden = msgs.length === 0;
  el.innerHTML = msgs.join("");
  el.querySelector("[data-replan]")?.addEventListener("click", () => void makePlan());
}

function renderDay(day: Itinerary["days"][number], it: Itinerary): string {
  const color = dayColor(day.day);
  const visits = day.items.filter((i) => i.kind === "visit").length;
  const head = `<h3><span class="dot"></span>${day.day}日目 <small>${md(day.date)}</small>
    <span class="end">${visits ? `宿に ${formatHM(day.end)} ごろ帰着` : ""}</span></h3>`;
  if (!visits) return `<div class="card day" style="--c:${color}">${head}<p class="muted">予定なし（自由行動）</p></div>`;
  let n = 0;
  const rows = day.items
    .map((item) => (item.kind === "visit" ? renderVisit(item, ++n) : renderMove(item, day.date)))
    .join("");
  return `<div class="card day" style="--c:${color}">${head}
    ${day.warning ? `<p class="warn">${esc(day.warning)}</p>` : ""}
    <ol class="tl">
      <li class="t-base"><time>${formatHM(day.start)}</time><div>${esc(baseLabel(it.request.base))} を出発</div></li>
      ${rows}
      <li class="t-base"><time>${formatHM(day.end)}</time><div>${esc(baseLabel(it.request.base))} に到着</div></li>
    </ol></div>`;
}

function renderVisit(v: Visit, n: number): string {
  const wait = v.start - v.arrive;
  const notes = [
    `${v.spot.stayMinutes}分`,
    v.spot.priority === "must" ? "★" : "",
    wait > 0 ? `${formatHM(v.arrive)}着・開場待ち${wait}分` : "",
    v.spot.close ? `${v.spot.close}まで` : "",
  ].filter(Boolean);
  return `<li class="t-visit"><time>${formatHM(v.start)}<br /><span>${formatHM(v.end)}</span></time>
    <div class="vcard"><span class="num">${n}</span><div><b>${esc(v.spot.name)}</b><small>${esc(notes.join("・"))}</small>
    ${v.warning ? `<p class="warn">${esc(v.warning)}</p>` : ""}</div></div></li>`;
}

function renderMove(m: Move, date: string): string {
  const depart = formatHM(m.depart);
  const links: string[] = [];
  if (m.mode === "transit") {
    links.push(
      state.norikaeUrl
        ? `<a href="${esc(norikaeAppUrl(state.norikaeUrl, m.from, m.to, date, depart))}" target="_blank" rel="noopener">のりかえ</a>`
        : `<a href="${esc(yahooTransitUrl(m.from, m.to, date, m.depart))}" target="_blank" rel="noopener">乗換案内</a>`,
    );
  }
  links.push(`<a href="${esc(googleMapsDirectionsUrl(m.from, m.to, m.mode))}" target="_blank" rel="noopener">地図</a>`);

  let body: string;
  if (m.transit) {
    const s = m.transit.summary;
    const meta = [
      s.duration,
      s.transfers != null ? (s.transfers ? `乗換${s.transfers}回` : "乗換なし") : "",
      s.fare != null ? `${s.fare.toLocaleString()}円` : "",
    ].filter(Boolean);
    body = `<div class="mv-main"><b>${esc(s.dep)}発 → ${esc(s.arr)}着</b><span>${esc(meta.join("・"))}</span></div>
      ${renderRoute(m.transit.steps)}`;
  } else {
    body = `<div class="mv-main"><b>${MODE_LABEL[m.mode]} 約${m.minutes}分</b>
      <span>${m.distanceKm.toFixed(1)}km・概算${m.transitNote ? `（${esc(m.transitNote.replace(/ので概算です$/, ""))}）` : ""}</span></div>`;
  }
  return `<li class="t-move m-${m.mode}"><time>${depart}</time><div class="mv">${body}<div class="links">${links.join("")}</div></div></li>`;
}

/** 乗る駅・乗り換える駅・降りる駅の時刻と、乗る電車。途中の駅は開くと見られる */
function renderRoute(steps: NonNullable<Move["transit"]>["steps"]): string {
  const rows = steps.map((st) => {
    if (st.kind === "station") {
      const times = [st.arr && `<span>${esc(st.arr)}着</span>`, st.dep && `<b>${esc(st.dep)}発</b>`].filter(Boolean).join("");
      return `<li class="rt-st"><span class="rt-t">${times}</span><span class="rt-dot"></span><b class="rt-nm">${esc(st.name)}</b></li>`;
    }
    const detail = [st.walk ? "" : st.destination, st.platform, st.walk ? "" : st.stops].filter(Boolean).join("・");
    const stops = st.stopList?.length
      ? `<details class="rt-stops"><summary>途中の駅（${st.stopList.length}駅）</summary><ul>${st.stopList
          .map((x) => `<li><span class="rt-t">${esc(x.time)}</span>${esc(x.name)}</li>`)
          .join("")}</ul></details>`
      : "";
    return `<li class="rt-ac${st.walk ? " walk" : ""}" style="${st.color ? `--lc:${esc(st.color)}` : ""}">
      <span class="rt-t"></span><span class="rt-bar"></span>
      <div><span class="rt-ln">${esc(st.line || (st.walk ? "徒歩" : ""))}</span>${detail ? `<small>${esc(detail)}</small>` : ""}${stops}</div></li>`;
  });
  return `<ol class="rt">${rows.join("")}</ol>`;
}

/* ---------- 書き出し ---------- */

async function saveIcs(): Promise<void> {
  if (!itinerary) return;
  const ics = toIcs(itinerary, { norikaeUrl: state.norikaeUrl || undefined });
  const name = `travel-${itinerary.request.startDate}.ics`;
  const file = new File([ics], name, { type: "text/calendar" });
  // iPhone では共有シートの「"ファイル"に保存」から、ひび手帳で読み込める
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyText(): Promise<void> {
  if (!itinerary) return;
  try {
    await navigator.clipboard.writeText(toMarkdown(itinerary, { norikaeUrl: state.norikaeUrl || undefined }));
    toast("旅程をコピーしました");
  } catch {
    toast("コピーできませんでした");
  }
}

/* ---------- 起動 ---------- */

renderTrip();
renderBase();
renderSpots();
bindInputs();
if (itinerary) {
  statusText = "前回つくった旅程です";
  renderResult();
} else {
  map.showPlaces(origin(), state.spots);
}
