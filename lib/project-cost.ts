// 토지 가격과 사업비 계산 (5단계). 순수 계산이라 서버와 브라우저 어디서든 쓸 수 있습니다.
//   토지 가격   = Σ (필지 면적 × 개별공시지가)
//   예상 공사비 = 연면적 × ㎡당 공사비
//   총사업비    = 토지 가격 + 예상 공사비 + 기타 비용(공사비 × 비율)

import type { BuildingDesign, LandGroup, LandParcel, LandReview } from "./land-types";

export type AreaBasis = "design" | "max"; // 연면적을 설계한 건물 기준으로 할지, 3단계에서 계산한 최대 연면적 기준으로 할지

export type CostParams = {
  unitCost: number; // ㎡당 공사비(원) - 가정값
  otherCostRate: number; // 기타 비용(설계·감리·부대비용 등) 비율(%, 공사비 대비) - 가정값
  areaBasis: AreaBasis;
};

// ㎡당 공사비 기본값: 국토교통부 분양가상한제 기본형건축비 (정기고시 2026.9.15.)
export const UNIT_COST_DEFAULT = {
  value: 2_328_000,
  label: "분양가상한제 기본형건축비 (국토교통부 정기고시, 2026.9.15. 적용)",
  scope:
    "16~25층·전용 60~85㎡ 공동주택 기준 금액입니다. 청사 등 다른 용도는 공사비가 다를 수 있어(보통 더 높음) 공식 기준을 찾지 못했으니 직접 입력해 주세요.",
  verified:
    "KDI 경제교육·정보센터에 게시된 국토교통부 자료로 금액을 확인했습니다 (고시 원문 파일은 열어 보지 않음).",
  url: "https://eiec.kdi.re.kr/policy/materialView.do?num=286786",
} as const;

export const DEFAULT_COST_PARAMS: CostParams = {
  unitCost: UNIT_COST_DEFAULT.value,
  otherCostRate: 0,
  areaBasis: "design",
};

export type LandPriceRow = {
  pnu: string;
  addr: string;
  area: number; // 토지대장 면적(㎡)
  price: number | null; // 개별공시지가(원/㎡)
  priceDate: string; // 공시 기준 연월
  amount: number | null; // 면적 × 공시지가(원). 공시지가를 모르면 null
};

export type ProjectCost = {
  land: {
    rows: LandPriceRow[];
    total: number; // 공시지가를 아는 필지만 합한 금액(원)
    knownArea: number;
    missingArea: number; // 공시지가를 몰라 뺀 면적(㎡)
    complete: boolean; // false면 일부 필지는 확인 불가로 뺌
    priceDates: string[]; // 쓰인 공시 기준 연월 (보통 한 가지)
  };
  floorArea: number; // 계산에 쓴 연면적(㎡)
  construction: number; // 예상 공사비(원)
  other: number; // 기타 비용(원)
  total: number; // 총사업비(원). 토지 가격에서 뺀 필지가 있으면 그만큼 빠진 금액
  complete: boolean;
};

export function computeProjectCost(parcels: LandParcel[], floorArea: number, params: CostParams): ProjectCost {
  const rows: LandPriceRow[] = parcels.map((p) => ({
    pnu: p.pnu,
    addr: p.addr,
    area: p.area,
    price: p.price,
    priceDate: p.priceDate,
    amount: p.price === null ? null : Math.round(p.area * p.price),
  }));
  const known = rows.filter((r) => r.amount !== null);
  const landTotal = known.reduce((s, r) => s + (r.amount ?? 0), 0);
  const missingArea = rows.filter((r) => r.amount === null).reduce((s, r) => s + r.area, 0);

  const construction = Math.round(floorArea * params.unitCost);
  const other = Math.round((construction * params.otherCostRate) / 100);
  const landComplete = missingArea === 0;

  return {
    land: {
      rows,
      total: landTotal,
      knownArea: Math.round(known.reduce((s, r) => s + r.area, 0) * 100) / 100,
      missingArea: Math.round(missingArea * 100) / 100,
      complete: landComplete,
      priceDates: [...new Set(known.map((r) => r.priceDate).filter(Boolean))],
    },
    floorArea,
    construction,
    other,
    total: landTotal + construction + other,
    complete: landComplete,
  };
}

// 화면의 여러 곳(사업비 패널, 요약)이 같은 숫자를 쓰도록 연면적 기준과 계산을 한곳에서 정함
export function resolveProjectCost(
  group: LandGroup,
  review: LandReview | undefined,
  design: BuildingDesign | undefined,
  params: CostParams,
) {
  const designFloor = design && design.buildings.length > 0 ? design.totals.floorArea : null;
  const maxFloor = review?.totals?.maxFloorArea ?? null;
  const floorArea = params.areaBasis === "design" ? designFloor : maxFloor;
  const land = computeProjectCost(group.parcels, floorArea ?? 0, params); // 토지 가격은 연면적 없이도 구함
  return { designFloor, maxFloor, floorArea, land, cost: floorArea === null ? null : land };
}

// 원 → "12억 3,456만원" 처럼 읽기 쉽게
export function formatWon(won: number): string {
  const sign = won < 0 ? "-" : "";
  const n = Math.abs(Math.round(won));
  const eok = Math.floor(n / 100_000_000);
  const man = Math.floor((n % 100_000_000) / 10_000);
  if (eok > 0) return `${sign}${eok.toLocaleString("ko-KR")}억${man > 0 ? ` ${man.toLocaleString("ko-KR")}만` : ""}원`;
  if (man > 0) return `${sign}${man.toLocaleString("ko-KR")}만원`;
  return `${sign}${n.toLocaleString("ko-KR")}원`;
}
