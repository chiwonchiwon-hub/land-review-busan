// 3D 건물 디자인 엔진: 대지 모양을 분석해서 어울리는 여러 안(대지 순응형, 판상형, 타워형, ㄱ자, ㄷ자, 계단식, 병렬 2동)을 만들고
// 점수를 매겨 추천합니다. 모든 안은 3단계에서 계산한 한도(건축면적·연면적·용도 상한)와 대지 안 배치를 지킵니다.
// 서버 쪽 코드(app/api/...)에서만 import 하세요.

import * as turf from "@turf/turf";
import type { ReviewDetail } from "./land-review";
import {
  DEFAULT_COVERAGE,
  DESIGN_KIND_NAME,
  type BuildingDesign,
  type DesignedBuilding,
  type DesignKind,
  type DesignParams,
  type DesignSet,
  type DesignVolume,
  type SiteMetrics,
  type XY,
} from "./land-types";
import { assessUse, capBelow, limitsFor, type UseLimit } from "./use-rules";

type Poly = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

const MAX_FLOORS = 60;
const SLENDER = 6; // 높이 ≤ 짧은 변 × 6 (지나치게 가는 건물을 막기 위해 정한 가정, 법 기준 아님)
const MIN_FOOTPRINT = 60; // 이보다 작은 건물은 놓지 않음(㎡)
const MIN_MARGIN = 0.1; // 지적도 좌표 오차 때문에 이격을 0으로 줘도 항상 띄우는 최소 거리(m)
const SAFETY = 0.997; // 한도에 딱 맞추지 않고 아주 조금 작게

const round2 = (n: number) => Math.round(n * 100) / 100;
const floor2 = (n: number) => Math.floor(n * 100) / 100;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

// ── 좌표 변환: 설계 기준점 근처에서 경도·위도 ↔ 미터(동·북) ──
function makeProjection(lng0: number, lat0: number) {
  const phi = (lat0 * Math.PI) / 180;
  const ky = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return {
    toXY: ([lng, lat]: XY): XY => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLL: ([x, y]: XY): XY => [lng0 + x / kx, lat0 + y / ky],
  };
}
type Proj = ReturnType<typeof makeProjection>;

const polygonsOf = (shape: Poly): XY[][][] =>
  (shape.geometry.type === "Polygon" ? [shape.geometry.coordinates] : shape.geometry.coordinates) as XY[][][];

function ringArea(ring: XY[]) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(s) / 2;
}

// 미터 좌표의 고리를 경도·위도 폴리곤으로
const llPoly = (ring: XY[], proj: Proj): GeoJSON.Feature<GeoJSON.Polygon> => {
  const pts = ring.map((p) => proj.toLL(p));
  return turf.polygon([[...pts, pts[0]]]);
};
const geoArea = (ring: XY[], proj: Proj) => turf.area(llPoly(ring, proj));

// rect가 shape 안에 완전히 들어가는가 (밖으로 나온 부분이 0.005㎡ 미만이면 계산 오차로 봄)
function within(feature: Poly, shape: Poly): boolean {
  try {
    const outside = turf.difference(turf.featureCollection([feature, shape])) as Poly | null;
    return !outside || turf.area(outside) < 0.005;
  } catch {
    return false;
  }
}

// 가장 작은 직사각형으로 감쌌을 때의 긴 변·짧은 변과 방향 (5도 간격 탐색)
function minRect(points: XY[]) {
  let best = { len: 0, wid: 0, theta: 0, area: Infinity };
  for (let deg = 0; deg < 180; deg += 5) {
    const th = (deg * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
    for (const [x, y] of points) {
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < a) a = u; if (u > cc) cc = u; if (v < b) b = v; if (v > d) d = v;
    }
    const w = cc - a, h = d - b;
    if (w * h < best.area) best = { len: Math.max(w, h), wid: Math.min(w, h), theta: w >= h ? th : th + Math.PI / 2, area: w * h };
  }
  return best;
}

// ── 격자로 "이 직사각형이 땅 안에 들어가는가"를 빠르게 판단해 가장 알맞은 직사각형을 찾음 ──
type Grid = { nx: number; ny: number; c: number; minX: number; minY: number; sum: Int32Array };

function buildGrid(rings: XY[][], cell: number): Grid | null {
  const pts = rings.flat();
  if (pts.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  let c = cell;
  let nx = Math.max(1, Math.ceil((maxX - minX) / c));
  let ny = Math.max(1, Math.ceil((maxY - minY) / c));
  while (nx * ny > 25000) {
    c *= 1.25;
    nx = Math.max(1, Math.ceil((maxX - minX) / c));
    ny = Math.max(1, Math.ceil((maxY - minY) / c));
  }
  const occ = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = minY + (j + 0.5) * c;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const [ax, ay] = ring[m];
        const [bx, by] = ring[k];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - minX) / c - 0.5));
      const to = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / c - 0.5));
      for (let i = from; i <= to; i++) occ[j * nx + i] = 1;
    }
  }
  const stride = nx + 1;
  const sum = new Int32Array(stride * (ny + 1));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      sum[(j + 1) * stride + i + 1] = occ[j * nx + i] + sum[j * stride + i + 1] + sum[(j + 1) * stride + i] - sum[j * stride + i];
  return { nx, ny, c, minX, minY, sum };
}

function findSpot(g: Grid, nw: number, nd: number, target?: XY): [number, number] | null {
  if (nw > g.nx || nd > g.ny) return null;
  const stride = g.nx + 1;
  const need = nw * nd;
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (let j = 0; j + nd <= g.ny; j++) {
    for (let i = 0; i + nw <= g.nx; i++) {
      const cnt = g.sum[(j + nd) * stride + i + nw] - g.sum[j * stride + i + nw] - g.sum[(j + nd) * stride + i] + g.sum[j * stride + i];
      if (cnt !== need) continue;
      if (!target) return [i, j];
      const cx = g.minX + (i + nw / 2) * g.c, cy = g.minY + (j + nd / 2) * g.c;
      const dist = (cx - target[0]) ** 2 + (cy - target[1]) ** 2;
      if (dist < bestDist) { bestDist = dist; best = [i, j]; }
    }
  }
  return best;
}

function pointInRing(p: XY, ring: XY[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const rot = ([x, y]: XY, th: number): XY => [x * Math.cos(th) + y * Math.sin(th), -x * Math.sin(th) + y * Math.cos(th)];
const unrot = ([x, y]: XY, th: number): XY => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)];

type Placement = { cx: number; cy: number; theta: number; w: number; d: number };

type PlaceOpts = { aspects: number[]; preferred: number; angles?: number[] };

// shape 안에 면적이 target에 최대한 가까운 직사각형을 놓음 (못 채우면 들어가는 가장 큰 것). 긴 변이 w(u 방향)
function placeRect(shape: Poly, target: number, proj: Proj, opts: PlaceOpts): Placement | null {
  const polys = polygonsOf(shape).map((poly) => poly.map((ring) => ring.map((p) => proj.toXY(p))));
  const polyArea = polys.reduce((s, poly) => s + ringArea(poly[0]) - poly.slice(1).reduce((t, r) => t + ringArea(r), 0), 0);
  if (polyArea < 4) return null;
  const T = Math.min(target, polyArea * 0.95);
  const centroid = proj.toXY(turf.centroid(shape).geometry.coordinates as XY);
  const cell = Math.min(3, Math.max(0.8, Math.sqrt(polyArea / 6000)));

  const degrees = opts.angles ? opts.angles.map((a) => (a * 180) / Math.PI) : Array.from({ length: 6 }, (_, i) => i * 30);
  if (!opts.angles) {
    const edges: { len: number; deg: number }[] = [];
    for (const poly of polys) {
      const ring = poly[0];
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const dx = ring[k][0] - ring[m][0], dy = ring[k][1] - ring[m][1];
        const len = Math.hypot(dx, dy);
        if (len >= 5) edges.push({ len, deg: ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180 });
      }
    }
    for (const e of edges.sort((a, b) => b.len - a.len).slice(0, 4)) if (!degrees.some((d) => Math.abs(d - e.deg) < 3)) degrees.push(e.deg);
  }

  const gridCache = new Map<number, Grid | null>();
  const gridFor = (theta: number) => {
    if (!gridCache.has(theta)) gridCache.set(theta, buildGrid(polys.flatMap((poly) => poly.map((ring) => ring.map((p) => rot(p, theta)))), cell));
    return gridCache.get(theta)!;
  };
  const dims = (aspect: number, s: number): [number, number] => [Math.sqrt(T * aspect) * s, Math.sqrt(T / aspect) * s];
  const cells = (g: Grid, w: number, d: number): [number, number] => [Math.max(1, Math.ceil(w / g.c)), Math.max(1, Math.ceil(d / g.c))];

  type Cand = { theta: number; aspect: number; s: number; area: number };
  const cands: Cand[] = [];
  for (const deg of degrees) {
    const theta = (deg * Math.PI) / 180;
    const g = gridFor(theta);
    if (!g) continue;
    for (const aspect of opts.aspects) {
      const fits = (s: number) => {
        const [w, d] = dims(aspect, s);
        const [nw, nd] = cells(g, w, d);
        return findSpot(g, nw, nd) !== null;
      };
      let s = 1;
      if (!fits(1)) {
        if (!fits(0.05)) continue;
        let lo = 0.05, hi = 1;
        for (let it = 0; it < 7; it++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid; else hi = mid;
        }
        s = lo;
      }
      cands.push({ theta, aspect, s, area: T * s * s });
    }
  }
  if (cands.length === 0) return null;
  const maxArea = Math.max(...cands.map((c) => c.area));
  const best = cands
    .filter((c) => c.area >= maxArea * 0.98)
    .sort((a, b) => Math.abs(Math.log(a.aspect / opts.preferred)) - Math.abs(Math.log(b.aspect / opts.preferred)))[0];

  const g = gridFor(best.theta);
  if (!g) return null;
  let [w, d] = dims(best.aspect, best.s);
  const [nw, nd] = cells(g, w, d);
  const spot = findSpot(g, nw, nd, rot(centroid, best.theta));
  if (!spot) return null;
  const [cx, cy] = unrot([g.minX + (spot[0] + nw / 2) * g.c, g.minY + (spot[1] + nd / 2) * g.c], best.theta);

  // 칸 단위로 찾았으므로 실제 도형으로 다시 확인하고, 벗어나면 조금씩 줄임
  for (let k = 0; k < 60; k++) {
    if (within(llPoly(rectRing({ cx, cy, theta: best.theta, w, d }, -w / 2, w / 2, -d / 2, d / 2), proj), shape)) return { cx, cy, theta: best.theta, w, d };
    w *= 0.985;
    d *= 0.985;
  }
  return null;
}

// 직사각형 배치(P)의 지역 좌표 u∈[u0,u1], v∈[v0,v1] 부분을 미터 좌표 고리로. su·sv=-1이면 그 축을 뒤집음
function rectRing(P: Placement, u0: number, u1: number, v0: number, v1: number, su = 1, sv = 1): XY[] {
  const ux = Math.cos(P.theta), uy = Math.sin(P.theta);
  const vx = -Math.sin(P.theta), vy = Math.cos(P.theta);
  const pt = (u: number, v: number): XY => [P.cx + su * u * ux + sv * v * vx, P.cy + su * u * uy + sv * v * vy];
  const ring = [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)];
  return su * sv < 0 ? ring.reverse() : ring;
}

// ── 안(案) 만들기 ──
type PV = { ring: XY[]; role: DesignVolume["role"]; weight: number };
type FloorsMode = "parallel" | "tower" | "tiers";
type Plan = { buildings: PV[][]; mode: FloorsMode; label: string };

type Ctx = { inset: Poly; proj: Proj; targetB: number };

// 안마다 건축면적을 얼마나 쓰는지의 기본 비율
type SingleKind = Exclude<DesignKind, "barComplex" | "towerComplex">;
const isComplex = (k: DesignKind): k is "barComplex" | "towerComplex" => k === "barComplex" || k === "towerComplex";
const KIND_FACTOR: Record<SingleKind, number> = { siteFit: 1, bar: 0.9, tower: 0.6, lshape: 1, courtyard: 1, stepped: 1, twin: 1 };

// 대지 순응형: 이격한 대지 안쪽을 건축면적 한도에 맞게 안쪽으로 줄여서 필지 모양을 따라가게 함
function genSiteFit(c: Ctx): Plan | null {
  let shape: Poly | undefined = c.inset;
  if (turf.area(c.inset) > c.targetB) {
    let lo = 0, hi = 90;
    for (let i = 0; i < 11; i++) {
      const mid = (lo + hi) / 2;
      const b = turf.buffer(c.inset, -mid, { units: "meters" }) as Poly | undefined;
      if (b && turf.area(b) > c.targetB) lo = mid; else hi = mid;
    }
    shape = turf.buffer(c.inset, -hi, { units: "meters" }) as Poly | undefined;
  }
  if (!shape) return null;
  let polys = polygonsOf(shape);
  polys = [polys.sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0]];
  if (polys[0].length > 1) return null; // 구멍(도로·남의 땅)이 있으면 바깥 고리만으로는 대지 밖을 덮게 되므로 다른 안으로 대신함
  const original = turf.polygon(polys[0]) as GeoJSON.Feature<GeoJSON.Polygon>;
  let part = original;
  try {
    const simple = turf.simplify(original, { tolerance: 0.000008, highQuality: true }) as GeoJSON.Feature<GeoJSON.Polygon>;
    // 단순화하면 모서리가 이격 안쪽 영역 밖으로 나갈 수 있어, 안에 들어올 때만 씀
    if (within(simple, c.inset)) part = simple;
  } catch {
    // 단순화하지 못하면 그대로 씀
  }
  const ring = (part.geometry.coordinates[0].slice(0, -1) as XY[]).map((p) => c.proj.toXY(p));
  if (ring.length < 3 || ringArea(ring) < 150 || minRect(ring).wid < 10) return null;
  return { buildings: [[{ ring, role: "main", weight: 1 }]], mode: "parallel", label: "대지 순응형" };
}

// 판상형: 긴 막대. 한쪽 끝은 조금 낮게
function genBar(c: Ctx): Plan | null {
  const P = placeRect(c.inset, c.targetB, c.proj, { aspects: [4, 3.5, 3, 2.5], preferred: 3.4 });
  if (!P || P.w * P.d < MIN_FOOTPRINT) return null;
  const cut = P.w * 0.62 - P.w / 2;
  return {
    buildings: [[
      { ring: rectRing(P, -P.w / 2, cut, -P.d / 2, P.d / 2), role: "main", weight: 1 },
      { ring: rectRing(P, cut, P.w / 2, -P.d / 2, P.d / 2), role: "wing", weight: 0.7 },
    ]],
    mode: "parallel",
    label: "판상형",
  };
}

// 저층부 + 타워: 넓은 저층부 위에 한쪽 모서리에 붙인 타워를 올림 (타워는 북쪽으로 보내 그림자가 대지 밖으로 가게)
function genTower(c: Ctx): Plan | null {
  const P = placeRect(c.inset, c.targetB, c.proj, { aspects: [1.5, 1.2, 2], preferred: 1.5 });
  if (!P || P.w * P.d < 200) return null;
  const ratio = 0.62;
  let best: { su: number; sv: number; y: number } | null = null;
  for (const su of [1, -1]) for (const sv of [1, -1]) {
    const t = rectRing(P, -P.w / 2, -P.w / 2 + P.w * ratio, -P.d / 2, -P.d / 2 + P.d * ratio, su, sv);
    const y = t.reduce((s, p) => s + p[1], 0) / 4;
    if (!best || y > best.y) best = { su, sv, y };
  }
  const { su, sv } = best!;
  return {
    buildings: [[
      { ring: rectRing(P, -P.w / 2, P.w / 2, -P.d / 2, P.d / 2), role: "base", weight: 1 },
      { ring: rectRing(P, -P.w / 2, -P.w / 2 + P.w * ratio, -P.d / 2, -P.d / 2 + P.d * ratio, su, sv), role: "tower", weight: 1 },
    ]],
    mode: "tower",
    label: "저층부 + 타워",
  };
}

// ㄱ자: 긴 막대와 짧은 막대를 ㄱ자로 붙여 남쪽으로 열린 마당을 만듦
function genL(c: Ctx): Plan | null {
  const P = placeRect(c.inset, c.targetB / 0.67, c.proj, { aspects: [1.5, 1.8, 1.3, 1.1], preferred: 1.5 });
  if (!P || P.d < 26 || P.w < 30) return null;
  const d1 = P.d * 0.45, w2 = P.w * 0.4;
  let best: { su: number; sv: number; y: number } | null = null;
  for (const su of [1, -1]) for (const sv of [1, -1]) {
    const notch = rectRing(P, -P.w / 2 + w2, P.w / 2, -P.d / 2 + d1, P.d / 2, su, sv);
    const y = notch.reduce((s, p) => s + p[1], 0) / 4;
    if (!best || y < best.y) best = { su, sv, y }; // 비어 있는 모서리가 남쪽
  }
  const { su, sv } = best!;
  return {
    buildings: [[
      { ring: rectRing(P, -P.w / 2, P.w / 2, -P.d / 2, -P.d / 2 + d1, su, sv), role: "main", weight: 1 },
      { ring: rectRing(P, -P.w / 2, -P.w / 2 + w2, -P.d / 2 + d1, P.d / 2, su, sv), role: "wing", weight: 0.75 },
    ]],
    mode: "parallel",
    label: "ㄱ자 중정형",
  };
}

// ㄷ자: 뒤쪽 막대와 양쪽 날개로 남쪽이 열린 중정을 만듦
function genU(c: Ctx): Plan | null {
  const P = placeRect(c.inset, c.targetB / 0.69, c.proj, { aspects: [1.8, 2.2, 1.5], preferred: 1.8 });
  if (!P || P.w < 45 || P.d < 28) return null;
  const d1 = P.d * 0.3, wing = P.w * 0.28;
  const vy = Math.cos(P.theta);
  const sv = vy > 0 ? -1 : 1; // 열린 쪽(+v)이 남쪽을 향하게
  return {
    buildings: [[
      { ring: rectRing(P, -P.w / 2, P.w / 2, -P.d / 2, -P.d / 2 + d1, 1, sv), role: "main", weight: 1 },
      { ring: rectRing(P, -P.w / 2, -P.w / 2 + wing, -P.d / 2 + d1, P.d / 2, 1, sv), role: "wing", weight: 0.75 },
      { ring: rectRing(P, P.w / 2 - wing, P.w / 2, -P.d / 2 + d1, P.d / 2, 1, sv), role: "wing", weight: 0.75 },
    ]],
    mode: "parallel",
    label: "ㄷ자 중정형",
  };
}

// 계단식 테라스: 남쪽으로 갈수록 낮아지는 층을 겹쳐 옥상 테라스를 만듦
function genStepped(c: Ctx): Plan | null {
  const P = placeRect(c.inset, c.targetB, c.proj, { aspects: [1.6, 1.3, 2], preferred: 1.6 });
  if (!P || P.w * P.d < 400 || P.d < 18) return null;
  const sv = Math.cos(P.theta) > 0 ? -1 : 1; // 낮은 쪽(+v)이 남쪽
  return {
    buildings: [[
      { ring: rectRing(P, -P.w / 2, P.w / 2, -P.d / 2, P.d / 2, 1, sv), role: "tier", weight: 1 },
      { ring: rectRing(P, -P.w / 2, P.w / 2, -P.d / 2, P.d / 2 - P.d * 0.3, 1, sv), role: "tier", weight: 1 },
      { ring: rectRing(P, -P.w * 0.4, P.w * 0.4, -P.d / 2, P.d / 2 - P.d * 0.58, 1, sv), role: "tier", weight: 1 },
    ]],
    mode: "tiers",
    label: "계단식 테라스",
  };
}

// 병렬 2동: 같은 방향의 두 막대 사이에 마당을 둠
function genTwin(c: Ctx): Plan | null {
  const half = c.targetB / 2;
  const P1 = placeRect(c.inset, half, c.proj, { aspects: [3, 2.5, 3.5], preferred: 3 });
  if (!P1 || P1.w * P1.d < MIN_FOOTPRINT) return null;
  const bar1 = llPoly(rectRing(P1, -P1.w / 2, P1.w / 2, -P1.d / 2, P1.d / 2), c.proj);
  let remainder: Poly | null = null;
  try {
    const grown = turf.buffer(bar1, Math.max(12, P1.d * 0.9), { units: "meters" }) as Poly;
    remainder = turf.difference(turf.featureCollection([c.inset, grown])) as Poly | null;
  } catch {
    return null;
  }
  if (!remainder) return null;
  const P2 = placeRect(remainder, half, c.proj, { aspects: [3, 2.5, 3.5], preferred: 3, angles: [P1.theta] });
  if (!P2 || P2.w * P2.d < MIN_FOOTPRINT) return null;
  return {
    buildings: [
      [{ ring: rectRing(P1, -P1.w / 2, P1.w / 2, -P1.d / 2, P1.d / 2), role: "main", weight: 1 }],
      [{ ring: rectRing(P2, -P2.w / 2, P2.w / 2, -P2.d / 2, P2.d / 2), role: "main", weight: 1 }],
    ],
    mode: "parallel",
    label: "병렬 2동",
  };
}

const GENERATORS: Record<SingleKind, (c: Ctx) => Plan | null> = {
  siteFit: genSiteFit,
  bar: genBar,
  tower: genTower,
  lshape: genL,
  courtyard: genU,
  stepped: genStepped,
  twin: genTwin,
};

// ── 층수 정하기 ──
type VolArea = PV & { area: number; minWidth: number };

function layout(vols: VolArea[], mode: FloorsMode, N: number): Pick<DesignVolume, "startFloor" | "floors">[] | null {
  if (mode === "parallel") return vols.map((v) => ({ startFloor: 0, floors: Math.max(1, Math.round(v.weight * N)) }));
  if (mode === "tower") {
    const p = clamp(Math.round(N / 4), 2, 3);
    if (N < p + 2) return null;
    return [{ startFloor: 0, floors: p }, { startFloor: p, floors: N - p }];
  }
  // tiers: 아래에서 위로 쌓이며 위로 갈수록 바닥이 작아짐
  if (N < 3) return null;
  const f1 = Math.max(1, Math.round(N * 0.4));
  const f2 = Math.max(1, Math.round(N * 0.3));
  const f3 = N - f1 - f2;
  if (f3 < 1) return null;
  return [{ startFloor: 0, floors: f1 }, { startFloor: f1, floors: f2 }, { startFloor: f1 + f2, floors: f3 }];
}

type Job = { zone: string | null; shape: Poly; maxB: number; maxF: number; limit?: UseLimit; ruleZone?: string | null };

function chooseFloors(
  buildings: VolArea[][],
  mode: FloorsMode,
  maxF: number,
  params: DesignParams,
  floorsCap: number | undefined,
): { vols: Pick<DesignVolume, "startFloor" | "floors">[][]; note?: string } | null {
  const hardCap = Math.min(MAX_FLOORS, floorsCap ?? MAX_FLOORS);
  const want = params.floors ?? hardCap;
  let slenderBound = false;
  for (let N = Math.min(want, hardCap); N >= 1; N--) {
    const lay = buildings.map((vs) => layout(vs, mode, N));
    if (lay.some((l) => !l)) continue;
    const slenderOk = buildings.every((vs, bi) =>
      vs.every((v, vi) => {
        const l = lay[bi]![vi];
        return (l.startFloor + l.floors) * params.floorHeight <= SLENDER * v.minWidth + 1e-6;
      }),
    );
    if (!slenderOk) {
      slenderBound = true;
      continue;
    }
    let fa = 0;
    buildings.forEach((vs, bi) => vs.forEach((v, vi) => (fa += v.area * lay[bi]![vi].floors)));
    if (fa <= maxF) {
      const note = slenderBound ? `건물이 지나치게 가늘어지지 않도록 높이를 짧은 변의 ${SLENDER}배 이하로 제한했습니다` : undefined;
      return { vols: lay as Pick<DesignVolume, "startFloor" | "floors">[][], note };
    }
  }
  return null;
}


// ── 공공주택 단지: 같은 모양의 동을 줄 맞춰 여러 개 놓음 ──
const MAX_COMPLEX_BUILDINGS = 40; // 3D가 무거워지지 않게 하는 동 수 상한

type CxDim = { w: number; d: number };

// 대지를 여러 방향으로 돌려 보며 w×d 크기의 동을 줄 맞춰 최대한 많이 놓음 (남북 간격 gapNS, 동 길이 방향 간격 gapEW)
function packComplex(inset: Poly, proj: Proj, dim: CxDim, gapNS: number, gapEW: number, maxFootprint: number): { rings: XY[][]; footprint: number } | null {
  const polys = polygonsOf(inset).map((poly) => poly.map((ring) => ring.map((p) => proj.toXY(p))));
  const outer = polys.flatMap((poly) => poly[0]);
  const area = polys.reduce((s, poly) => s + ringArea(poly[0]) - poly.slice(1).reduce((q, r) => q + ringArea(r), 0), 0);
  if (area < dim.w * dim.d) return null;

  const mr = minRect(outer);
  const thetas = [mr.theta, mr.theta + Math.PI / 2];
  const edges: { len: number; th: number }[] = [];
  for (const poly of polys) {
    const ring = poly[0];
    for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
      const dx = ring[k][0] - ring[m][0], dy = ring[k][1] - ring[m][1];
      const len = Math.hypot(dx, dy);
      if (len >= 15) edges.push({ len, th: Math.atan2(dy, dx) });
    }
  }
  for (const ed of edges.sort((a, b) => b.len - a.len).slice(0, 2)) {
    for (const th of [ed.th, ed.th + Math.PI / 2]) if (!thetas.some((x) => Math.abs(Math.sin(x - th)) < 0.05)) thetas.push(th);
  }

  const cell = Math.max(1, Math.sqrt(area / 12000));
  let best: { rings: XY[][]; footprint: number } | null = null;
  for (const theta of thetas) {
    const g = buildGrid(polys.flatMap((poly) => poly.map((ring) => ring.map((p) => rot(p, theta)))), cell);
    if (!g) continue;
    const stride = g.nx + 1;
    const fits = (x: number, y: number) => {
      const i0 = Math.floor((x - g.minX) / g.c), i1 = Math.ceil((x + dim.w - g.minX) / g.c) - 1;
      const j0 = Math.floor((y - g.minY) / g.c), j1 = Math.ceil((y + dim.d - g.minY) / g.c) - 1;
      if (i0 < 0 || j0 < 0 || i1 >= g.nx || j1 >= g.ny) return false;
      const cnt = g.sum[(j1 + 1) * stride + i1 + 1] - g.sum[j0 * stride + i1 + 1] - g.sum[(j1 + 1) * stride + i0] + g.sum[j0 * stride + i0];
      return cnt === (i1 - i0 + 1) * (j1 - j0 + 1);
    };
    const pitch = dim.d + gapNS;
    for (const off of [0, 0.33, 0.66]) {
      const rings: XY[][] = [];
      let fp = 0;
      let y = g.minY + off * pitch;
      const yEnd = g.minY + g.ny * g.c;
      const xEnd = g.minX + g.nx * g.c;
      rows: while (y + dim.d <= yEnd) {
        let placed = false;
        let x = g.minX;
        while (x + dim.w <= xEnd) {
          if (fits(x, y)) {
            if (fp + dim.w * dim.d > maxFootprint || rings.length >= MAX_COMPLEX_BUILDINGS) break rows;
            rings.push([[x, y], [x + dim.w, y], [x + dim.w, y + dim.d], [x, y + dim.d]].map((p) => unrot(p as XY, theta)));
            fp += dim.w * dim.d;
            placed = true;
            x += dim.w + gapEW;
          } else x += g.c;
        }
        y += placed ? pitch : g.c;
      }
      if (rings.length > 0 && (!best || fp > best.footprint)) best = { rings, footprint: fp };
    }
  }
  return best;
}

function buildComplex(kind: "barComplex" | "towerComplex", job: Job, base: { proj: Proj; params: DesignParams; margin: number }): DesignedBuilding[] | null {
  const { proj, params, margin } = base;
  const inset = insetOf(job.shape, margin);
  if (!inset || turf.area(inset) < 800) return null;

  const floorCapArea = job.limit?.floorAreaLt !== undefined ? capBelow(job.limit.floorAreaLt) : undefined;
  const maxF = floorCapArea !== undefined ? Math.min(job.maxF, floorCapArea) : job.maxF;
  const floorsCap = Math.min(MAX_FLOORS, job.limit?.maxFloors ?? MAX_FLOORS);
  const targetB = job.maxB * clamp(params.coverage, 0.3, 1) * SAFETY;
  const dims: CxDim[] = kind === "barComplex" ? [{ w: 62, d: 13 }, { w: 50, d: 13 }, { w: 38, d: 13 }] : [{ w: 27, d: 27 }, { w: 23, d: 23 }];
  const floorOptions = params.floors ? [params.floors] : [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40];

  // 공동주택 일조·채광 기준 (건축법 제61조②, 시행령 제86조③, 부산광역시 건축 조례 제43조)
  //  - 일반·중심상업지역은 적용 제외
  //  - 인접 대지경계선까지 거리 ≥ 높이의 1/2 (근린상업·준주거지역은 1/4)  [시행령 제86조③1호: 높이 ≤ 거리의 2배(4배)]
  //  - 같은 대지에서 마주보는 동 사이 거리 ≥ 높이의 1배  [조례 제43조③: 시행령 제86조③2호가목의 '조례로 정하는 거리']
  //  - 측벽과 측벽이 마주보는 경우 4m 이상 (시행령 제86조③2호마목)
  const ruleZone = job.ruleZone ?? job.zone ?? null;
  const exempt = ruleZone === "일반상업지역" || ruleZone === "중심상업지역";
  const edgeFactor = exempt ? 0 : ruleZone === "준주거지역" || ruleZone === "근린상업지역" ? 0.25 : 0.5;
  const regionCache = new Map<number, Poly | undefined>();
  const regionFor = (edge: number): Poly | undefined => {
    const key = Math.round(edge * 2) / 2;
    if (key <= margin + 0.01) return inset;
    if (!regionCache.has(key)) regionCache.set(key, turf.buffer(job.shape, -key, { units: "meters" }) as Poly | undefined);
    return regionCache.get(key);
  };

  let best: { rings: XY[][]; N: number; gap: number; edge: number; floorArea: number } | null = null;
  for (const N of floorOptions) {
    if (N > floorsCap) continue;
    const H = N * params.floorHeight;
    const edge = Math.max(margin, H * edgeFactor);
    const region = regionFor(edge);
    if (!region || turf.area(region) < 800) continue;
    for (const dim of dims) {
      if (H > SLENDER * Math.min(dim.w, dim.d) + 1e-6) continue;
      const gap = exempt ? clamp(0.3 * H, 10, 30) : H; // 마주보는 동 사이 거리: 높이의 1배
      const gapEW = kind === "barComplex" ? 8 : gap; // 판상형의 짧은 쪽(측벽) 사이: 법정 4m 이상, 여유 있게 8m
      const maxFp = Math.min(targetB, (maxF * SAFETY) / N);
      if (maxFp < dim.w * dim.d) continue;
      const pk = packComplex(region, proj, dim, gap, gapEW, maxFp);
      if (!pk) continue;
      const fa = pk.footprint * N;
      if (!best || fa > best.floorArea * 1.005) best = { rings: pk.rings, N, gap, edge, floorArea: fa };
    }
  }
  if (!best) return null;

  // 모든 동이 대지 안에 있는지 확인하고, 한도를 넘으면 뒤쪽 동부터 뺌
  let rings = best.rings.filter((r) => within(llPoly(r, proj), inset));
  const areaOf = (r: XY[]) => geoArea(r, proj);
  const total = () => rings.reduce((s, r) => s + areaOf(r), 0);
  while (rings.length > 0 && (total() > job.maxB * SAFETY || total() * best.N > maxF * SAFETY)) rings = rings.slice(0, -1);
  if (rings.length === 0) return null;

  const volumes: DesignVolume[] = rings.map((r) => ({
    ring: r.map(([x, y]) => [round2(x), round2(y)] as XY),
    startFloor: 0,
    floors: best.N,
    area: floor2(areaOf(r)),
    role: "main",
  }));
  const footprintArea = floor2(volumes.reduce((s, v) => s + v.area, 0));
  const floorArea = floor2(footprintArea * best.N);
  const notes = [
    `동 ${volumes.length}개 × ${best.N}층 (높이 ${Math.round(best.N * params.floorHeight)}m).`,
    exempt
      ? `${ruleZone}은 공동주택 채광 높이 기준이 적용되지 않아 동 사이 거리는 높이의 0.3배(10~30m)로 가정했습니다 (건축법 제61조②).`
      : `동 사이 거리 ${Math.round(best.gap)}m = 높이의 1배 (부산광역시 건축 조례 제43조③, 건축법 시행령 제86조③2호), 인접 대지경계선과 ${Math.round(best.edge)}m 이상 띄움 = 높이의 ${edgeFactor === 0.25 ? "1/4" : "1/2"} (시행령 제86조③1호).`,
    "도로·공원에 접한 쪽의 경계 완화, 동지 기준 2시간 일조 확보로 거리를 줄이는 방법, 부대·복리시설, 정북 방향 일조 사선의 세부 검토는 반영하지 않았습니다.",
  ];
  if (floorCapArea !== undefined && floorCapArea < job.maxF) notes.push(`${job.limit!.floorAreaLt!.toLocaleString("ko-KR")}㎡ 미만 규정에 따라 연면적을 ${floorCapArea.toLocaleString("ko-KR")}㎡ 이내로 줄였습니다`);
  if (job.limit?.maxFloors !== undefined && best.N >= job.limit.maxFloors) notes.push(`용도 규정에 따라 ${job.limit.maxFloors}층 이하로 제한했습니다`);
  if (volumes.length >= MAX_COMPLEX_BUILDINGS) notes.push(`3D 화면이 무거워지지 않도록 동 수를 ${MAX_COMPLEX_BUILDINGS}개까지만 놓았습니다`);
  return [
    {
      zone: job.zone,
      volumes,
      footprintArea,
      floors: best.N,
      height: round2(best.N * params.floorHeight),
      floorArea,
      maxBuildingArea: job.maxB,
      maxFloorArea: maxF,
      notes,
    },
  ];
}

// 이격을 둔 대지 안쪽 영역은 안마다 똑같으므로 한 번만 계산해 둠 (필지가 많은 큰 땅에서 특히 오래 걸림)
const insetCache = new WeakMap<object, Map<number, Poly | undefined>>();
function insetOf(shape: Poly, margin: number): Poly | undefined {
  let m = insetCache.get(shape);
  if (!m) insetCache.set(shape, (m = new Map()));
  if (!m.has(margin)) m.set(margin, turf.buffer(shape, -margin, { units: "meters" }) as Poly | undefined);
  return m.get(margin);
}

// ── 한 땅(또는 용도지역 부분)에 한 가지 안을 만들어 건물로 ──
function buildJob(kind: DesignKind, job: Job, ctxBase: { proj: Proj; params: DesignParams; margin: number }, notes: string[]): DesignedBuilding[] | null {
  if (isComplex(kind)) return buildComplex(kind, job, ctxBase);
  const { proj, params, margin } = ctxBase;
  const inset = insetOf(job.shape, margin);
  if (!inset || turf.area(inset) < 100) return null;

  const floorCapArea = job.limit?.floorAreaLt !== undefined ? capBelow(job.limit.floorAreaLt) : undefined;
  const maxF = floorCapArea !== undefined ? Math.min(job.maxF, floorCapArea) : job.maxF;
  const coverage = clamp(params.coverage, 0.3, 1);
  // 연면적 상한이 걸리면 건축면적을 줄여 3층 안팎으로 계획 (바닥을 넓게 펴면 1층 건물이 되어 부자연스러움)
  const capBound = floorCapArea !== undefined && floorCapArea < job.maxF;
  let targetB = job.maxB * coverage * KIND_FACTOR[kind as SingleKind];
  if (capBound) targetB = Math.min(targetB, floorCapArea / 3);

  for (let attempt = 0; attempt < 5; attempt++) {
    const plan = GENERATORS[kind as SingleKind]({ inset, proj, targetB });
    if (!plan) return null;

    // 덩어리마다 면적(측지 면적)과 가장 짧은 변
    const vols: VolArea[][] = plan.buildings.map((vs) => vs.map((v) => ({ ...v, area: geoArea(v.ring, proj), minWidth: minRect(v.ring).wid })));
    // 건축면적: 안에 포개진 덩어리(저층부+타워, 계단식)는 가장 큰 것 하나, 나란한 덩어리는 합
    const footprint = (vs: VolArea[]) => (plan.mode === "parallel" ? vs.reduce((s, v) => s + v.area, 0) : Math.max(...vs.map((v) => v.area)));
    const totalFootprint = vols.reduce((s, vs) => s + footprint(vs), 0);
    if (totalFootprint > job.maxB * SAFETY) {
      targetB *= (job.maxB * SAFETY) / totalFootprint;
      continue;
    }

    const chosen = chooseFloors(vols, plan.mode, maxF, params, job.limit?.maxFloors);
    if (!chosen) return null;

    const out: DesignedBuilding[] = [];
    vols.forEach((vs, bi) => {
      const volumes: DesignVolume[] = vs.map((v, vi) => ({
        ring: v.ring.map(([x, y]) => [round2(x), round2(y)] as XY),
        startFloor: chosen.vols[bi][vi].startFloor,
        floors: chosen.vols[bi][vi].floors,
        area: floor2(v.area),
        role: v.role,
      }));
      const floors = Math.max(...volumes.map((v) => v.startFloor + v.floors));
      const floorArea = floor2(volumes.reduce((s, v) => s + v.area * v.floors, 0));
      const bNotes: string[] = [];
      if (chosen.note) bNotes.push(chosen.note);
      if (floorCapArea !== undefined && floorCapArea < job.maxF) {
        bNotes.push(
          `${job.limit!.floorAreaLt!.toLocaleString("ko-KR")}㎡ 미만 규정에 따라 연면적을 ${floorCapArea.toLocaleString("ko-KR")}㎡ 이내로 줄였습니다 (용적률 기준 최대 연면적 ${job.maxF.toLocaleString("ko-KR")}㎡)`,
        );
      }
      if (job.limit?.maxFloors !== undefined && floors >= job.limit.maxFloors) bNotes.push(`용도 규정에 따라 ${job.limit.maxFloors}층 이하로 제한했습니다`);
      out.push({
        zone: job.zone,
        volumes,
        footprintArea: floor2(footprint(vs)),
        floors,
        height: round2(floors * params.floorHeight),
        floorArea,
        maxBuildingArea: job.maxB,
        maxFloorArea: maxF,
        notes: bNotes,
      });
    });
    void notes;
    return out;
  }
  return null;
}

// ── 대지 분석과 안의 어울림 점수 ──
function analyzeSite(shape: Poly, proj: Proj): SiteMetrics | null {
  const polys = polygonsOf(shape);
  const biggest = polys.sort((a, b) => ringArea(b[0].map((p) => proj.toXY(p))) - ringArea(a[0].map((p) => proj.toXY(p))))[0];
  const ring = (biggest[0].slice(0, -1) as XY[]).map((p) => proj.toXY(p));
  const area = turf.area(shape);
  if (ring.length < 3 || area < 50) return null;
  const mr = minRect(ring);
  let convexity = 1;
  try {
    const hull = turf.convex(turf.featureCollection([shape] as GeoJSON.Feature<GeoJSON.Polygon>[]));
    if (hull) convexity = clamp(area / turf.area(hull), 0, 1);
  } catch {
    // 껍질을 구하지 못하면 반듯한 것으로 봄
  }
  return { area: round2(area), length: round2(mr.len), width: round2(mr.wid), aspect: round2(mr.len / Math.max(mr.wid, 1)), convexity: round2(convexity) };
}

function scoreOption(kind: DesignKind, m: SiteMetrics, stats: { coverageUse: number; farUse: number; floors: number; autoFloors: number; count: number }, purpose: string) {
  const why: string[] = [];
  let bonus = 0;
  const fp = Math.round(stats.coverageUse * 100);
  const far = Math.round(stats.farUse * 100);
  switch (kind) {
    case "siteFit": {
      const irregular = clamp((0.92 - m.convexity) / 0.25, 0, 1);
      bonus = 8 + 22 * irregular;
      why.push(m.convexity < 0.85 ? `대지 모양이 반듯하지 않아(볼록도 ${m.convexity}) 필지 경계를 따라 앉히면 땅을 가장 잘 써요` : "필지 모양을 그대로 따라 앉힌 안이에요");
      break;
    }
    case "bar":
      bonus = 26 * clamp((m.aspect - 1.8) / 1.4, 0, 1);
      why.push(m.aspect >= 2.2 ? `대지가 가로세로 ${m.aspect}:1로 길쭉해서 긴 막대형이 잘 맞아요` : `대지가 길쭉하지 않아(${m.aspect}:1) 막대형은 땅 활용이 낮은 편이에요`);
      break;
    case "tower":
      bonus = 26 * clamp((stats.autoFloors - 6) / 10, 0, 1) + (m.aspect < 1.8 ? 5 : 0);
      why.push(stats.autoFloors >= 8 ? `연면적 한도로 ${stats.autoFloors}층까지 지을 수 있어 저층부 위에 타워를 올리면 땅을 덜 차지해요` : `층수 여유가 크지 않아(${stats.autoFloors}층) 타워형의 장점이 작아요`);
      break;
    case "lshape":
      bonus = 12 + (m.convexity < 0.93 ? 8 : 0) + (m.width >= 34 ? 5 : 0);
      why.push("ㄱ자로 꺾어 남쪽으로 열린 마당을 만들어 채광·조망에 유리해요");
      break;
    case "courtyard":
      bonus = 26 * clamp((m.area - 4000) / 8000, 0, 1) * (m.width >= 45 ? 1 : 0.4);
      why.push(m.area >= 6000 ? `대지가 넓어(${Math.round(m.area).toLocaleString("ko-KR")}㎡) ㄷ자 중정으로 큰 마당을 둘 수 있어요` : "대지가 넓지 않아 ㄷ자 중정은 마당이 좁아요");
      break;
    case "stepped":
      bonus = (stats.floors >= 4 && stats.floors <= 14 ? 14 : 4) + (purpose === "공공주택" ? 6 : 0);
      why.push("남쪽으로 층을 낮춰 테라스를 만들어 일조와 옥상 정원에 유리해요");
      break;
    case "barComplex":
      bonus = 40;
      why.push(`${stats.count}개 동을 줄 맞춰 배치한 판상형 아파트 단지예요. 남향 위주로 채광이 좋고 공공주택에서 가장 흔한 배치예요`);
      break;
    case "towerComplex":
      bonus = 34;
      why.push(`${stats.count}개 동의 타워형 아파트 단지예요. 동 사이를 넓게 띄워 조망과 통풍에 유리해요`);
      break;
    case "twin":
      bonus = 26 * clamp((m.area - 7000) / 9000, 0, 1);
      why.push(m.area >= 10000 ? "대지가 넓어 두 동을 나란히 놓고 사이에 마당을 둘 수 있어요" : "대지가 넓지 않아 두 동으로 나누면 마당이 좁아요");
      break;
  }
  why.push(`건축면적 한도의 ${fp}%, 연면적 한도의 ${far}%를 쓰는 안이에요`);
  let score = clamp(Math.round(18 + 30 * Math.min(1, stats.farUse) + 24 * Math.min(1, stats.coverageUse) + bonus), 0, 100);
  if (purpose === "공공주택" && !isComplex(kind)) {
    score = Math.min(score, 58); // 공공주택은 여러 동의 단지가 일반적
    why.push("공공주택은 여러 동을 단지로 배치하는 것이 일반적이라 동 한두 개짜리 안은 점수를 낮췄어요");
  }
  return { score, why };
}

export const lastTimings: Record<string, number> = {};

export function designOptions(detail: ReviewDetail, paramsIn: DesignParams, purpose: string): DesignSet {
  const { review, site, partShapes } = detail;
  const params: DesignParams = {
    floorHeight: clamp(paramsIn.floorHeight, 2.5, 6),
    setback: clamp(paramsIn.setback, 0, 10),
    coverage: clamp(paramsIn.coverage ?? DEFAULT_COVERAGE, 0.3, 1),
    floors: paramsIn.floors && paramsIn.floors > 0 ? Math.min(MAX_FLOORS, Math.round(paramsIn.floors)) : null,
  };
  const center = turf.centroid(site).geometry.coordinates as XY;
  const proj = makeProjection(center[0], center[1]);
  const baseNotes = [
    `층고 ${params.floorHeight}m, 대지경계에서 ${params.setback}m 띄움, 건축면적 사용률 ${Math.round(params.coverage * 100)}%는 설계 방향을 정하는 가정값입니다 (법으로 정해진 값이 아님).`,
    "여러 덩어리를 조합한 배치 검토용 모형입니다. 건축 설계 도면이 아닙니다.",
    `건물 높이는 짧은 변 길이의 ${SLENDER}배 이하로 제한했습니다 (지나치게 가는 건물을 막기 위한 가정이며 법 기준이 아님).`,
    "높이 제한(고도지구·경관지구 등), 일조·채광 사선 제한, 건축선, 주차장·조경·공개공지 면적, 인접 대지와의 이격 규정은 반영하지 않았습니다. 도로 접면 요건(건축법 제44조: 연면적 2,000㎡ 이상은 너비 6m 이상 도로에 4m 이상 접해야 함)도 검토 화면의 \"확인 필요\"에서 따로 확인하세요.",
  ];

  // 용도 적합 판정과 건물에 반영할 한도
  const assessment = assessUse(purpose, review);
  const limits = limitsFor(assessment);
  const useInfo: BuildingDesign["use"] = {
    status: assessment.overall,
    headline: assessment.headline,
    caps: limits.map((l) => ({ zone: l.zone, floorAreaLt: l.floorAreaLt, maxFloors: l.maxFloors })),
  };

  // 대지 모양(3D 바닥 표현용)
  const siteRings = polygonsOf(site).sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
  const siteShape: BuildingDesign["site"] = {
    ring: (siteRings[0].slice(0, -1) as XY[]).map((p) => proj.toXY(p).map(round2) as XY),
    holes: siteRings.slice(1).map((h) => (h.slice(0, -1) as XY[]).map((p) => proj.toXY(p).map(round2) as XY)),
  };

  const emptyDesign = (reason: string, id: DesignKind = "bar"): BuildingDesign => ({
    params,
    purpose,
    origin: center,
    site: siteShape,
    option: { id, name: DESIGN_KIND_NAME[id], score: 0, recommended: false, why: [reason] },
    buildings: [],
    totals: { footprintArea: 0, floorArea: 0, maxHeight: 0, maxFloors: 0 },
    limits: review.totals && { maxBuildingArea: review.totals.maxBuildingArea, maxFloorArea: review.totals.maxFloorArea },
    verified: { insideSite: true, withinBuildingLimit: true, withinFloorLimit: true, withinUseLimit: true },
    use: useInfo,
    notes: [reason, ...baseNotes],
  });

  if (!review.totals) return { options: [emptyDesign("용도지역을 확인하지 못해 건물을 배치하지 않았습니다 (확인 필요).")], recommendedId: null, metrics: null };

  // 한 건물군으로 배치할지, 용도지역 부분마다 배치할지
  const jobs: Job[] = (
    review.complete && review.multiZone?.rule !== "separate"
      ? [{ zone: null, shape: site, maxB: review.totals.maxBuildingArea, maxF: review.totals.maxFloorArea }]
      : review.parts.flatMap((p) => {
          const shape = partShapes.get(p.zone);
          return shape ? [{ zone: p.zone, shape, maxB: p.maxBuildingArea, maxF: p.maxFloorArea }] : [];
        })
  ).map((j) => ({ ...j, limit: limits.find((l) => l.zone === j.zone) ?? limits[0], ruleZone: j.zone ?? review.parts[0]?.zone ?? null }));

  const margin = Math.max(params.setback, MIN_MARGIN);
  const commonNotes = [...baseNotes];
  if (!review.complete) commonNotes.push("일부 부분은 용도지역을 확인하지 못해 건물을 놓지 않았습니다 (3단계의 '확인 필요' 참고).");
  if (review.multiZone?.rule === "separate") commonNotes.push("용도지역마다 규정이 따로 적용되어 부분마다 건물을 따로 배치했습니다.");
  if (params.setback < MIN_MARGIN) commonNotes.push(`지적도 좌표 오차 때문에 이격을 ${MIN_MARGIN}m보다 작게 줄 수는 없어 ${MIN_MARGIN}m로 적용했습니다.`);

  // 용도상 건축할 수 없는 부분은 건물을 놓지 않음
  const usable: Job[] = [];
  for (const j of jobs) {
    if (j.limit && !j.limit.allowed) commonNotes.push(`${j.zone ?? "이 땅"}은(는) 법령상 ${purpose}을(를) 지을 수 없어(${j.limit.rule.summary}) 건물을 놓지 않았습니다.`);
    else usable.push(j);
  }
  if (usable.length === 0) return { options: [emptyDesign(`법령상 ${purpose}을(를) 지을 수 없어 건물을 놓지 않았습니다.`)], recommendedId: null, metrics: null };

  // 대지 분석: 가장 넓은 부분을 기준으로
  const main = usable.slice().sort((a, b) => b.maxB - a.maxB)[0];
  const mainInset = insetOf(main.shape, margin);
  const metrics = mainInset ? analyzeSite(mainInset, proj) : null;
  if (!metrics) return { options: [emptyDesign("이격 거리를 둔 건물을 놓을 자리가 없습니다.")], recommendedId: null, metrics: null };

  // 연면적 한도로 지을 수 있는 층수(단순 상자 기준): 타워형 점수에 씀
  const autoFloors = clamp(Math.floor(main.maxF / Math.max(main.maxB * 0.6, 1)), 1, MAX_FLOORS);

  const designs: BuildingDesign[] = [];
  const kinds: DesignKind[] = [...(Object.keys(GENERATORS) as SingleKind[]), ...(purpose === "공공주택" ? (['barComplex', 'towerComplex'] as const) : [])];
  // 아주 넓은 땅(15만㎡ 이상)은 계산이 오래 걸리는 안 몇 가지를 생략
  const hugeSite = metrics.area > 150_000;
  if (hugeSite) commonNotes.push("대지가 매우 넓어(15만㎡ 이상) 계산 시간 때문에 ㄱ자·ㄷ자·계단식 안은 만들지 않았습니다.");
  for (const kind of kinds) {
    if (hugeSite && (kind === "lshape" || kind === "courtyard" || kind === "stepped")) continue;
    const tk = Date.now();
    const buildings: DesignedBuilding[] = [];
    const notes = [...commonNotes];
    for (const job of usable) {
      let built = buildJob(kind, job, { proj, params, margin }, notes);
      if (!built && kind !== "bar" && !isComplex(kind)) {
        built = buildJob("bar", job, { proj, params, margin }, notes);
        if (built) notes.push(`${job.zone ?? "이 땅"}에는 ${DESIGN_KIND_NAME[kind]}을 놓을 수 없어 판상형으로 대신했습니다.`);
      }
      if (!built) {
        notes.push(`${job.zone ?? "이 땅"}에는 이격 거리를 둔 건물을 놓을 자리가 없습니다.`);
        continue;
      }
      for (const b of built) {
        if (b.footprintArea < MIN_FOOTPRINT) notes.push(`${job.zone ?? "이 땅"}에 놓을 수 있는 건물이 ${MIN_FOOTPRINT}㎡ 미만으로 너무 작아 배치하지 않았습니다.`);
        else buildings.push(b);
      }
    }
    lastTimings[kind] = Date.now() - tk;
    if (buildings.length === 0) continue;

    // 검증: 모든 덩어리가 대지 안에 있는가
    const allVolumes = buildings.flatMap((b) => b.volumes);
    const siteXY = polygonsOf(site).map((poly) => poly.map((r) => r.map((p) => proj.toXY(p))));
    const pointInSite = (p: XY) => siteXY.some((poly) => pointInRing(p, poly[0]) && !poly.slice(1).some((h) => pointInRing(p, h)));
    const insideSite =
      allVolumes.length <= 8
        ? allVolumes.every((v) => within(llPoly(v.ring, proj), site))
        : allVolumes.every((v) => v.ring.every((p, i) => pointInSite(p) && pointInSite([(p[0] + v.ring[(i + 1) % v.ring.length][0]) / 2, (p[1] + v.ring[(i + 1) % v.ring.length][1]) / 2])));
    const footprintArea = floor2(buildings.reduce((s, b) => s + b.footprintArea, 0));
    const floorArea = floor2(buildings.reduce((s, b) => s + b.floorArea, 0));
    const withinUse = buildings.every((b) => {
      const l = limits.find((x) => x.zone === b.zone) ?? limits[0];
      if (!l) return true;
      return (l.floorAreaLt === undefined || b.floorArea < l.floorAreaLt) && (l.maxFloors === undefined || b.floors <= l.maxFloors);
    });
    const coverageUse = footprintArea / review.totals.maxBuildingArea;
    const farUse = floorArea / review.totals.maxFloorArea;
    const maxFloors = Math.max(...buildings.map((b) => b.floors));
    const { score, why } = scoreOption(kind, metrics, { coverageUse, farUse, floors: maxFloors, autoFloors, count: buildings.reduce((s, b) => s + b.volumes.length, 0) }, purpose);

    designs.push({
      params,
      purpose,
      origin: center,
      site: siteShape,
      option: { id: kind, name: DESIGN_KIND_NAME[kind], score, recommended: false, why },
      buildings,
      totals: { footprintArea, floorArea, maxHeight: Math.max(...buildings.map((b) => b.height)), maxFloors },
      limits: { maxBuildingArea: review.totals.maxBuildingArea, maxFloorArea: review.totals.maxFloorArea },
      verified: {
        insideSite,
        withinBuildingLimit: footprintArea <= review.totals.maxBuildingArea && buildings.every((b) => b.footprintArea <= b.maxBuildingArea),
        withinFloorLimit: floorArea <= review.totals.maxFloorArea && buildings.every((b) => b.floorArea <= b.maxFloorArea),
        withinUseLimit: withinUse,
      },
      use: useInfo,
      notes,
    });
  }

  if (designs.length === 0) return { options: [emptyDesign("이격 거리를 둔 건물을 놓을 자리가 없습니다.")], recommendedId: null, metrics };
  designs.sort((a, b) => b.option.score - a.option.score);
  designs[0].option.recommended = true;
  return { options: designs, recommendedId: designs[0].option.id, metrics };
}
