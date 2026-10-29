// 공공주택 아파트 단지의 법정 부대시설 규모 계산. 법령 원문(법제처 Open API, 2026-10-29 조회)을 읽어 정리했어요.
//
//  · 용적률 산정 연면적에서 지하층과 지상층의 부속 주차용 면적은 제외 — 건축법 시행령 제119조제1항제4호 가·나목
//  · 주차장: 주택의 전용면적 합계를 기준으로 광역시는 전용 85㎡ 이하 1대/85㎡, 85㎡ 초과 1대/70㎡,
//    세대당 최소 1대(전용 60㎡ 이하는 0.7대) — 주택건설기준 등에 관한 규정 제27조제1항제1호 (시·군·구 조례로 강화 가능, 반영 안 함)
//  · 단지 안 도로: 보도 1.5m를 포함한 폭 7m 이상 — 같은 규정 제26조제1항
//  · 주민공동시설: 100세대 이상 1,000세대 미만은 세대당 2.5㎡, 1,000세대 이상은 500㎡ + 세대당 2㎡ — 같은 규정 제55조의2제1항
//    (150세대 이상 경로당·어린이놀이터, 300세대 이상 어린이집, 500세대 이상 주민운동시설·작은도서관·다함께돌봄센터 포함: 제3항)
//  · 조경: 부산광역시 건축 조례 제25조제1항 — 연면적 2,000㎡ 이상 대지면적의 15%, 1,000~2,000㎡ 10%, 1,000㎡ 미만 5%
//    (녹지지역 건축물은 조경 제외: 건축법 시행령 제27조제1항제1호)
// 아래 ASSUMED는 법에 정해져 있지 않아 제가 가정한 값입니다. 화면에도 가정으로 표시해요.

import type { ComplexPlan } from "./land-types";

export const ASSUMED = {
  exclusiveRatio: 0.75, // 지상 연면적 중 주택 전용면적 비율 (나머지는 계단·복도·승강기·벽체 등 공용)
  avgExclusive: 70, // 세대 평균 전용면적(㎡): 59㎡형과 84㎡형이 섞인 값
  parkingAreaPerSpace: 30, // 지하주차장 1대당 면적(㎡): 주차단위구획 12.5㎡ + 통로·경사로·기계실 등
  undergroundUse: 0.9, // 지하층을 이격한 대지 안쪽 면적의 몇 %까지 쓸 수 있는지
  roadWidth: 7, // 법정 단지 안 도로 폭(m)
};

export const COMPLEX_OPEN_SPACE_CAP = 0.65; // 건축면적이 대지면적의 65%를 넘지 않게 (조경 15% + 도로·보행공간 등 20%를 남기려는 가정)

const community = (households: number) => (households < 100 ? 0 : households < 1000 ? households * 2.5 : 500 + households * 2);

export function planComplex(input: {
  floorArea: number; // 지상 연면적(㎡)
  footprintArea: number; // 건축면적(㎡)
  siteArea: number; // 대지면적(㎡)
  insetArea: number; // 대지경계에서 이격한 안쪽 면적(㎡)
  buildingSides: number[]; // 동별 장변 길이(m): 단지 안 도로 면적 어림에 씀
  ruleZone: string | null;
}): ComplexPlan {
  const { avgExclusive: avg, exclusiveRatio, parkingAreaPerSpace, undergroundUse, roadWidth } = ASSUMED;

  // 주민공동시설 면적은 연면적에 포함되어 주택 면적이 그만큼 줄어드므로 몇 번 되풀이해 수렴시킴
  let comm = 0;
  let households = 0;
  let exclusive = 0;
  for (let i = 0; i < 6; i++) {
    exclusive = Math.max(0, (input.floorArea - comm) * exclusiveRatio);
    households = Math.floor(exclusive / avg);
    comm = community(households);
  }

  const perArea = avg <= 85 ? 85 : 70; // 광역시 기준
  const byArea = Math.ceil(exclusive / perArea);
  const byHousehold = Math.ceil(households * (avg <= 60 ? 0.7 : 1));
  const parkingSpaces = Math.max(byArea, byHousehold);
  const undergroundArea = parkingSpaces * parkingAreaPerSpace;
  const perFloor = Math.max(input.insetArea * undergroundUse, 1);
  const undergroundFloors = Math.max(1, Math.ceil(undergroundArea / perFloor));

  const green = !!input.ruleZone && input.ruleZone.includes("녹지");
  const landscapeRatio = input.floorArea >= 2000 ? 0.15 : input.floorArea >= 1000 ? 0.1 : 0.05;
  const landscapeRequired = green ? 0 : input.siteArea * landscapeRatio;
  const roadAreaEstimate = input.buildingSides.reduce((s, l) => s + l * roadWidth * 0.5, 0); // 동마다 장변 길이 × 7m의 절반 정도를 도로로 어림
  const openSpace = Math.max(0, input.siteArea - input.footprintArea);
  const openNeeded = landscapeRequired + roadAreaEstimate;

  return {
    households,
    exclusiveArea: Math.round(exclusive),
    parkingSpaces,
    undergroundParkingArea: Math.round(undergroundArea),
    undergroundFloors,
    communityFacilityArea: Math.round(comm),
    landscapeRequired: Math.round(landscapeRequired),
    roadAreaEstimate: Math.round(roadAreaEstimate),
    openSpace: Math.round(openSpace),
    openSpaceEnough: openSpace >= openNeeded,
  };
}
