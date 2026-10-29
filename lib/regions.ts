// 검토 지역: 부산광역시 전체 (16개 구·군, 192개 읍·면·동)
// 부산은 도시계획 조례가 하나라서 구·군마다 규칙을 따로 만들 필요가 없습니다.
// 다른 시·도로 넓히려면 그 지자체의 도시계획 조례와 별표를 확인해 zoning-rules.ts·use-rules.ts에 넣어야 합니다.

import dongs from "./busan-dongs.json";

export const REGION_NAME = "부산광역시";

export type Dong = { code: string; name: string; gu: string; guName: string }; // code: 법정동 앞 8자리(읍·면·동)
export const BUSAN_DONGS: Dong[] = dongs;

export const BUSAN_GUS: { code: string; name: string }[] = [...new Map(BUSAN_DONGS.map((d) => [d.gu, d.guName])).entries()]
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.code.localeCompare(b.code));

export const GU_NAME = new Map(BUSAN_GUS.map((g) => [g.code, g.name]));
export const DONG_NAME = new Map(BUSAN_DONGS.map((d) => [d.code, `${d.guName} ${d.name}`]));

export const dongsOfGus = (guCodes: string[]) => BUSAN_DONGS.filter((d) => guCodes.includes(d.gu)).map((d) => d.code);

// PNU(19자리)가 시범 지역 안인지: 앞 8자리가 부산의 읍·면·동 코드인지로 확인
export const isBusanPnu = (pnu: string) => DONG_NAME.has(pnu.slice(0, 8));
