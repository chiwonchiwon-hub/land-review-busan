// 한국 아파트 단지에서 쓰는 동 평면 형태 (미터 단위, 왼쪽 아래 모서리가 원점).
//  · bar   판상형 "-자": 길쭉한 막대. 4베이 판상형이 분양에서 가장 선호되는 기본형
//  · L     ㄱ자: 모서리에서 꺾인 판상형. 코너 세대의 채광·조망을 늘림
//  · V     V자: 두 날개가 벌어진 판상형. 벌어진 쪽(남향)으로 조망·채광, 단지 안에 열린 마당이 생김
//  · Y     Y자: 세 날개가 120°로 벌어진 탑상형. 한 층에 많은 세대를 배치하면서 모든 세대가 창을 가짐
//  · tower 정방형 탑상형: 모서리를 깎은 사각 타워
// 판상형·탑상형을 섞는 "혼합형" 배치는 조경 면적을 늘리고 단지 스카이라인을 다양하게 해 최근 많이 쓰입니다.

import * as turf from "@turf/turf";
import type { XY } from "./land-types";

export type ShapeKind = "bar" | "L" | "V" | "Y" | "tower";

export type Tpl = {
  kind: ShapeKind;
  ring: XY[]; // 바깥 고리 (닫지 않음)
  w: number; // 둘러싸는 직사각형의 가로(m)
  d: number; // 세로(m)
  area: number; // 바닥 면적(㎡)
  minWidth: number; // 가장 얇은 부분의 너비(m): 높이 ≤ 너비 × 6 제한에 씀
  open?: boolean; // 한쪽이 벌어진 형태(V자): 벌어진 쪽이 +y. 남향이 되도록 배치할 때 뒤집음
};

function ringArea(r: XY[]) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(s) / 2;
}

// 중심 c, 방향 dir(단위벡터), 길이 len, 두께 t인 직사각형
function rect(c: XY, dir: XY, len: number, t: number): XY[] {
  const nx = -dir[1], ny = dir[0];
  const hl = len / 2, ht = t / 2;
  return [
    [c[0] - dir[0] * hl - nx * ht, c[1] - dir[1] * hl - ny * ht],
    [c[0] + dir[0] * hl - nx * ht, c[1] + dir[1] * hl - ny * ht],
    [c[0] + dir[0] * hl + nx * ht, c[1] + dir[1] * hl + ny * ht],
    [c[0] - dir[0] * hl + nx * ht, c[1] - dir[1] * hl + ny * ht],
  ];
}

// 평면 좌표(미터)의 다각형 여러 개를 합침. turf는 좌표 단위와 상관없이 평면 연산으로 합침
function unionRings(rings: XY[][]): XY[] {
  let u: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> = turf.polygon([[...rings[0], rings[0][0]]]);
  for (let i = 1; i < rings.length; i++) {
    const next = turf.polygon([[...rings[i], rings[i][0]]]);
    const r = turf.union(turf.featureCollection([u as GeoJSON.Feature<GeoJSON.Polygon>, next]));
    if (r) u = r as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  }
  const coords = u.geometry.type === "Polygon" ? u.geometry.coordinates : u.geometry.coordinates[0];
  return (coords[0].slice(0, -1) as XY[]).map((p) => [p[0], p[1]] as XY);
}

function finish(kind: ShapeKind, ring: XY[], minWidth: number, open = false): Tpl {
  const minX = Math.min(...ring.map((p) => p[0])), minY = Math.min(...ring.map((p) => p[1]));
  const shifted = ring.map((p) => [Math.round((p[0] - minX) * 100) / 100, Math.round((p[1] - minY) * 100) / 100] as XY);
  return {
    kind,
    ring: shifted,
    w: Math.max(...shifted.map((p) => p[0])),
    d: Math.max(...shifted.map((p) => p[1])),
    area: ringArea(shifted),
    minWidth,
    open,
  };
}

export const barShape = (w: number, t = 13) => finish("bar", [[0, 0], [w, 0], [w, t], [0, t]], t);

export function lShape(w: number, d: number, t: number) {
  return finish("L", unionRings([[[0, 0], [w, 0], [w, t], [0, t]], [[0, 0], [t, 0], [t, d], [0, d]]]), t);
}

// V자: 꼭짓점(apex)에서 두 날개가 위(+y)로 벌어짐. angle은 세로축에서 벌어진 각도
export function vShape(len: number, t: number, angleDeg = 32) {
  const a = (angleDeg * Math.PI) / 180;
  const d1: XY = [Math.sin(a), Math.cos(a)];
  const d2: XY = [-Math.sin(a), Math.cos(a)];
  const wing = (dir: XY) => rect([(dir[0] * len) / 2, (dir[1] * len) / 2], dir, len, t);
  return finish("V", unionRings([wing(d1), wing(d2)]), t, true);
}

// Y자: 가운데에서 세 날개가 120° 간격
export function yShape(arm: number, t: number) {
  const rings = [90, 210, 330].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const dir: XY = [Math.cos(a), Math.sin(a)];
    return rect([(dir[0] * arm) / 2, (dir[1] * arm) / 2], dir, arm, t);
  });
  return finish("Y", unionRings(rings), t);
}

// 정방형 탑상형 (모서리를 깎아 팔각형에 가깝게)
export function towerShape(side: number, cut = 4) {
  const s = side;
  return finish("tower", [[cut, 0], [s - cut, 0], [s, cut], [s, s - cut], [s - cut, s], [cut, s], [0, s - cut], [0, cut]], side - 2 * cut);
}

// 형태를 위아래로 뒤집음 (V자를 남향으로 열기 위해)
export function flipY(t: Tpl): Tpl {
  return { ...t, ring: t.ring.map(([x, y]) => [x, Math.round((t.d - y) * 100) / 100] as XY).reverse() };
}

export const KIND_LABEL: Record<ShapeKind, string> = { bar: "판상형", L: "ㄱ자형", V: "V자형", Y: "Y자형", tower: "탑상형" };
