import { DataNotReadyError } from "@/lib/busan-data";
import { searchCandidates } from "@/lib/land-search";
import { buildResult } from "@/lib/land-use-filter";
import { OWNER_TYPES, PURPOSES, type SearchCriteria } from "@/lib/land-types";
import { DONG_NAME, GU_NAME, dongsOfGus } from "@/lib/regions";
import { VWorldError } from "@/lib/vworld";

// 저장본이 없는 동을 그 자리에서 받아야 할 때 수십 초 걸릴 수 있습니다
export const maxDuration = 300;

const OWNER_VALUES: string[] = OWNER_TYPES.map((o) => o.value);

// POST /api/land-search  본문: SearchCriteria(JSON). dongs 대신 gus(구·군 코드 5자리 목록)를 보내도 됩니다.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as (Partial<SearchCriteria> & { gus?: string[] }) | null;

  const fromGus = Array.isArray(body?.gus) ? dongsOfGus(body.gus.filter((g) => GU_NAME.has(g))) : [];
  const fromDongs = (body?.dongs ?? []).filter((d) => DONG_NAME.has(d));
  const criteria: SearchCriteria = {
    purpose: PURPOSES.includes(body?.purpose as SearchCriteria["purpose"]) ? body!.purpose! : "기타",
    dongs: [...new Set([...fromGus, ...fromDongs])],
    ownerTypes: (body?.ownerTypes ?? []).filter((o) => OWNER_VALUES.includes(o)),
    minArea: Math.max(0, Number(body?.minArea) || 0),
    excludedJimok: (body?.excludedJimok ?? []).filter((j) => typeof j === "string"),
    limit: typeof body?.limit === "number" ? body.limit : undefined,
  };

  if (criteria.dongs.length === 0) {
    return Response.json({ error: "지역(구·군)을 하나 이상 골라 주세요." }, { status: 400 });
  }
  if (criteria.ownerTypes.length === 0) {
    return Response.json({ error: "소유 구분을 하나 이상 골라 주세요." }, { status: 400 });
  }

  try {
    return Response.json(await buildResult(await searchCandidates(criteria), criteria));
  } catch (e) {
    console.error("land-search failed:", e instanceof Error ? e.message : e);
    const message = e instanceof VWorldError ? e.message : "토지 정보를 가져오지 못했습니다 (확인 불가).";
    return Response.json({ error: message }, { status: e instanceof DataNotReadyError ? 503 : 502 });
  }
}
