// 토지 검토(3단계): 규제 확인 + 건폐율·용적률 자동 계산
// 서버 쪽 코드(app/api/...)에서만 import 하세요.

import * as turf from "@turf/turf";
import { getLandUse, VWorldError, type LandUseRow } from "./vworld";
import { classifyParcels, roadAccessCheck } from "./no-build";
import type { NoBuildHit } from "./land-types";
import { NON_URBAN_NOT_ALLOWED } from "./non-urban-rules";
import { loadDong, loadZoningFile, type ZoningRecord } from "./busan-data";
import { isBusanPnu } from "./regions";
import { type LandReview, type ZonePart } from "./land-types";
import {
  FIRE_ZONE_BCR_RELAX_ZONES,
  ORDINANCE,
  OVERRIDE_KEYWORDS,
  RELAXATION_NOTES,
  SMALL_PART_LIMIT_M2,
  ZONE_RULES,
} from "./zoning-rules";

type Poly = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

// 용도지역 도형(부산 전체, 도시·관리·농림·자연환경보전)과 개발제한구역은 scripts/build-busan-data.mjs 가 받아 둔 저장본을 씁니다.
const asPoly = (z: ZoningRecord): Poly => ({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: z.g } });

const landUseCache = new Map<string, { at: number; rows: LandUseRow[] }>();

export async function loadLandUse(pnu: string): Promise<LandUseRow[]> {
  const hit = landUseCache.get(pnu);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.rows;
  const rows = await getLandUse(pnu);
  landUseCache.set(pnu, { at: Date.now(), rows });
  return rows;
}

function mergeNoBuild(base: { blocking: NoBuildHit[]; caution: NoBuildHit[] }, extra: NoBuildHit[]) {
  return { blocking: [...extra, ...base.blocking], caution: base.caution };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });

function unionAll(features: Poly[]): Poly {
  if (features.length === 1) return features[0];
  return (turf.union(turf.featureCollection(features)) as Poly | null) ?? features[0];
}

// 두 도형이 겹치는 부분. 도형이 잘못된 경우를 대비해 한 번 더 시도합니다.
function intersect(a: Poly, b: Poly): Poly | null {
  try {
    return turf.intersect(turf.featureCollection([a, b])) as Poly | null;
  } catch {
    try {
      const fix = (f: Poly) => (turf.buffer(f, 0, { units: "meters" }) as Poly | undefined) ?? f;
      return turf.intersect(turf.featureCollection([fix(a), fix(b)])) as Poly | null;
    } catch {
      throw new VWorldError("용도지역 경계를 계산하지 못했습니다 (확인 불가).");
    }
  }
}

const bboxOverlap = (a: number[], b: number[]) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export type ReviewDetail = {
  review: LandReview;
  site: Poly; // 묶인 필지 전체의 모양
  partShapes: Map<string, Poly>; // 용도지역별로 다른 용도지역과 겹치지 않는 부분의 모양
};

export async function reviewLand(pnus: string[]): Promise<LandReview> {
  return (await reviewLandDetailed(pnus)).review;
}

// skipLandUse: 용도지역 부분만 빠르게 필요할 때(추천 목록의 용도 판정) 필지마다 부르는 토지이용계획 조회를 건너뜀
export async function reviewLandDetailed(pnus: string[], options: { skipLandUse?: boolean } = {}): Promise<ReviewDetail> {
  // 1. 필지 경계와 토지대장 면적 (2단계에서 받아 둔 데이터)
  if (pnus.some((p) => !isBusanPnu(p))) throw new VWorldError("검토 지역(부산광역시) 밖의 필지입니다.");
  const dongCodes = [...new Set(pnus.map((p) => p.slice(0, 8)))];
  const dongs = Object.fromEntries(await Promise.all(dongCodes.map(async (c) => [c, await loadDong(c)] as const)));

  let siteArea = 0;
  const shapes: Poly[] = [];
  for (const pnu of pnus) {
    const dong = dongs[pnu.slice(0, 8)];
    const info = dong.parcels[pnu];
    const geo = dong.geometries[pnu];
    if (!info || !geo) throw new VWorldError(`필지 ${pnu}의 경계 또는 면적을 찾지 못했습니다 (확인 불가).`);
    siteArea += info.area;
    shapes.push(turf.feature(geo.geometry) as Poly);
  }
  siteArea = round2(siteArea);
  const site = unionAll(shapes);
  const siteGeomArea = turf.area(site);
  const siteBox = turf.bbox(site);
  const tol = Math.max(1, siteGeomArea * 0.003); // 이보다 작은 조각은 경계 오차로 봅니다 (약 0.3%)

  // 2. 용도지역 도형과 겹치는 부분 (이름이 있는 도형만, 같은 이름은 합침)
  const zoning = await loadZoningFile();
  const piecesByZone = new Map<string, { shape: Poly; year: string }[]>();
  const greenbeltPieces: Poly[] = [];
  for (const z of zoning.features) {
    if (!bboxOverlap(z.b, siteBox)) continue;
    if (z.k === "greenbelt") {
      const piece = intersect(site, asPoly(z));
      if (piece && turf.area(piece) >= 0.01) greenbeltPieces.push(piece);
      continue;
    }
    if (!z.u) continue;
    const piece = intersect(site, asPoly(z));
    if (!piece || turf.area(piece) < 0.01) continue;
    const list = piecesByZone.get(z.u) ?? [];
    list.push({ shape: piece, year: z.y });
    piecesByZone.set(z.u, list);
  }
  // 개발제한구역(그린벨트): 용도지역과 겹쳐서 지정되므로 따로 면적만 잼
  const greenbeltArea = greenbeltPieces.length ? turf.area(unionAll(greenbeltPieces)) : 0;

  const zones = [...piecesByZone.entries()].map(([name, list]) => {
    const shape = unionAll(list.map((p) => p.shape));
    return { name, shape, area: turf.area(shape), year: list.map((p) => p.year).sort().at(-1) ?? "" };
  });

  // 서로 다른 용도지역이 겹치는 부분은 어느 쪽인지 알 수 없으므로 계산에서 뺍니다
  const overlapOf = new Map<string, number>();
  const overlapShapes = new Map<string, Poly[]>();
  const overlapReasons: string[] = [];
  let overlapTotal = 0;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const both = intersect(zones[i].shape, zones[j].shape);
      const a = both ? turf.area(both) : 0;
      if (a <= tol || !both) continue;
      overlapShapes.set(zones[i].name, [...(overlapShapes.get(zones[i].name) ?? []), both]);
      overlapShapes.set(zones[j].name, [...(overlapShapes.get(zones[j].name) ?? []), both]);
      overlapOf.set(zones[i].name, (overlapOf.get(zones[i].name) ?? 0) + a);
      overlapOf.set(zones[j].name, (overlapOf.get(zones[j].name) ?? 0) + a);
      overlapTotal += a;
      overlapReasons.push(
        `${zones[i].name}과 ${zones[j].name}이 겹침 (약 ${fmt((a / siteGeomArea) * siteArea)}㎡): 어느 쪽인지 알 수 없어 계산에서 뺌`,
      );
    }
  }

  // 3. 용도지역별 면적과 건폐율·용적률 계산
  const parts: ZonePart[] = [];
  const partShapes = new Map<string, Poly>();
  const unknownReasons: string[] = [];
  let unknownArea = 0;
  let sliverArea = 0;
  const sliverNames: string[] = [];
  const nonUrbanBlocking: NoBuildHit[] = [];
  for (const z of zones) {
    const exclusive = z.area - (overlapOf.get(z.name) ?? 0);
    if (exclusive < tol) {
      sliverArea += Math.max(0, exclusive);
      sliverNames.push(z.name);
      continue;
    }
    const share = exclusive / siteGeomArea;
    const area = round2(share * siteArea);
    const rule = ZONE_RULES[z.name];
    if (!rule) {
      unknownArea += exclusive;
      const banned = NON_URBAN_NOT_ALLOWED["청사"]?.[z.name] && NON_URBAN_NOT_ALLOWED["공공주택"]?.[z.name] ? NON_URBAN_NOT_ALLOWED["청사"][z.name] : null;
      if (banned) nonUrbanBlocking.push({ name: z.name, relation: "포함", reason: `${banned.summary} (${banned.ref})`, areaShare: Math.round(share * 100) / 100 });
      unknownReasons.push(`${z.name}은 조례 규칙표에 없음 (약 ${fmt(area)}㎡): 확인 필요`);
      continue;
    }
    const notes: string[] = [];
    let far = rule.far;
    if (rule.farIfLargeLot && siteArea > rule.farIfLargeLot.over) {
      far = rule.farIfLargeLot.far;
      notes.push(
        `대지면적 ${fmt(siteArea)}㎡가 ${fmt(rule.farIfLargeLot.over)}㎡를 넘어 용적률 ${far}% 적용` +
          (pnus.length > 1 ? " (묶인 필지를 한 대지로 합치는 것을 가정)" : ""),
      );
    }
    if (rule.note) notes.push(rule.note);
    parts.push({
      zone: z.name,
      area,
      share: Math.round(share * 10000) / 10000,
      bcr: rule.bcr,
      far,
      maxBuildingArea: round2((area * rule.bcr) / 100),
      maxFloorArea: round2((area * far) / 100),
      bcrBasis: `${ORDINANCE.name} 제49조제1항제${rule.item}호`,
      farBasis: `${ORDINANCE.name} 제50조제1항제${rule.item}호`,
      notes,
      designatedYear: z.year,
    });
    // 다른 용도지역과 겹친 부분은 뺀 모양 (건물 배치용)
    const overlaps = overlapShapes.get(z.name) ?? [];
    const exclusiveShape = overlaps.length
      ? ((turf.difference(turf.featureCollection([z.shape, ...overlaps])) as Poly | null) ?? z.shape)
      : z.shape;
    partShapes.set(z.name, exclusiveShape);
  }
  parts.sort((a, b) => b.area - a.area);

  const covered = parts.reduce((s, p) => s + p.area, 0);
  const uncovered = Math.max(0, siteGeomArea - zones.reduce((s, z) => s + z.area, 0));
  const excludedGeom = overlapTotal + unknownArea + uncovered;
  const excludedReasons = [...overlapReasons, ...unknownReasons];
  if (uncovered > tol) {
    excludedReasons.push(
      `어느 용도지역 도형에도 속하지 않는 부분 약 ${fmt((uncovered / siteGeomArea) * siteArea)}㎡: 확인 필요`,
    );
  }
  const notableExcluded = overlapTotal > tol || unknownArea > tol || uncovered > siteGeomArea * 0.01;
  const complete = parts.length > 0 && !notableExcluded;
  if (!notableExcluded && excludedGeom + sliverArea > 0.5) {
    const tiny = ((excludedGeom + sliverArea) / siteGeomArea) * siteArea;
    excludedReasons.push(
      `전체의 0.3% 미만인 아주 작은 조각 약 ${fmt(tiny)}㎡` +
        (sliverNames.length ? ` (${sliverNames.join("·")} 도형이 살짝 걸침)` : "") +
        `는 지적도·용도지역도의 경계 오차로 보고 계산에서 뺌`,
    );
  }

  // 4. 둘 이상의 용도지역에 걸칠 때 적용 기준 (국토계획법 제84조, 시행령 제94조)
  const totalBuilding = round2(parts.reduce((s, p) => s + p.maxBuildingArea, 0));
  const totalFloor = round2(parts.reduce((s, p) => s + p.maxFloorArea, 0));
  const checks: string[] = [];
  let multiZone: LandReview["multiZone"] = null;
  if (parts.length > 1) {
    const smallest = Math.min(...parts.map((p) => p.area));
    const wb = round2((totalBuilding / covered) * 100);
    const wf = round2((totalFloor / covered) * 100);
    multiZone =
      smallest <= SMALL_PART_LIMIT_M2
        ? {
            smallestPart: smallest,
            rule: "weighted",
            text: `${parts.length}개 용도지역에 걸침. 가장 작은 부분(${fmt(smallest)}㎡)이 ${SMALL_PART_LIMIT_M2}㎡ 이하여서 면적 비율로 가중평균한 건폐율 ${wb}%·용적률 ${wf}%를 대지 전체에 적용합니다 (국토계획법 제84조제1항, 시행령 제94조).`,
          }
        : {
            smallestPart: smallest,
            rule: "separate",
            text: `${parts.length}개 용도지역에 걸침. 가장 작은 부분(${fmt(smallest)}㎡)이 ${SMALL_PART_LIMIT_M2}㎡를 넘어 각 부분에 해당 용도지역의 규정이 따로 적용됩니다. 아래 합계는 부분별 값을 더한 것이며, 건축물은 용도지역 경계에 맞춰 나눠 배치해야 합니다 (국토계획법 제84조, 시행령 제94조).`,
          };
    if (parts.some((p) => p.zone.includes("녹지"))) {
      checks.push("녹지지역이 걸쳐 있음: 녹지지역은 국토계획법 제84조제3항에 따라 별도 적용될 수 있어 확인 필요");
    }
  }

  // 5. 용도지역 외 지역·지구 (방화지구, 정비구역 등)
  const landUseLists = options.skipLandUse ? [] : await mapLimit(pnus, 4, loadLandUse);
  const seen = new Set<string>();
  const landUse: { name: string; relation: string }[] = [];
  for (const row of landUseLists.flat()) {
    const key = `${row.name}|${row.relation}`;
    if (seen.has(key) || ZONE_RULES[row.name]) continue; // 용도지역은 위 계산에 이미 반영
    seen.add(key);
    landUse.push({ name: row.name, relation: row.relation });
  }
  const applies = landUse.filter((l) => l.relation === "포함" || l.relation === "저촉");
  if (!options.skipLandUse) {
    const roadMsg = roadAccessCheck(landUseLists.flat());
    if (roadMsg) checks.push(roadMsg);
  }
  const used = new Set<string>();
  for (const l of applies) {
    const rule = OVERRIDE_KEYWORDS.find((k) => l.name.includes(k.keyword));
    if (rule && !used.has(rule.message)) {
      used.add(rule.message);
      checks.push(rule.message);
    }
  }
  if (applies.some((l) => l.name.includes("방화지구"))) {
    const eligible = parts.filter((p) => FIRE_ZONE_BCR_RELAX_ZONES.includes(p.zone)).map((p) => p.zone);
    if (eligible.length) {
      checks.push(
        `방화지구에 해당: ${eligible.join("·")} 부분은 내화구조 건축물이면 건폐율 80% 이하로 완화 가능 (조건부, 계산에 반영하지 않음)`,
      );
    }
  }
  if (applies.some((l) => l.name.includes("방재지구"))) {
    checks.push("방재지구: 재해예방시설을 설치하면 용적률 120% 이하 범위에서 완화 가능 (조건부, 계산에 반영하지 않음)");
  }

  // 6. 두 자료의 용도지역 비교 (VWorld 용도지역 도형 ↔ 토지이용계획 속성)
  const fromAttr = new Set(
    landUseLists.flat().filter((r) => ZONE_RULES[r.name] && r.relation !== "접함").map((r) => r.name),
  );
  const fromShape = new Set(zones.map((z) => z.name));
  const onlyAttr = [...fromAttr].filter((n) => !fromShape.has(n));
  const onlyShape = [...fromShape].filter((n) => !fromAttr.has(n));
  if (!options.skipLandUse && (onlyAttr.length || onlyShape.length)) {
    checks.push(
      `VWorld의 두 자료가 다름: 용도지역 도형은 [${[...fromShape].join("·") || "없음"}], 토지이용계획은 [${[...fromAttr].join("·") || "없음"}]. 계산에는 용도지역 도형을 썼으니 확인 필요`,
    );
  }

  const review: LandReview = {
    pnus,
    siteArea,
    parts,
    greenbelt:
      greenbeltArea > tol
        ? { area: round2((greenbeltArea / siteGeomArea) * siteArea), share: Math.round((greenbeltArea / siteGeomArea) * 1000) / 1000 }
        : null,
    excluded: {
      area: round2((excludedGeom / siteGeomArea) * siteArea),
      share: Math.round((excludedGeom / siteGeomArea) * 10000) / 10000,
      reasons: excludedReasons,
    },
    complete,
    totals:
      parts.length === 0
        ? null
        : {
            maxBuildingArea: totalBuilding,
            maxFloorArea: totalFloor,
            bcr: round2((totalBuilding / covered) * 100),
            far: round2((totalFloor / covered) * 100),
          },
    multiZone,
    landUse,
    noBuild: mergeNoBuild(
      classifyParcels(
        pnus.map((pnu, i) => ({ area: dongs[pnu.slice(0, 8)].parcels[pnu].area, rows: landUseLists[i] ?? [] })),
        siteArea,
      ),
      nonUrbanBlocking,
    ),
    checks,
    relaxations: RELAXATION_NOTES,
    basis: {
      ordinance: ORDINANCE.name,
      effective: ORDINANCE.effective,
      checkedOn: ORDINANCE.checkedOn,
      url: ORDINANCE.url,
      zoningSource: "VWorld 용도지역도(LT_C_UQ111)",
      zoningDate: new Date(zoning.fetchedAt).toISOString().slice(0, 10),
    },
  };
  return { review, site, partShapes };
}
