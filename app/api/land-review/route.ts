import { reviewLand } from "@/lib/land-review";
import { VWorldError } from "@/lib/vworld";

// 처음 호출할 때 용도지역 도형을 받느라 수십 초 걸릴 수 있습니다
export const maxDuration = 300;

const MAX_PARCELS = 60;

// POST /api/land-review  본문: { pnus: string[] }  (2단계 추천 결과에 묶인 필지의 PNU 목록)
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { pnus?: unknown } | null;
  const pnus = Array.isArray(body?.pnus) ? body.pnus.filter((p): p is string => typeof p === "string") : [];

  if (pnus.length === 0 || pnus.length > MAX_PARCELS || pnus.some((p) => !/^\d{19}$/.test(p))) {
    return Response.json({ error: `PNU(19자리 숫자) 1~${MAX_PARCELS}개가 필요합니다.` }, { status: 400 });
  }

  try {
    return Response.json(await reviewLand([...new Set(pnus)]));
  } catch (e) {
    console.error("land-review failed:", e instanceof Error ? e.message : e);
    const message = e instanceof VWorldError ? e.message : "규제 정보를 검토하지 못했습니다 (확인 불가).";
    return Response.json({ error: message }, { status: 502 });
  }
}
