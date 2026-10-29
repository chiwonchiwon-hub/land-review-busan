// 토지 찾기: 조건에 맞는 국·공유지를 찾아 "일단의 토지"(서로 맞닿은 필지 묶음)로 묶습니다.
// 서버 쪽 코드(app/api/...)에서만 import 하세요.
// 부산 전체를 다루므로 요청마다 도형을 합치지 않고, 미리 계산해 둔 "맞닿은 필지 쌍"으로 묶은 뒤
// 화면에 보낼 묶음만 도형을 합칩니다.

import * as turf from "@turf/turf";
import { loadDongs, loadEdges } from "./busan-data";
import { type LandGroup, type LandParcel, type SearchCriteria } from "./land-types";

type Candidate = LandParcel & { geometry: GeoJSON.MultiPolygon };

export type RawGroup = {
  id: string;
  parcels: Candidate[];
  totalArea: number;
  ownerTypes: string[];
};

export type Candidates = {
  groups: RawGroup[]; // 면적이 큰 순서
  partial: LandParcel[];
  stats: { publicParcels: number; excludedByJimok: number; missingGeometry: number; belowMinArea: number };
  dataDate: string;
};

const TOUCH_TOLERANCE_M = 0.3; // 맞닿았다고 보는 오차. 도로로 떨어진 필지는 묶이지 않음

// 저장된 "맞닿은 쌍" 파일이 없을 때만 쓰는 대체 계산 (후보 필지끼리만, 느림)
function computeEdges(cands: Candidate[]): [string, string][] {
  const KX = 91061, KY = 110945;
  const lim = TOUCH_TOLERANCE_M ** 2;
  const bbox = cands.map((c) => turf.bbox(turf.feature(c.geometry)));
  const near = (A: Candidate, B: Candidate) => {
    for (const pa of A.geometry.coordinates)
      for (const [x, y] of pa[0])
        for (const pb of B.geometry.coordinates) {
          const ring = pb[0];
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const ax = ring[j][0] * KX, ay = ring[j][1] * KY, bx = ring[i][0] * KX, by = ring[i][1] * KY;
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((x * KX - ax) * dx + (y * KY - ay) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            if ((ax + t * dx - x * KX) ** 2 + (ay + t * dy - y * KY) ** 2 <= lim) return true;
          }
        }
    return false;
  };
  const tx = TOUCH_TOLERANCE_M / KX, ty = TOUCH_TOLERANCE_M / KY;
  const out: [string, string][] = [];
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++) {
      const a = bbox[i], b = bbox[j];
      if (a[2] + tx < b[0] || b[2] + tx < a[0] || a[3] + ty < b[1] || b[3] + ty < a[1]) continue;
      if (near(cands[i], cands[j]) || near(cands[j], cands[i])) out.push([cands[i].pnu, cands[j].pnu]);
    }
  return out;
}

export async function searchCandidates(criteria: SearchCriteria): Promise<Candidates> {
  const dongs = await loadDongs(criteria.dongs);

  const cands: Candidate[] = [];
  const partial: LandParcel[] = [];
  const stats = { publicParcels: 0, excludedByJimok: 0, missingGeometry: 0, belowMinArea: 0 };

  for (const dong of dongs) {
    for (const [pnu, p] of Object.entries(dong.parcels)) {
      if (!p.ownerTypes.some((t) => criteria.ownerTypes.includes(t))) continue;
      const geo = dong.geometries[pnu];
      const parcel: LandParcel = {
        pnu,
        addr: geo?.props.addr ?? pnu,
        area: p.area,
        jimok: p.jimok,
        // 공시지가는 지적도(LP_PA_CBND_BUBUN)의 값 (소유정보 API의 값은 기준 연월이 다름)
        price: geo && Number(geo.props.jiga) > 0 ? Number(geo.props.jiga) : null,
        priceDate: geo ? `${geo.props.gosi_year}.${geo.props.gosi_month}` : "",
        ownerTypes: p.ownerTypes,
      };

      // 모든 소유자가 고른 소유 구분일 때만 추천 대상. 개인·법인 등과 공동 소유면 따로 알려 줌
      const allSelected = !p.hasPrivate && p.ownerTypes.every((t) => criteria.ownerTypes.includes(t));
      if (!allSelected) {
        if (p.hasPrivate && !criteria.excludedJimok.includes(p.jimok)) partial.push(parcel);
        continue;
      }
      stats.publicParcels++;
      if (criteria.excludedJimok.includes(p.jimok)) {
        stats.excludedByJimok++;
        continue;
      }
      if (!geo) {
        stats.missingGeometry++;
        continue;
      }
      cands.push({ ...parcel, geometry: geo.geometry });
    }
  }

  // 맞닿은 필지끼리 묶기 (union-find)
  const index = new Map(cands.map((c, i) => [c.pnu, i]));
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edges = (await loadEdges()) ?? computeEdges(cands);
  for (const [a, b] of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined) parent[find(i)] = find(j);
  }
  const members = new Map<number, Candidate[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(c);
    else members.set(r, [c]);
  });

  const groups: RawGroup[] = [];
  for (const list of members.values()) {
    const totalArea = Math.round(list.reduce((s, p) => s + p.area, 0) * 100) / 100;
    if (totalArea < criteria.minArea) {
      stats.belowMinArea++;
      continue;
    }
    groups.push({
      id: list.map((p) => p.pnu).sort()[0],
      parcels: list,
      totalArea,
      ownerTypes: [...new Set(list.flatMap((p) => p.ownerTypes))],
    });
  }
  groups.sort((a, b) => b.totalArea - a.totalArea);
  partial.sort((a, b) => b.area - a.area);

  const oldest = Math.min(...dongs.map((d) => Number(d.fetchedAt)));
  return {
    groups,
    partial: partial.slice(0, 30),
    stats,
    dataDate: Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : "",
  };
}

// 화면에 보낼 묶음만 도형을 합침
export function materializeGroup(g: RawGroup): LandGroup {
  const features = g.parcels.map((p) => turf.feature(p.geometry));
  let merged: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> = features[0];
  if (features.length > 1) {
    try {
      merged = (turf.union(turf.featureCollection(features)) as typeof merged | null) ?? features[0];
    } catch {
      merged = features.sort((a, b) => turf.area(b) - turf.area(a))[0]; // 합치지 못하면 가장 큰 필지 모양만 그림
    }
  }
  return {
    id: g.id,
    parcels: g.parcels.map((p) => ({ pnu: p.pnu, addr: p.addr, area: p.area, jimok: p.jimok, price: p.price, priceDate: p.priceDate, ownerTypes: p.ownerTypes })),
    totalArea: g.totalArea,
    ownerTypes: g.ownerTypes,
    geometry: merged.geometry,
    bbox: turf.bbox(merged) as [number, number, number, number],
  };
}
