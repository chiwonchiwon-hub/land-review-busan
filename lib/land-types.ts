// 토지 찾기(2단계)에서 서버와 화면이 함께 쓰는 값과 타입

import type { UseStatus } from "./use-rules";

// VWorld 소유 구분 값 → 화면 표시 이름
export const OWNER_TYPES = [
  { value: "국유지", label: "국유지 (국가)" },
  { value: "시 도유지", label: "시유지 (부산시)" },
  { value: "군유지", label: "구·군유지" },
] as const;

export const PUBLIC_OWNER_TYPES: string[] = OWNER_TYPES.map((o) => o.value);

// 지목 28종 (공간정보관리법)
export const ALL_JIMOK = [
  "대", "전", "답", "과수원", "목장용지", "임야", "광천지", "염전", "공장용지", "학교용지",
  "주차장", "주유소용지", "창고용지", "도로", "철도용지", "제방", "하천", "구거", "유지", "양어장",
  "수도용지", "공원", "체육용지", "유원지", "종교용지", "사적지", "묘지", "잡종지",
];

// 개발 대상으로 보기 어려워 기본으로 빼는 지목 (화면에서 바꿀 수 있음)
// 학교용지·공원은 이미 시설로 쓰이는 경우가 많아 기본 제외
export const DEFAULT_EXCLUDED_JIMOK = ["도로", "구거", "하천", "제방", "유지", "철도용지", "묘지", "학교용지", "공원"];

export const PURPOSES = ["청사", "공공주택", "기타"] as const;

export type SearchCriteria = {
  purpose: (typeof PURPOSES)[number];
  dongs: string[]; // 읍·면·동 코드(8자리). 화면에서는 구·군을 고르면 그 안의 동이 모두 들어감
  ownerTypes: string[]; // 고른 소유 구분 (OWNER_TYPES의 value)
  minArea: number; // 최소 면적(㎡), 일단의 토지는 합계 면적
  excludedJimok: string[];
  limit?: number; // 화면에 보여 줄 최대 개수 (면적이 큰 순서). 기본 100
};

export const DEFAULT_RESULT_LIMIT = 100;

export type LandParcel = {
  pnu: string;
  addr: string;
  area: number; // 토지대장 면적(㎡)
  jimok: string;
  price: number | null; // 개별공시지가(원/㎡). 자료가 없거나 0이면 null(확인 불가)
  priceDate: string; // 공시 기준 연월 (예: 2025.01)
  ownerTypes: string[];
};

export type LandGroup = {
  id: string;
  parcels: LandParcel[];
  totalArea: number;
  ownerTypes: string[];
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox: [number, number, number, number];
  // 고른 용도(청사·공공주택)로 지을 수 있는지 (용도지역 × 법령 별표). 검색 뒤에 서버가 채움
  use?: { status: UseStatus; headline: string; zones: string };
};

// ── 3단계: 규제 확인 + 건폐율·용적률 계산 ──

export type ZonePart = {
  zone: string; // 용도지역 이름
  area: number; // 이 용도지역에 속한 면적(㎡)
  share: number; // 전체 대지에서 차지하는 비율 (0~1)
  bcr: number; // 적용 건폐율(%)
  far: number; // 적용 용적률(%)
  maxBuildingArea: number; // 최대 건축면적(㎡) = 면적 × 건폐율
  maxFloorArea: number; // 최대 연면적(㎡) = 면적 × 용적률
  bcrBasis: string; // 근거: 조례 조항
  farBasis: string;
  notes: string[];
  designatedYear: string; // VWorld 용도지역 도형의 지정 연도
};

// 건축할 수 없거나 제한이 큰 지역·지구 (lib/no-build.ts)
export type NoBuildHit = {
  name: string;
  relation: string;
  reason: string;
  parcels?: number;
  areaShare?: number;
  purposes?: string[]; // 이 용도에만 해당하는 규정이면 그 용도 목록 (없으면 모든 용도)
  caps?: { bcr?: number; height?: number; landscape?: number }; // 지구가 정한 건폐율(%)·높이(m)·조경(%)
}; // parcels·areaShare: 그 지구에 걸린 필지 수와 대지 면적 대비 비율(0~1)

export type LandReview = {
  pnus: string[];
  siteArea: number; // 대지면적(㎡): 묶인 필지의 토지대장 면적 합계
  parts: ZonePart[];
  // 계산에서 뺀 부분 (용도지역을 찾지 못했거나, 서로 다른 용도지역이 겹치거나, 조례 표에 없는 용도지역)
  excluded: { area: number; share: number; reasons: string[] };
  complete: boolean; // false면 일부가 "확인 필요"
  greenbelt: { area: number; share: number } | null; // 개발제한구역에 걸친 면적(㎡)과 비율. 걸치지 않으면 null
  totals: { maxBuildingArea: number; maxFloorArea: number; bcr: number; far: number } | null; // 계산에서 뺀 부분은 제외한 합계
  multiZone: null | { smallestPart: number; rule: "weighted" | "separate"; text: string };
  landUse: { name: string; relation: string }[]; // 용도지역 외 지역·지구 (포함·저촉)
  noBuild: { blocking: NoBuildHit[]; caution: NoBuildHit[] }; // 건축 불가(포함)·확인 필요 지역·지구
  districtCaps: { name: string; bcr?: number; height?: number; landscape?: number; reason: string }[]; // 용도지구가 정한 수치(면적의 절반 이상이 그 지구에 포함될 때)
  roadAccess: { status: "ok" | "short" | "narrow" | "none" | "unknown"; bestWidth: number | null; wideContactM: number; note: string } | null; // 접도 요건(건축법 제44조) 판정. 확인하지 않았으면 null
  checks: string[]; // "확인 필요" 안내
  relaxations: readonly string[];
  basis: { ordinance: string; effective: string; checkedOn: string; url: string; zoningSource: string; zoningDate: string };
};

// ── 4단계: 3D 건물 디자인 ──

// 건물 배치 안의 종류. 대지 모양에 맞춰 어울리는 안을 추천함
export type DesignKind = "siteFit" | "bar" | "tower" | "lshape" | "courtyard" | "stepped" | "twin" | "barComplex" | "towerComplex";

export const DESIGN_KIND_NAME: Record<DesignKind, string> = {
  siteFit: "대지 순응형",
  bar: "판상형",
  tower: "저층부 + 타워형",
  lshape: "ㄱ자 중정형",
  courtyard: "ㄷ자 중정형",
  stepped: "계단식 테라스형",
  twin: "병렬 2동형",
  barComplex: "판상형 아파트 단지",
  towerComplex: "타워형 아파트 단지",
};

// 사용자가 고칠 수 있는 값. 법으로 정해진 값이 아니라 설계 방향을 정하는 가정값
export type DesignParams = {
  floorHeight: number; // 층고(m)
  setback: number; // 대지경계에서 띄우는 거리(m)
  coverage: number; // 건축면적 사용률: 최대 건축면적 대비 (0.3~1)
  floors: number | null; // 목표 층수. null이면 연면적 한도까지 자동
};

export const DEFAULT_COVERAGE = 0.85;

export const DEFAULT_FLOOR_HEIGHT: Record<string, number> = { 청사: 4, 공공주택: 3, 기타: 3.5 };
export const DEFAULT_SETBACK = 2;

export type XY = [number, number];

// 건물 한 덩어리: 바닥 모양(다각형)을 위로 올린 것. 좌표는 설계 기준점에서 동쪽·북쪽으로 몇 m인지
export type DesignVolume = {
  ring: XY[]; // 바깥 고리 (닫지 않음)
  startFloor: number; // 시작 층 (0이 지상 1층)
  floors: number;
  area: number; // 바닥 면적(㎡)
  role: "main" | "base" | "tower" | "wing" | "tier";
};

// 아파트 단지의 법정 부대시설 규모 (lib/complex-plan.ts)
export type ComplexPlan = {
  households: number; // 추정 세대수
  exclusiveArea: number; // 전용면적 합계(㎡)
  parkingSpaces: number; // 법정 최소 주차대수
  undergroundParkingArea: number; // 필요한 지하주차장 면적(㎡)
  undergroundFloors: number; // 필요한 지하층 수
  communityFacilityArea: number; // 주민공동시설 최소 면적(㎡)
  landscapeRequired: number; // 조경 면적(㎡)
  roadAreaEstimate: number; // 단지 안 도로 면적 어림(㎡)
  openSpace: number; // 건축면적을 뺀 외부 공간(㎡)
  openSpaceEnough: boolean; // 외부 공간이 조경 + 도로를 담기에 충분한지
};

export type DesignedBuilding = {
  zone: string | null; // 부분별로 배치한 경우 그 용도지역
  volumes: DesignVolume[];
  footprintArea: number; // 건축면적(㎡): 겹치는 부분은 한 번만 셈
  floors: number; // 최고 층수
  height: number; // 최고 높이(m) = 층수 × 층고
  floorArea: number; // 연면적(㎡)
  maxBuildingArea: number; // 이 건물에 적용한 한도
  maxFloorArea: number;
  notes: string[];
  complexPlan?: ComplexPlan; // 공공주택 단지안에만 있음
};

// 대지 모양을 분석한 값 (안을 추천하는 근거)
export type SiteMetrics = {
  area: number; // 이격 뒤 건물을 놓을 수 있는 면적(㎡)
  length: number; // 가장 작은 직사각형으로 감쌌을 때 긴 변(m)
  width: number; // 짧은 변(m)
  aspect: number; // 긴 변 / 짧은 변
  convexity: number; // 대지 면적 / 볼록 껍질 면적 (1에 가까울수록 반듯함)
};

export type DesignOptionInfo = {
  id: DesignKind;
  name: string;
  score: number; // 0~100. 대지 모양과 한도 활용도로 매긴 어울림 점수
  recommended: boolean;
  why: string[]; // 이 안이 어울리는(또는 덜 어울리는) 이유
};

export type BuildingDesign = {
  params: DesignParams;
  purpose: string;
  origin: [number, number]; // 설계 기준점(경도, 위도). 건물·대지 좌표의 기준
  site: { ring: XY[]; holes: XY[][] } | null; // 대지 모양 (3D 바닥 표현용)
  option: DesignOptionInfo;
  buildings: DesignedBuilding[];
  totals: { footprintArea: number; floorArea: number; maxHeight: number; maxFloors: number };
  limits: { maxBuildingArea: number; maxFloorArea: number } | null; // 3단계 계산 결과(한도)
  verified: { insideSite: boolean; withinBuildingLimit: boolean; withinFloorLimit: boolean; withinUseLimit: boolean };
  // 고른 용도의 법령 한도(바닥면적·층수)를 건물에 반영했는지
  use: { status: UseStatus; headline: string; caps: { zone: string | null; floorAreaLt?: number; maxFloors?: number }[] };
  notes: string[]; // 가정과 반영하지 않은 규제
};

// 한 땅에 대해 만든 여러 안. 추천 순서(점수 높은 순)로 정렬됨
export type DesignSet = {
  options: BuildingDesign[];
  recommendedId: DesignKind | null;
  metrics: SiteMetrics | null;
};

export type SearchResult = {
  purpose: SearchCriteria["purpose"]; // 이 결과를 찾을 때 고른 용도
  groups: LandGroup[];
  // 일부만 국·공유인 필지 (추천하지 않고 따로 알려 줌)
  partial: LandParcel[];
  stats: {
    publicParcels: number; // 고른 소유 구분으로만 이루어진 필지 수
    excludedByJimok: number;
    missingGeometry: number; // 경계 정보를 찾지 못해 "확인 불가"인 필지 수
    belowMinArea: number; // 면적 조건에 못 미친 일단의 토지 수
    excludedByUse: number; // 고른 용도로 법령상 지을 수 없어 뺀 일단의 토지 수
    excludedByNoRoad: number; // 너비 6m 이상 도로에 접하지 못해(맹지 등) 건축법상 지을 수 없어 뺀 수
    excludedByNoBuild: number; // 도로·공원·학교 시설 부지, 개발제한구역 등 건축 불가 지역·지구에 있어 뺀 수
    unsupportedZone: number; // 법령 표를 반영하지 않은 용도지역(관리·농림지역 등)이나 개발제한구역에 걸려 판정할 수 없어 뺀 수
  };
  candidateCount: number; // 소유·지목·면적 조건에 맞는 일단의 토지 수 (용도 판정 전)
  usableCount: number | null; // 용도 판정까지 통과할 것으로 보이는 수 (근사값, 용도를 판정하지 않으면 null)
  limit: number; // 이번에 보여 준 최대 개수
  dataDate: string; // VWorld에서 데이터를 받아 온 날짜
};
