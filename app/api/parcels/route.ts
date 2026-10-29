import type { NextRequest } from "next/server";
import { getParcelsInBox, VWorldError } from "@/lib/vworld";

// 한 번에 조회할 수 있는 범위의 최대 크기(도 단위). 약 1km 정도.
const MAX_SPAN = 0.012;

// GET /api/parcels?bbox=최소경도,최소위도,최대경도,최대위도
export async function GET(request: NextRequest) {
  const bbox = request.nextUrl.searchParams.get("bbox")?.split(",").map(Number);
  if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return Response.json({ error: "bbox=최소경도,최소위도,최대경도,최대위도 형식이 필요합니다." }, { status: 400 });
  }

  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (maxLng - minLng > MAX_SPAN || maxLat - minLat > MAX_SPAN) {
    return Response.json({ error: "범위가 너무 넓습니다. 지도를 더 확대해 주세요." }, { status: 400 });
  }

  try {
    const { collection, total } = await getParcelsInBox(minLng, minLat, maxLng, maxLat);
    return Response.json({ ...collection, total });
  } catch (e) {
    const message = e instanceof VWorldError ? e.message : "필지 정보를 가져오지 못했습니다.";
    return Response.json({ error: message }, { status: 502 });
  }
}
