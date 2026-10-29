// 용도지역별 건폐율·용적률 규칙표 (부산광역시)
// 값은 조례 원문(국가법령정보센터)에서 직접 읽어 옮긴 것입니다. 바꿀 때는 조례 개정을 확인하고 checkedOn을 고치세요.

export const ORDINANCE = {
  name: "부산광역시 도시계획 조례",
  number: "부산광역시조례 제7923호",
  effective: "2026-04-08", // 시행일
  checkedOn: "2026-10-29", // 이 표를 조례 원문과 대조한 날
  url: "https://www.law.go.kr/자치법규/부산광역시도시계획조례",
} as const;

export type ZoneRule = {
  item: number; // 조례 제49조제1항·제50조제1항의 호 번호
  bcr: number; // 건폐율 상한(%)
  far: number; // 용적률 상한(%)
  farIfLargeLot?: { over: number; far: number }; // 대지면적이 over㎡를 넘으면 용적률 far(%)
  note?: string;
};

const INDUSTRIAL_NOTE = "공장·창고 등 외의 용도(청사, 주택 등)가 포함된 필지 기준 건폐율 60% (공장 등만 짓는 경우 70%)";

export const ZONE_RULES: Record<string, ZoneRule> = {
  제1종전용주거지역: { item: 1, bcr: 50, far: 100 },
  제2종전용주거지역: { item: 2, bcr: 40, far: 120 },
  제1종일반주거지역: { item: 3, bcr: 60, far: 180 },
  제2종일반주거지역: { item: 4, bcr: 60, far: 220, farIfLargeLot: { over: 1000, far: 200 } },
  제3종일반주거지역: { item: 5, bcr: 50, far: 300 },
  준주거지역: { item: 6, bcr: 60, far: 400 },
  중심상업지역: { item: 7, bcr: 80, far: 1300 },
  일반상업지역: { item: 8, bcr: 60, far: 1000 },
  근린상업지역: { item: 9, bcr: 60, far: 700 },
  유통상업지역: { item: 10, bcr: 60, far: 800 },
  전용공업지역: { item: 11, bcr: 60, far: 300, note: INDUSTRIAL_NOTE },
  일반공업지역: { item: 12, bcr: 60, far: 350, note: INDUSTRIAL_NOTE },
  준공업지역: { item: 13, bcr: 60, far: 400, note: INDUSTRIAL_NOTE },
  보전녹지지역: { item: 14, bcr: 20, far: 60 },
  생산녹지지역: { item: 15, bcr: 20, far: 80 },
  자연녹지지역: { item: 16, bcr: 20, far: 80 },
  자연환경보전지역: { item: 17, bcr: 20, far: 60 },
};

// 둘 이상의 용도지역에 걸칠 때, 가장 작은 부분이 이 면적(㎡) 이하이면 가중평균을 적용
// (국토계획법 제84조제1항, 시행령 제94조. 도로변 띠 모양 상업지역은 660㎡이지만 여기서는 330㎡만 적용)
export const SMALL_PART_LIMIT_M2 = 330;

// 방화지구 건폐율 80% 완화(조례 제49조④)가 가능한 용도지역
export const FIRE_ZONE_BCR_RELAX_ZONES = [
  "준주거지역",
  "일반상업지역",
  "근린상업지역",
  "전용공업지역",
  "일반공업지역",
  "준공업지역",
];

// 기준값이 달라질 수 있는 지역·지구 (이름에 이 글자가 들어가면 "확인 필요"로 알려 줌)
export const OVERRIDE_KEYWORDS: { keyword: string; message: string }[] = [
  { keyword: "정비구역", message: "정비구역: 용적률은 도시·주거환경정비기본계획에 따름 (조례 제50조제2항제2호)" },
  { keyword: "지구단위계획구역", message: "지구단위계획구역: 계획에서 정한 건폐율·용적률이 우선할 수 있음" },
  { keyword: "자연경관지구", message: "자연경관지구: 건폐율 40% 이하, 높이 15m 이하 (조례 제36조제1항)" },
  { keyword: "경관지구", message: "경관지구: 높이·건축 제한이 있을 수 있음 (조례 제36조)" },
  { keyword: "고도지구", message: "고도지구: 건축물 높이 제한이 있을 수 있음" },
  { keyword: "자연취락지구", message: "자연취락지구: 건폐율 40% 이하 (조례 제49조제2항)" },
  { keyword: "도시계획시설", message: "도시계획시설: 시설 종류·이적지 여부에 따라 건폐율·용적률이 달라질 수 있음 (조례 제49조제6항)" },
  { keyword: "재정비촉진지구", message: "재정비촉진지구: 별도 계획에 따를 수 있음" },
];

// 완화 규정 (조건을 만족해야 적용되므로 계산에 넣지 않고 안내만 함)
export const RELAXATION_NOTES = [
  "방화지구의 내화구조 건축물: 준주거·일반상업·근린상업·공업지역에서 건폐율 80% 이하 (조례 제49조제4항)",
  "국가 또는 지방자치단체가 건설하는 시설 등 (영 제85조제3항제5호에 해당하는 경우): 용적률을 용도지역별 최대한도까지 완화 가능 (조례 제50조제3항제3호)",
  "임대주택 건설: 용적률 최대한도의 120% 이하 (조례 제50조제3항제1호)",
  "방재지구의 재해예방시설 설치: 용적률 120% 이하 범위에서 완화 (조례 제50조제4항)",
  "공공시설부지 제공(상업지역 등): 용적률 200% 이하 범위에서 완화 (조례 제50조제6항)",
  "사회복지시설 기부: 기부 시설 연면적의 2배 이하 추가 (조례 제50조제7항)",
] as const;
