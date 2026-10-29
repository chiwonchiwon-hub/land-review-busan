import { designOptions } from "@/lib/design-engine";
import { reviewLandDetailed } from "@/lib/land-review";
import { DEFAULT_COVERAGE, DEFAULT_FLOOR_HEIGHT, DEFAULT_SETBACK, PURPOSES, type DesignParams } from "@/lib/land-types";
import { VWorldError } from "@/lib/vworld";

export const maxDuration = 300;

const MAX_PARCELS = 60;
const detailCache = new Map<string, { at: number; promise: ReturnType<typeof reviewLandDetailed> }>();
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// POST /api/land-design  본문: { pnus, purpose?, floorHeight?, setback?, coverage?, floors? }
// 대지 모양에 맞는 여러 안을 만들어 추천 순서대로 돌려줍니다.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const pnus = Array.isArray(body?.pnus) ? body.pnus.filter((p): p is string => typeof p === "string") : [];
  if (pnus.length === 0 || pnus.length > MAX_PARCELS || pnus.some((p) => !/^\d{19}$/.test(p))) {
    return Response.json({ error: `PNU(19자리 숫자) 1~${MAX_PARCELS}개가 필요합니다.` }, { status: 400 });
  }

  const purpose = PURPOSES.find((p) => p === body?.purpose) ?? "기타";
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const floorsIn = num(body?.floors, 0);
  const params: DesignParams = {
    floorHeight: clamp(num(body?.floorHeight, DEFAULT_FLOOR_HEIGHT[purpose]), 2.5, 6),
    setback: clamp(num(body?.setback, DEFAULT_SETBACK), 0, 10),
    coverage: clamp(num(body?.coverage, DEFAULT_COVERAGE), 0.3, 1),
    floors: floorsIn >= 1 ? Math.round(clamp(floorsIn, 1, 60)) : null,
  };

  try {
    // 슬라이더로 값만 바꿀 때는 규제 검토 결과를 5분간 다시 씀 (응답이 빨라짐)
    const ids = [...new Set(pnus)];
    const key = ids.slice().sort().join(",");
    const hit = detailCache.get(key);
    let detailPromise = hit && Date.now() - hit.at < 300_000 ? hit.promise : null;
    if (!detailPromise) {
      detailPromise = reviewLandDetailed(ids);
      detailCache.set(key, { at: Date.now(), promise: detailPromise });
      detailPromise.catch(() => detailCache.delete(key));
      if (detailCache.size > 50) detailCache.delete(detailCache.keys().next().value as string);
    }
    const detail = await detailPromise;
    return Response.json({ set: designOptions(detail, params, purpose) });
  } catch (e) {
    console.error("land-design failed:", e instanceof Error ? e.message : e);
    const message = e instanceof VWorldError ? e.message : "건물을 배치하지 못했습니다 (확인 불가).";
    return Response.json({ error: message }, { status: 502 });
  }
}
