// 접도 요건 판정: 땅의 경계가 너비 6m 이상 도로에 4m 이상 접하는가 (건축법 제44조, 시행령 제28조②).
// 도로 자료는 VWorld 국가기본도 도로(LT_L_N3A0020000)의 중심선과 도로 폭(rvwd)을 씁니다. 서버 쪽 코드에서만 import 하세요.
// 도시계획도로뿐 아니라 골목 같은 현황도로도 들어 있어, 도로 정보가 없다고 무조건 맹지로 단정하던 방식보다 정확합니다.

import { getRoadsInBox, type RoadLine } from "./vworld";

export type RoadAccess = {
  status: "ok" | "short" | "narrow" | "none" | "unknown";
  bestWidth: number | null; // 접한 도로 중 가장 넓은 도로 폭(m)
  wideContactM: number; // 너비 6m 이상 도로에 접한 길이(m)
  note: string;
};

const MIN_WIDTH = 6; // 연면적 2,000㎡ 이상 건축물의 대지가 접해야 하는 도로 너비(m)
const MIN_CONTACT = 4; // 그 도로에 접해야 하는 길이(m)
const STEP = 2; // 경계를 이 간격(m)으로 찍어 도로와의 거리를 잼
const TOL = 4; // 도로 중심선 ↔ 필지 경계의 위치 오차를 감안한 여유(m)
const TILE = 0.02;
const TILE_MS = 24 * 3600_000;

const tileCache = new Map<string, { at: number; roads: RoadLine[] }>();

async function roadsInBox(b: [number, number, number, number]): Promise<RoadLine[]> {
  const out: RoadLine[] = [];
  const seen = new Set<string>();
  for (let tx = Math.floor(b[0] / TILE); tx <= Math.floor(b[2] / TILE); tx++) {
    for (let ty = Math.floor(b[1] / TILE); ty <= Math.floor(b[3] / TILE); ty++) {
      const key = `${tx},${ty}`;
      let hit = tileCache.get(key);
      if (!hit || Date.now() - hit.at > TILE_MS) {
        hit = { at: Date.now(), roads: await getRoadsInBox(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE) };
        tileCache.set(key, hit);
        if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value as string);
      }
      for (const r of hit.roads) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }
  return out;
}

type Poly = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export async function checkRoadAccess(geometry: Poly, bbox: [number, number, number, number]): Promise<RoadAccess> {
  let roads: RoadLine[];
  try {
    roads = await roadsInBox([bbox[0] - 0.0005, bbox[1] - 0.0005, bbox[2] + 0.0005, bbox[3] + 0.0005]);
  } catch {
    return { status: "unknown", bestWidth: null, wideContactM: 0, note: "도로 자료를 불러오지 못했습니다" };
  }
  const lat0 = (bbox[1] + bbox[3]) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  const xy = (p: number[]): [number, number] => [(p[0] - bbox[0]) * kx, (p[1] - bbox[1]) * ky];

  // 경계(바깥 고리)를 STEP m 간격으로 찍음
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const pts: [number, number][] = [];
  for (const poly of polys) {
    const ring = poly[0].map(xy);
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / STEP));
      for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
  }
  if (pts.length === 0) return { status: "unknown", bestWidth: null, wideContactM: 0, note: "경계를 알 수 없습니다" };

  // 대지 주변의 도로만 미터 좌표로 바꿔 둠
  const pad = 60;
  const sb = [Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad, Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad];
  const near = roads
    .map((r) => ({ width: r.width, lines: r.lines.map((l) => l.map(xy)) }))
    .filter((r) => r.lines.some((l) => l.some(([x, y]) => x >= sb[0] && x <= sb[2] && y >= sb[1] && y <= sb[3])));

  const distToLine = (p: [number, number], l: [number, number][]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < l.length; i++) {
      const [ax, ay] = l[i], [bx, by] = l[i + 1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
    }
    return best;
  };

  let wide = 0;
  let touchAny = 0;
  let bestWidth = 0;
  for (const p of pts) {
    let pointWide = false;
    let pointAny = false;
    for (const r of near) {
      const reach = r.width / 2 + TOL;
      for (const l of r.lines) {
        if (distToLine(p, l) > reach) continue;
        pointAny = true;
        bestWidth = Math.max(bestWidth, r.width);
        if (r.width >= MIN_WIDTH) pointWide = true;
        break;
      }
      if (pointWide) break;
    }
    if (pointAny) touchAny++;
    if (pointWide) wide++;
  }
  const wideContactM = wide * STEP;
  const bw = bestWidth > 0 ? Math.round(bestWidth * 10) / 10 : null;
  if (wideContactM >= MIN_CONTACT) return { status: "ok", bestWidth: bw, wideContactM, note: `너비 ${bw}m 도로에 약 ${wideContactM}m 접함` };
  if (wide > 0) return { status: "short", bestWidth: bw, wideContactM, note: `너비 6m 이상 도로에 접한 길이가 약 ${wideContactM}m로 4m에 못 미침` };
  if (touchAny > 0) {
    // 국가기본도에는 폭을 모를 때 3m로 적은 길이 많아(전체의 1/3), 3m는 실제 폭이 아닐 수 있음
    const note = bw === 3 ? "접한 길의 폭이 자료에 3m로 적혀 있음(폭을 모를 때의 기본값일 수 있어 6m 이상인지 확인 필요)" : `접한 도로의 최대 너비가 ${bw}m로 6m에 못 미침`;
    return { status: "narrow", bestWidth: bw, wideContactM: 0, note };
  }
  return { status: "none", bestWidth: null, wideContactM: 0, note: "경계에 접한 도로가 없음 (맹지일 가능성)" };
}
