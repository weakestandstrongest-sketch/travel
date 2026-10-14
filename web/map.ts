import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Itinerary, Place, Visit } from "../src/core/types.js";

export const DAY_COLORS = ["#E07F78", "#4F8ED6", "#5BB07A", "#E9A23B", "#9B7FD1", "#4AA3C8", "#D46FA8"];
export const dayColor = (day: number) => DAY_COLORS[(day - 1) % DAY_COLORS.length]!;

export class TripMap {
  private readonly map: L.Map;
  private readonly layer = L.layerGroup();

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([35.68, 139.76], 11);
    L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
    }).addTo(this.map);
    this.layer.addTo(this.map);
  }

  /** 旅程を作る前：宿と行きたい場所をそのまま表示 */
  showPlaces(base: Place | null, spots: Place[]): void {
    this.layer.clearLayers();
    const points: L.LatLngExpression[] = [];
    if (base) {
      this.baseMarker(base);
      points.push([base.lat, base.lng]);
    }
    for (const s of spots) {
      this.pin(s, "", "#8B8FA8");
      points.push([s.lat, s.lng]);
    }
    this.fit(points);
  }

  /** 旅程：日ごとに色分けして、回る順に番号と線を引く */
  showItinerary(it: Itinerary): void {
    this.layer.clearLayers();
    const base = it.request.base;
    const points: L.LatLngExpression[] = [[base.lat, base.lng]];
    this.baseMarker(base);
    for (const day of it.days) {
      const visits = day.items.filter((i): i is Visit => i.kind === "visit");
      if (!visits.length) continue;
      const color = dayColor(day.day);
      const path: L.LatLngExpression[] = [[base.lat, base.lng], ...visits.map((v) => [v.spot.lat, v.spot.lng] as L.LatLngExpression), [base.lat, base.lng]];
      L.polyline(path, { color, weight: 3, opacity: 0.75, dashArray: "6 6" }).addTo(this.layer);
      visits.forEach((v, i) => {
        this.pin(v.spot, `${day.day}-${i + 1}`, color);
        points.push([v.spot.lat, v.spot.lng]);
      });
    }
    for (const u of it.unscheduled) {
      this.pin(u.spot, "", "#B9B9C3");
      points.push([u.spot.lat, u.spot.lng]);
    }
    this.fit(points);
  }

  invalidate(): void {
    this.map.invalidateSize();
  }

  private pin(p: Place, label: string, color: string): void {
    const icon = L.divIcon({
      className: "pin",
      html: `<span style="--c:${color}">${label}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    L.marker([p.lat, p.lng], { icon, title: p.name }).bindTooltip(escapeHtml(p.name)).addTo(this.layer);
  }

  private baseMarker(p: Place): void {
    const icon = L.divIcon({ className: "pin base", html: "<span>宿</span>", iconSize: [34, 34], iconAnchor: [17, 17] });
    L.marker([p.lat, p.lng], { icon, title: p.name, zIndexOffset: 1000 }).bindTooltip(escapeHtml(p.name)).addTo(this.layer);
  }

  private fit(points: L.LatLngExpression[]): void {
    if (points.length === 1) this.map.setView(points[0]!, 14);
    else if (points.length > 1) this.map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 15 });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
