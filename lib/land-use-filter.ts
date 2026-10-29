// 검색 결과 만들기: 고른 용도로 지을 수 있는지 판정해서, 지을 수 없는 땅을 빼고, 면적이 큰 순서로 상위 N곳만 보냅니다.
// 서버 쪽 코드(app/api/...)에서만 import 하세요.
//
// 부산 전체에는 후보가 수천 곳이라 모두 정확하게(도형을 겹쳐서) 판정하면 느립니다. 그래서 두 단계로 합니다.
//  ① 필지마다 미리 계산해 둔 용도지역 비율(scripts/build-busan-data.mjs)로 빠르게 거름 (근사값)
//  ② 화면에 보낼 후보만 정확하게 다시 판정 — 최종 결과는 항상 이 정확한 판정 기준입니다.

import { loadParcelZones, type ParcelZones } from "./busan-data";
import { materializeGroup, type Candidates, type RawGroup } from "./land-search";
import { reviewLandDetailed } from "./land-review";
import { DEFAULT_RESULT_LIMIT, type LandGroup, type SearchCriteria, type SearchResult } from "./land-types";
import { GREENBELT_LIMIT, UNSUPPORTED_LIMIT, USE_PURPOSES, USE_STATUS_LABEL, assessUse, type UseReviewInput } from "./use-rules";
import { SMALL_PART_LIMIT_M2, ZONE_RULES } from "./zoning-rules";

type UseInfo = NonNullable<LandGroup["use"]>;
type Verdict = { keep: boolean; reason: "use" | "unsupported" | null; use: UseInfo | null };

const cache = new Map<string, { at: number; verdict: Verdict }>();
const CACHE_MS = 60 * 60 * 1000;

function toUseInfo(a: ReturnType<typeof assessUse>, parts: { zone: string; share: number }[]): UseInfo {
  return {
    status: a.overall,
    headline: a.mode === "per-part" ? `${USE_STATUS_LABEL[a.overall]} (${a.headline})` : a.headline,
    zones: parts.map((p) => (parts.length > 1 ? `${p.zone} ${Math.round(p.share * 100)}%` : p.zone)).join(", "),
  };
}

// ① 필지별 용도지역 비율을 면적으로 가중해 묶음의 용도지역 구성을 근사
function approximate(g: RawGroup, pz: ParcelZones, purpose: string): Verdict {
  const zoneArea = new Map<string, number>();
  let total = 0;
  let gb = 0;
  for (const p of g.parcels) {
    const rec = pz[p.pnu];
    if (!rec) return { keep: true, reason: null, use: null }; // 정보가 없으면 정확한 판정으로 넘김
    total += p.area;
    gb += rec.g * p.area;
    for (const [name, share] of rec.z) zoneArea.set(name, (zoneArea.get(name) ?? 0) + share * p.area);
  }
  if (total <= 0) return { keep: true, reason: null, use: null };

  let known = 0;
  let unsupported = 0;
  const parts: { zone: string; area: number; share: number }[] = [];
  for (const [name, area] of zoneArea) {
    if (name.startsWith("(")) continue; // (없음)·(겹침): 용도지역을 알 수 없는 부분
    if (ZONE_RULES[name]) {
      known += area;
      parts.push({ zone: name, area, share: 0 });
    } else unsupported += area;
  }
  if (gb / total >= GREENBELT_LIMIT || unsupported / total >= UNSUPPORTED_LIMIT || known <= 0) {
    return { keep: false, reason: "unsupported", use: null };
  }
  parts.sort((a, b) => b.area - a.area);
  for (const p of parts) p.share = p.area / known;
  const kept = parts.filter((p) => p.share >= 0.02);
  const smallest = Math.min(...kept.map((p) => p.area));
  const input: UseReviewInput = {
    parts: kept,
    multiZone: kept.length > 1 ? { rule: smallest <= SMALL_PART_LIMIT_M2 ? "weighted" : "separate" } : null,
    complete: true,
  };
  const a = assessUse(purpose, input);
  return a.overall === "not_allowed" ? { keep: false, reason: "use", use: null } : { keep: true, reason: null, use: null };
}

// ② 정확한 판정 (도형을 겹쳐서 계산)
async function exact(group: LandGroup, purpose: string): Promise<Verdict> {
  const key = `${purpose}|${group.id}|${group.parcels.map((p) => p.pnu).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.verdict;

  const { review } = await reviewLandDetailed(group.parcels.map((p) => p.pnu), { skipLandUse: true });
  const a = assessUse(purpose, review);
  const use = toUseInfo(a, review.parts);
  let verdict: Verdict;
  if (a.overall === "not_allowed") verdict = { keep: false, reason: "use", use };
  else if (a.overall === "unknown") verdict = { keep: false, reason: "unsupported", use };
  else verdict = { keep: true, reason: null, use };
  cache.set(key, { at: Date.now(), verdict });
  return verdict;
}

export async function buildResult(c: Candidates, criteria: SearchCriteria): Promise<SearchResult> {
  const purpose = criteria.purpose;
  const supported = (USE_PURPOSES as readonly string[]).includes(purpose);
  const limit = Math.min(Math.max(Math.round(criteria.limit ?? DEFAULT_RESULT_LIMIT), 10), 300);
  const stats = { ...c.stats, excludedByUse: 0, unsupportedZone: 0 };

  // ① 빠른 거름
  let pool = c.groups;
  let usableCount: number | null = null;
  if (supported) {
    const pz = await loadParcelZones();
    if (pz) {
      pool = [];
      for (const g of c.groups) {
        const v = approximate(g, pz, purpose);
        if (v.keep) pool.push(g);
        else if (v.reason === "use") stats.excludedByUse++;
        else stats.unsupportedZone++;
      }
    }
    usableCount = pool.length;
  }

  // ② 화면에 보낼 후보만 정확하게 (면적이 큰 순서로 limit개가 찰 때까지)
  const groups: LandGroup[] = [];
  for (const raw of pool) {
    if (groups.length >= limit) break;
    const lg = materializeGroup(raw);
    if (!supported) {
      groups.push(lg);
      continue;
    }
    const v = await exact(lg, purpose);
    if (v.keep) groups.push({ ...lg, use: v.use ?? undefined });
    else if (v.reason === "use") stats.excludedByUse++;
    else stats.unsupportedZone++;
  }

  return {
    purpose,
    groups,
    partial: c.partial,
    stats,
    candidateCount: c.groups.length,
    usableCount,
    limit,
    dataDate: c.dataDate,
  };
}
