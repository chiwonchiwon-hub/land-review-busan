// 건축할 수 없거나 건축에 큰 제한이 있는 지역·지구를 VWorld 토지이용계획(지역지구 이름 + 포함/저촉/접함)에서 찾아 줍니다.
// 이름 목록은 부산 후보지 60곳의 실제 토지이용계획에서 나온 이름을 기준으로 정리했어요. 목록에 없는 이름은 판단하지 않습니다.
// "block"은 그 땅 안(포함)이면 해당 용도의 건축이 법령상 사실상 불가능한 경우, "caution"은 허가·협의·심의 같은 확인이 필요한 경우입니다.

import type { NoBuildHit } from "./land-types";

type Rule = { test: RegExp; level: "block" | "caution"; reason: string };

const RULES: Rule[] = [
  // ── 건축 불가 (포함일 때 제외) ──
  { test: /^개발제한구역$/, level: "block", reason: "개발제한구역: 건축물 신축이 원칙적으로 금지돼요 (개발제한구역법 제12조)" },
  { test: /^(광로|대로|중로|소로)[0-9]류|^도로구역$|^일반도로$|^도로$/, level: "block", reason: "도로 부지(도시·군계획시설): 도로 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /공원$/, level: "block", reason: "공원 부지(도시·군계획시설): 공원시설 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /^도시자연공원구역$/, level: "block", reason: "도시자연공원구역: 공원시설 외 건축이 제한돼요 (도시공원법)" },
  { test: /^(초등학교|중학교|고등학교|학교|유치원|대학교|특수학교)$/, level: "block", reason: "학교 부지(도시·군계획시설): 학교시설 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /^(주차장|전기공급설비|가스공급설비|열공급설비|하수도|하수처리시설|저수지|유수지|광장|운동장|철도|방수설비|공동구|녹지|완충녹지|경관녹지|연결녹지)$/, level: "block", reason: "공공시설·녹지 부지(도시·군계획시설): 해당 시설 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /^농업진흥구역$/, level: "block", reason: "농업진흥구역(절대농지): 농업 생산 관련 행위·시설, 농업인 주택, 일부 공공시설(도로·상하수도 등) 외에는 지을 수 없어요. 공공주택·청사는 허용 목록에 없어요 (농지법 제32조, 시행령 제29조)" },
  { test: /^상수원보호구역$/, level: "block", reason: "상수원보호구역: 건축물 신축이 원칙적으로 금지돼요 (상수원관리법 제7조)" },
  { test: /^통제보호구역$/, level: "block", reason: "통제보호구역: 군사 목적 외 건축이 제한돼요 (군사기지 및 군사시설 보호법)" },

  // ── 확인 필요 (허가·협의·심의) ──
  { test: /^농업보호구역$/, level: "caution", reason: "농업보호구역: 농업진흥구역을 보호하는 구역으로 건축 가능한 시설이 제한돼요 (농지법 제34조)" },
  { test: /^개발행위허가제한지역$/, level: "caution", reason: "개발행위허가 제한 기간 중에는 건축 허가가 제한될 수 있어요 (국토계획법 제63조)" },
  { test: /^산지전용·일시사용제한지역$/, level: "caution", reason: "산지전용·일시사용이 제한되는 지역이라 산지 안 건축이 어려울 수 있어요 (산지관리법)" },
  { test: /(하천구역|소하천구역)/, level: "caution", reason: "하천구역: 점용허가 등 하천 관리청 협의가 필요해요 (하천법)" },
  { test: /(공익용산지|보전산지)/, level: "caution", reason: "산지: 산지전용 허가가 필요하고 용도에 따라 제한돼요 (산지관리법)" },
  { test: /(문화재|역사문화환경보존지역)/, level: "caution", reason: "문화재 주변: 현상변경 허가·심의가 필요해요 (문화재보호법)" },
  { test: /(제한보호구역|군사시설보호구역|비행안전구역)/, level: "caution", reason: "군사 관련 구역: 관할 군 협의가 필요해요" },
  { test: /(항만구역|항만재개발|중요시설물보호지구)/, level: "caution", reason: "항만 관련 구역: 항만법에 따른 허가·협의가 필요해요" },
  { test: /(정비구역|정비예정구역)/, level: "caution", reason: "정비구역: 정비계획에 따라 건축이 제한돼요 (도시정비법)" },
  { test: /(택지개발지구|산업단지|지구단위계획구역)/, level: "caution", reason: "개발 계획 구역: 지정 목적과 계획 내용을 확인해야 해요" },
  { test: /(최고고도지구|가로구역별 최고높이|중점경관관리구역|경관지구)/, level: "caution", reason: "높이·경관 제한이 있을 수 있어요" },
  { test: /(백두대간|자연공원|공원자연)/, level: "caution", reason: "자연공원·보호 구역: 건축 제한이 있을 수 있어요" },
];

// relation: VWorld가 알려 주는 "포함"(땅이 지구 안), "저촉"(일부가 걸침), "접함"(맞닿음)
export function classifyLandUse(rows: { name: string; relation: string }[]): { blocking: NoBuildHit[]; caution: NoBuildHit[] } {
  const blocking: NoBuildHit[] = [];
  const caution: NoBuildHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.relation !== "포함" && row.relation !== "저촉") continue;
    const rule = RULES.find((r) => r.test.test(row.name));
    if (!rule) continue;
    const key = `${row.name}|${row.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rule.level === "block" && row.relation === "포함") blocking.push({ name: row.name, relation: row.relation, reason: rule.reason });
    else caution.push({ name: row.name, relation: row.relation, reason: rule.level === "block" ? `${rule.reason} — 일부만 걸쳐 있어요` : rule.reason });
  }
  return { blocking, caution };
}

// 필지마다 따로 판정해서, 같은 지구에 걸린 필지 수와 면적 비율을 함께 돌려줌 (묶음 전체가 아니라 일부 필지만 해당할 수 있음)
export function classifyParcels(parcels: { area: number; rows: { name: string; relation: string }[] }[], siteArea: number): { blocking: NoBuildHit[]; caution: NoBuildHit[] } {
  const agg = (pick: "blocking" | "caution") => {
    const map = new Map<string, NoBuildHit & { parcels: number; areaSum: number }>();
    for (const p of parcels) {
      for (const h of classifyLandUse(p.rows)[pick]) {
        const key = `${h.name}|${h.relation}`;
        const cur = map.get(key) ?? { ...h, parcels: 0, areaSum: 0 };
        cur.parcels++;
        cur.areaSum += p.area;
        map.set(key, cur);
      }
    }
    return [...map.values()]
      .map(({ areaSum, ...h }) => ({ ...h, areaShare: siteArea > 0 ? Math.round((areaSum / siteArea) * 100) / 100 : undefined }))
      .sort((a, b) => (b.areaShare ?? 0) - (a.areaShare ?? 0));
  };
  return { blocking: agg("blocking"), caution: agg("caution") };
}
