// VWorld API 호출 도우미. 서버 쪽 코드(app/api/...)에서만 import 하세요.
// API 키(VWORLD_KEY)는 .env에서 읽고, 브라우저로 보내지 않습니다.

const DATA_API = "https://api.vworld.kr/req/data";
const NED_API = "https://api.vworld.kr/ned/data";

// VWorld에 등록한 사이트 주소. 등록 주소와 다르면 "인증키 정보가 올바르지 않습니다" 오류가 납니다.
const DOMAIN = process.env.VWORLD_DOMAIN ?? "localhost";

export class VWorldError extends Error {}

// VWorld가 값이 역슬래시 하나인 데이터("buldDongNm" : "\")를 보내 JSON이 깨지는 경우가 있어 고쳐서 읽음
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const repaired = text.replace(/:\s*"\\"\s*([,}])/g, ': ""$1');
    if (repaired === text) throw e;
    return JSON.parse(repaired);
  }
}

function getKey(): string {
  const key = process.env.VWORLD_KEY;
  if (!key) throw new VWorldError(".env에 VWORLD_KEY가 없습니다.");
  return key;
}

export type ParcelProperties = {
  pnu: string;
  addr: string;
  jibun: string;
  jiga: string;
  gosi_year: string;
  gosi_month: string;
};

export type ParcelCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, ParcelProperties>;

const PAGE_SIZE = 1000;
const MAX_PAGES = 3;

// 사각형 범위(경도·위도) 안의 필지 경계와 공시지가를 가져옵니다.
export async function getParcelsInBox(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): Promise<{ collection: ParcelCollection; total: number }> {
  const features: ParcelCollection["features"] = [];
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      service: "data",
      request: "GetFeature",
      data: "LP_PA_CBND_BUBUN",
      geomFilter: `BOX(${minLng},${minLat},${maxLng},${maxLat})`,
      crs: "EPSG:4326",
      format: "json",
      size: String(PAGE_SIZE),
      page: String(page),
      domain: DOMAIN,
      key: getKey(),
    });

    const res = await fetch(`${DATA_API}?${params}`, { cache: "no-store" });
    if (!res.ok) throw new VWorldError(`VWorld 응답 오류 (HTTP ${res.status})`);
    const json = await readJson(res);
    const response = json.response;

    if (response.status === "NOT_FOUND") break;
    if (response.status !== "OK") {
      throw new VWorldError(`VWorld 오류: ${response.error?.text ?? response.status}`);
    }

    total = Number(response.record.total);
    features.push(...response.result.featureCollection.features);
    if (features.length >= total) break;
  }

  return { collection: { type: "FeatureCollection", features }, total };
}

// 필지가 속한 지역·지구 한 줄 (용도지역 외 방화지구, 정비구역 등 포함)
export type LandUseRow = { name: string; relation: "포함" | "저촉" | "접함" | string };

export async function getLandUse(pnu: string): Promise<LandUseRow[]> {
  const params = new URLSearchParams({
    pnu,
    format: "json",
    numOfRows: "100",
    pageNo: "1",
    domain: DOMAIN,
    key: getKey(),
  });
  const res = await fetch(`${NED_API}/getLandUseAttr?${params}`, { cache: "no-store" });
  if (!res.ok) throw new VWorldError(`VWorld 토지이용계획 응답 오류 (HTTP ${res.status})`);
  const json = await readJson(res);
  if (!json.landUses) throw new VWorldError("VWorld 토지이용계획 응답 형식이 올바르지 않습니다.");
  const rows = (json.landUses.field ?? []) as Record<string, string>[];
  return rows.map((r) => ({ name: r.prposAreaDstrcCodeNm, relation: r.cnflcAtNm }));
}

// 여러 페이지를 동시에 몇 개씩만 요청합니다 (VWorld에 부담을 주지 않도록)
async function fetchPages<T>(totalPages: number, fetchPage: (page: number) => Promise<T[]>, concurrency = 4) {
  const results: T[][] = [];
  let next = 2;
  async function worker() {
    while (next <= totalPages) {
      const page = next++;
      results[page] = await fetchPage(page);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.flat();
}

// 소유 정보 한 행. 공동 소유자가 있으면 한 필지에 여러 행이 나옵니다.
// 소유자 이름 등 개인정보는 VWorld 응답에 없고, 여기서도 필요한 칸만 남깁니다.
export type PossessionRow = {
  pnu: string;
  ownerType: string; // 국유지, 시 도유지, 군유지, 개인, 법인 …
  area: number; // 토지대장 면적(㎡)
  jimok: string; // 지목: 대, 도로, 전 …
  price: number; // 소유정보 쪽 공시지가(원/㎡). 기준 연월이 달라 화면에는 쓰지 않음
};

const POSSESSION_PAGE_SIZE = 1000;

// 법정동(코드 앞부분) 전체의 소유 정보를 가져옵니다. 저장본이 없는 동을 소량 받을 때만 씁니다.
export async function getPossessionsByDong(ldCode: string): Promise<PossessionRow[]> {
  async function fetchPage(page: number) {
    const params = new URLSearchParams({
      pnu: ldCode,
      format: "json",
      numOfRows: String(POSSESSION_PAGE_SIZE),
      pageNo: String(page),
      domain: DOMAIN,
      key: getKey(),
    });
    const res = await fetch(`${NED_API}/getPossessionAttr?${params}`, { cache: "no-store" });
    if (!res.ok) throw new VWorldError(`VWorld 소유정보 응답 오류 (HTTP ${res.status})`);
    const json = await readJson(res);
    if (!json.possessions) throw new VWorldError("VWorld 소유정보 응답 형식이 올바르지 않습니다.");
    return json.possessions as { totalCount: string; field?: Record<string, string>[] };
  }

  const toRows = (fields: Record<string, string>[] = []): PossessionRow[] =>
    fields.map((f) => ({
      pnu: f.pnu,
      ownerType: f.posesnSeCodeNm,
      area: Number(f.lndpclAr),
      jimok: f.lndcgrCodeNm,
      price: Number(f.pblntfPclnd),
    }));

  const first = await fetchPage(1);
  const totalPages = Math.ceil(Number(first.totalCount) / POSSESSION_PAGE_SIZE);
  const rest = await fetchPages(totalPages, async (page) => toRows((await fetchPage(page)).field));
  return [...toRows(first.field), ...rest];
}

// 법정동(코드 앞부분) 전체의 필지 경계를 가져옵니다. 저장본이 없는 동을 소량 받을 때만 씁니다.
export async function getParcelsByDong(ldCode: string): Promise<ParcelCollection> {
  async function fetchPage(page: number) {
    const params = new URLSearchParams({
      service: "data",
      request: "GetFeature",
      data: "LP_PA_CBND_BUBUN",
      attrFilter: `pnu:like:${ldCode}`,
      crs: "EPSG:4326",
      format: "json",
      size: String(PAGE_SIZE),
      page: String(page),
      domain: DOMAIN,
      key: getKey(),
    });
    const res = await fetch(`${DATA_API}?${params}`, { cache: "no-store" });
    if (!res.ok) throw new VWorldError(`VWorld 응답 오류 (HTTP ${res.status})`);
    const response = (await readJson(res)).response;
    if (response.status === "NOT_FOUND") return { total: 0, features: [] };
    if (response.status !== "OK") {
      throw new VWorldError(`VWorld 오류: ${response.error?.text ?? response.status}`);
    }
    return {
      total: Number(response.record.total),
      features: response.result.featureCollection.features as ParcelCollection["features"],
    };
  }

  const first = await fetchPage(1);
  const totalPages = Math.ceil(first.total / PAGE_SIZE);
  const rest = await fetchPages(totalPages, async (page) => (await fetchPage(page)).features);
  return { type: "FeatureCollection", features: [...first.features, ...rest] };
}

// 국가기본도 도로 중심선과 도로 폭(rvwd, m). 골목 같은 작은 길도 들어 있음
export type RoadLine = { id: string; width: number; lines: number[][][] };

export async function getRoadsInBox(minLng: number, minLat: number, maxLng: number, maxLat: number): Promise<RoadLine[]> {
  const roads: RoadLine[] = [];
  for (let page = 1; page <= 4; page++) {
    const params = new URLSearchParams({
      service: "data",
      request: "GetFeature",
      data: "LT_L_N3A0020000",
      geomFilter: `BOX(${minLng},${minLat},${maxLng},${maxLat})`,
      crs: "EPSG:4326",
      format: "json",
      size: "1000",
      page: String(page),
      domain: DOMAIN,
      key: getKey(),
    });
    const res = await fetch(`${DATA_API}?${params}`, { cache: "no-store" });
    if (!res.ok) throw new VWorldError(`VWorld 도로 응답 오류 (HTTP ${res.status})`);
    const json = await readJson(res);
    const response = json.response;
    if (response.status === "NOT_FOUND") break;
    if (response.status !== "OK") throw new VWorldError(`VWorld 오류: ${response.error?.text ?? response.status}`);
    for (const f of response.result.featureCollection.features as GeoJSON.Feature<GeoJSON.MultiLineString | GeoJSON.LineString>[]) {
      const width = Number((f.properties as Record<string, string>)?.rvwd);
      if (!Number.isFinite(width) || width <= 0) continue;
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      roads.push({ id: String((f.properties as Record<string, string>)?.ufid ?? roads.length), width, lines });
    }
    if (Number(response.page?.current) >= Number(response.page?.total)) break;
  }
  return roads;
}
