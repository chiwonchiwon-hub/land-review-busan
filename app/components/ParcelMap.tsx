"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BuildingDesign, LandGroup } from "@/lib/land-types";
import { createBuildingLayer } from "./building-3d";

// 지도 계산용 worker 파일. Next.js가 자동으로 내보내지 않아서
// "npm run dev" 전에 public/ 폴더로 복사해 둔 파일을 씁니다 (package.json의 copy-map-worker)
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

// OSM 데이터 기반 무료 지도 스타일 (키 필요 없음)
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// 검토 지역: 부산광역시 전체가 보이는 시작 위치 (검색하면 결과가 보이도록 지도가 움직임)
const SUYEONG_CENTER: [number, number] = [129.05, 35.17];

// 이 확대 수준 이상일 때만 필지 경계를 불러옵니다 (너무 넓으면 필지가 수천 개라서)
const PARCEL_MIN_ZOOM = 16;

// 추천 토지 색: 소유 구분별 (여러 구분이 섞이면 보라색)
export const OWNER_COLORS: Record<string, string> = {
  국유지: "#dc2626",
  "시 도유지": "#ea580c",
  군유지: "#16a34a",
  mixed: "#7c3aed",
};

export const groupColor = (g: Pick<LandGroup, "ownerTypes">) =>
  g.ownerTypes.length === 1 ? OWNER_COLORS[g.ownerTypes[0]] : OWNER_COLORS.mixed;

type Status = { kind: "info" | "loading" | "error"; text: string };

// 외부 데이터를 팝업 HTML에 넣기 전에 특수 문자를 바꿉니다
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type MapView = "2d" | "3d";

// 2D는 위에서 내려다보기, 3D는 기울여서 보기
const cameraFor = (v: MapView) => (v === "3d" ? { pitch: 62, bearing: -25 } : { pitch: 0, bearing: 0 });

const DESIGN_LAYER = "design-3d";

type Props = {
  groups: LandGroup[];
  selectedId: string | null;
  onSelectGroup: (id: string) => void;
  design: BuildingDesign | null;
  view: MapView;
  onViewChange: (view: MapView) => void;
};

export default function ParcelMap({ groups, selectedId, onSelectGroup, design, view, onViewChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onSelectRef = useRef(onSelectGroup);
  const viewRef = useRef(view);
  const rotateModeRef = useRef(false);
  const [rotateMode, setRotateMode] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({
    kind: "info",
    text: "지도를 확대하면 필지 경계가 보입니다.",
  });

  useEffect(() => {
    onSelectRef.current = onSelectGroup;
  }, [onSelectGroup]);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: SUYEONG_CENTER,
      zoom: 10.5,
      dragRotate: false, // 회전은 아래에서 직접 구현 (우클릭 드래그, 회전 모드, 버튼)
      maxPitch: 80,
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __map?: maplibregl.Map }).__map = map; // 개발 중 점검용
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");

    // 마우스 오른쪽 버튼을 누른 채 움직이면 회전(좌우)·기울기(상하). 회전 모드에서는 왼쪽 버튼으로도 됨.
    const container = map.getCanvasContainer();
    const noMenu = (e: Event) => e.preventDefault();
    container.addEventListener("contextmenu", noMenu);
    let drag: { x: number; y: number; bearing: number; pitch: number } | null = null;
    const onDown = (e: MouseEvent) => {
      if (!(e.button === 2 || (e.button === 0 && rotateModeRef.current))) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
      container.style.cursor = "grabbing";
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      map.jumpTo({
        bearing: drag.bearing - (e.clientX - drag.x) * 0.4, // 오른쪽으로 끌면 장면이 시계 방향으로 돎
        pitch: Math.min(80, Math.max(0, drag.pitch - (e.clientY - drag.y) * 0.3)), // 위로 끌면 더 눕힘
      });
    };
    const onUp = () => {
      if (!drag) return;
      drag = null;
      container.style.cursor = "";
    };
    container.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // 패널을 넓히거나 좁혀서 지도 칸 크기가 바뀌면 지도도 다시 맞춤 (창 크기가 바뀔 때만 자동으로 맞춰짐)
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    let abort: AbortController | null = null;

    async function loadParcels() {
      const source = map.getSource<maplibregl.GeoJSONSource>("parcels");
      if (!source) return;

      if (map.getZoom() < PARCEL_MIN_ZOOM) {
        abort?.abort();
        source.setData({ type: "FeatureCollection", features: [] });
        setStatus({ kind: "info", text: "지도를 확대하면 필지 경계가 보입니다." });
        return;
      }

      const b = map.getBounds();
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(6)).join(",");

      abort?.abort();
      abort = new AbortController();
      setStatus({ kind: "loading", text: "필지 경계를 불러오는 중…" });

      try {
        const res = await fetch(`/api/parcels?bbox=${bbox}`, { signal: abort.signal });
        const data = await res.json();
        if (!res.ok) {
          setStatus({ kind: "error", text: data.error ?? "필지 정보를 가져오지 못했습니다." });
          return;
        }
        source.setData(data);
        const shown = data.features.length;
        setStatus({
          kind: "info",
          text: shown < data.total ? `필지 ${shown}개 표시 (전체 ${data.total}개 중 일부, 더 확대해 주세요)` : `필지 ${shown}개 표시`,
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setStatus({ kind: "error", text: "필지 정보를 가져오지 못했습니다." });
        }
      }
    }

    map.on("load", () => {
      map.addSource("parcels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "parcels-fill",
        type: "fill",
        source: "parcels",
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.04 },
      });
      map.addLayer({
        id: "parcels-line",
        type: "line",
        source: "parcels",
        paint: { "line-color": "#2563eb", "line-width": 0.6, "line-opacity": 0.6 },
      });

      // 추천 토지(일단의 토지) 표시
      map.addSource("groups", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "groups-fill",
        type: "fill",
        source: "groups",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["case", ["boolean", ["get", "selected"], false], 0.55, 0.35],
        },
      });
      map.addLayer({
        id: "groups-line",
        type: "line",
        source: "groups",
        paint: {
          "line-color": ["case", ["boolean", ["get", "selected"], false], "#111827", ["get", "color"]],
          "line-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
        },
      });

      setLoaded(true);
      loadParcels();
    });
    map.on("moveend", loadParcels);

    // 추천 토지를 누르면 목록에서 선택
    map.on("click", "groups-fill", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) onSelectRef.current(id);
    });

    // 추천 토지가 아닌 필지를 누르면 주소와 공시지가를 보여 줍니다
    map.on("click", "parcels-fill", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["groups-fill"] }).length) return;
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const price = Number(p.jiga).toLocaleString("ko-KR");
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${escapeHtml(p.addr)}</strong><br/>지목: ${escapeHtml(p.jibun.replace(/^[\d-]+/, ""))}<br/>` +
            `공시지가: ㎡당 ${price}원 (${escapeHtml(`${p.gosi_year}.${p.gosi_month}`)})`,
        )
        .addTo(map);
    });
    for (const layer of ["parcels-fill", "groups-fill"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    return () => {
      container.removeEventListener("contextmenu", noMenu);
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      resizeObserver.disconnect();
      abort?.abort();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 추천 결과가 바뀌면 지도에 다시 그리고, 결과 전체가 보이게 이동
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.getSource<maplibregl.GeoJSONSource>("groups")?.setData({
      type: "FeatureCollection",
      features: groups.map((g) => ({
        type: "Feature",
        geometry: g.geometry,
        properties: { id: g.id, color: groupColor(g), selected: g.id === selectedId },
      })),
    });
  }, [groups, selectedId, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || groups.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const g of groups) bounds.extend([g.bbox[0], g.bbox[1], g.bbox[2], g.bbox[3]]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 17, ...cameraFor(viewRef.current) });
  }, [groups, loaded]);

  // 선택한 토지로 이동하고, 2D/3D 보기에 맞게 카메라를 기울이거나 세움 (두 동작이 서로 끊지 않게 한 곳에서 처리)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const g = groups.find((x) => x.id === selectedId);
    if (g) map.fitBounds(g.bbox, { padding: 60, maxZoom: 17, ...cameraFor(view), duration: 900 });
    else map.easeTo({ ...cameraFor(view), duration: 900 });
  }, [selectedId, groups, loaded, view]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 회전 모드: 왼쪽 드래그가 이동 대신 회전이 되도록 지도 이동을 잠시 끔
  useEffect(() => {
    rotateModeRef.current = rotateMode;
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (rotateMode) map.dragPan.disable();
    else map.dragPan.enable();
  }, [rotateMode, loaded]);

  const turn = (delta: { bearing?: number; pitch?: number; reset?: boolean }) => {
    const map = mapRef.current;
    if (!map) return;
    if (delta.reset) map.easeTo({ bearing: 0, duration: 500 });
    else
      map.easeTo({
        bearing: map.getBearing() + (delta.bearing ?? 0),
        pitch: Math.min(80, Math.max(0, map.getPitch() + (delta.pitch ?? 0))),
        duration: 400,
      });
  };

  // 설계한 건물을 Three.js 3D 레이어로 지도에 올림
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const remove = () => {
      try {
        if (map.getLayer(DESIGN_LAYER)) map.removeLayer(DESIGN_LAYER);
      } catch {
        // 지도가 이미 정리된 뒤라면 할 일이 없음
      }
    };
    remove();
    if (design && design.buildings.length > 0) map.addLayer(createBuildingLayer(DESIGN_LAYER, design));
    return remove;
  }, [design, loaded]);

  return (
    <div className="relative flex-1">
      {/* MapLibre가 position: relative를 덮어쓰므로 absolute 대신 h-full로 크기를 줍니다 */}
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute left-3 top-14 flex overflow-hidden rounded-md bg-white text-sm shadow" role="group" aria-label="지도 보기 방식">
        {(["2d", "3d"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onViewChange(v)}
            className={`px-3 py-1.5 font-medium ${view === v ? "bg-blue-600 text-white" : "text-zinc-700 hover:bg-zinc-100"}`}
            aria-pressed={view === v}
          >
            {v === "2d" ? "2D" : "3D"}
          </button>
        ))}
      </div>
      <div className="absolute left-3 top-24 w-44 rounded-md bg-white/95 p-2 text-xs shadow">
        <div className="mb-1 font-medium text-zinc-700">3D 보기 조절</div>
        <div className="grid grid-cols-4 gap-1">
          <button type="button" title="왼쪽으로 45° 돌리기" aria-label="왼쪽으로 45° 돌리기" onClick={() => turn({ bearing: -45 })} className="rounded border border-zinc-300 py-1 hover:bg-zinc-100">
            ⟲
          </button>
          <button type="button" title="오른쪽으로 45° 돌리기" aria-label="오른쪽으로 45° 돌리기" onClick={() => turn({ bearing: 45 })} className="rounded border border-zinc-300 py-1 hover:bg-zinc-100">
            ⟳
          </button>
          <button type="button" title="더 눕히기(기울기 +10°)" aria-label="더 눕히기" onClick={() => turn({ pitch: 10 })} className="rounded border border-zinc-300 py-1 hover:bg-zinc-100">
            ▲
          </button>
          <button type="button" title="더 세우기(기울기 -10°)" aria-label="더 세우기" onClick={() => turn({ pitch: -10 })} className="rounded border border-zinc-300 py-1 hover:bg-zinc-100">
            ▼
          </button>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <button type="button" onClick={() => turn({ reset: true })} className="rounded border border-zinc-300 py-1 hover:bg-zinc-100">
            북쪽 보기
          </button>
          <button
            type="button"
            onClick={() => setRotateMode((m) => !m)}
            aria-pressed={rotateMode}
            className={`rounded border py-1 ${rotateMode ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-300 hover:bg-zinc-100"}`}
            title="켜면 왼쪽 버튼을 누르고 움직여 회전할 수 있어요 (끄면 지도 이동)"
          >
            회전 모드
          </button>
        </div>
        <p className="mt-1 leading-snug text-zinc-500">마우스 <b>오른쪽 버튼</b>을 누른 채 움직이면 돌리고(좌우), 눕힙니다(상하).</p>
      </div>
      <div
        className={`absolute left-3 top-3 rounded-md px-3 py-2 text-sm shadow ${
          status.kind === "error" ? "bg-red-50 text-red-700" : "bg-white/90 text-zinc-800"
        }`}
      >
        {status.text}
      </div>
    </div>
  );
}
