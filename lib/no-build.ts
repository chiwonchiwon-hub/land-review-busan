// 건축할 수 없거나 건축에 제한이 있는 용도지구·용도구역·타법 지역지구를 VWorld 토지이용계획(지역지구 이름 + 포함/저촉/접함)에서 찾아 줍니다.
// 근거는 법제처 원문(2026-10-29 조회)입니다.
//  · 용도지구 종류: 국토계획법 제37조 (경관·고도·방화·방재·보호·취락·개발진흥·특정용도제한·복합용도)
//  · 지구별 건축 제한: 시행령 제72조(경관지구, 조례로 정함) · 제74조(고도지구) · 제75조(방재지구) · 제76조(보호지구)
//    · 제78조(취락지구) · 제80조(특정용도제한지구) → 구체 내용은 부산광역시 도시계획 조례 제31~36조(경관지구)·제41~44조(보호지구)
//  · 용도구역: 개발제한구역(개발제한구역법 제12조) · 도시자연공원구역(도시공원법 제27조) · 시가화조정구역(국토계획법 제81조)
//    · 수산자원보호구역(수산자원관리법 제52조)
// 이름 목록은 VWorld 토지이용계획에서 실제로 나온 이름(부산 후보지 60곳)과 위 조문의 지구 이름을 기준으로 하고, 목록에 없는 이름은 판단하지 않습니다.
// level: block=그 땅 안('포함')이면 그 용도로는 사실상 지을 수 없음 / caution=허가·협의·심의 확인 필요 / info=알려만 줌(결과에 안 넣음)
// only: 특정 용도에만 적용되는 규정(예: 시가지경관지구는 공동주택만 금지 → 공공주택에만 해당)
// caps: 지구가 정한 수치(건폐율·높이·조경). 설계에 반영합니다.

import type { NoBuildHit } from "./land-types";

type Caps = { bcr?: number; height?: number; landscape?: number };
type Rule = { test: RegExp; level: "block" | "caution" | "info"; reason: string; only?: string[]; caps?: Caps };

const RULES: Rule[] = [
  // ── 용도구역 ──
  { test: /^개발제한구역$/, level: "block", reason: "개발제한구역: 건축물 신축이 원칙적으로 금지돼요 (개발제한구역법 제12조)" },
  { test: /^도시자연공원구역$/, level: "block", reason: "도시자연공원구역: 공원시설 등 허용 목록 외 건축이 금지돼요 (도시공원법 제27조)" },
  { test: /^시가화조정구역$/, level: "caution", reason: "시가화조정구역: 농·임·어업용 건축물, 마을공동시설, 공익·공공시설 등 허용된 행위만 허가돼요 (국토계획법 제81조)" },
  { test: /^수산자원보호구역$/, level: "caution", reason: "수산자원보호구역: 수산자원 보호·조성 시설 등 허용된 행위만 허가돼요 (수산자원관리법 제52조)" },

  // ── 용도지구: 경관지구 (부산 도시계획 조례 제30조의2, 제31~36조) ──
  {
    test: /^자연경관지구$/,
    level: "caution",
    reason: "자연경관지구: 아파트·일반업무시설 등은 건축할 수 없고(청사로 쓰는 공공업무시설은 금지 목록에 없음), 건폐율 40% 이하·높이 15m 이하·조경 30% 이상이에요 (부산 도시계획 조례 제31조·제36조)",
    caps: { bcr: 40, height: 15, landscape: 30 },
  },
  { test: /^시가지경관지구$/, level: "block", only: ["공공주택"], reason: "시가지경관지구: 공동주택은 건축할 수 없어요(정비사업 제외) (부산 도시계획 조례 제33조)" },
  {
    test: /^특화경관지구$/,
    level: "caution",
    reason: "특화경관지구: 아파트는 건축할 수 없고(정비사업 제외), 높이 12m 이하예요(도시계획위원회 심의로 완화 가능) (부산 도시계획 조례 제34조·제36조)",
    caps: { height: 12 },
  },
  { test: /^일반경관지구$/, level: "info", reason: "일반경관지구: 공장·창고 등 일부 용도만 제한되고 청사·공공주택은 금지 목록에 없어요 (부산 도시계획 조례 제35조)" },

  // ── 용도지구: 보호지구 (제41~44조) ──
  {
    test: /(항만중요시설물보호지구|중요시설물보호지구\s*\(?항만)/,
    level: "block",
    only: ["공공주택"],
    reason: "항만중요시설물보호지구: 공동주택은 기숙사만 건축할 수 있어요 (부산 도시계획 조례 제43조). 업무시설(청사)은 건축할 수 있어요",
  },
  {
    test: /(공용중요시설물보호지구|중요시설물보호지구\s*\(?공용)/,
    level: "block",
    only: ["공공주택"],
    reason: "공용중요시설물보호지구: 허용 목록에 공동주택이 없어요 (부산 도시계획 조례 제44조). 업무시설(청사)은 건축할 수 있어요",
  },
  { test: /(생태계보호지구|역사문화환경보호지구|중요시설물보호지구)/, level: "caution", reason: "보호지구: 조례가 정한 건축물만 건축할 수 있어요 (국토계획법 시행령 제76조)" },

  // ── 용도지구: 그 밖의 지구 ──
  { test: /고도지구$/, level: "caution", reason: "고도지구: 도시·군관리계획으로 정한 높이를 넘는 건축물은 지을 수 없어요. 높이 값은 지구 지정 고시에서 확인해야 해요 (국토계획법 시행령 제74조)" },
  { test: /방재지구$/, level: "caution", reason: "방재지구: 재해예방에 장애가 되는 건축물은 조례로 제한돼요 (국토계획법 시행령 제75조)" },
  { test: /방화지구$/, level: "info", reason: "방화지구: 건축물을 내화구조로 해야 해요 (국토계획법 제61조)" },
  { test: /특정용도제한지구$/, level: "caution", reason: "특정용도제한지구: 주거·교육환경을 해치거나 청소년에게 유해한 시설은 조례로 제한돼요 (국토계획법 시행령 제80조)" },
  { test: /취락지구$/, level: "caution", reason: "취락지구: 취락 정비 목적의 지구로 건축할 수 있는 건축물이 정해져 있어요 (국토계획법 시행령 제78조)" },
  { test: /개발진흥지구$/, level: "caution", reason: "개발진흥지구: 지정 목적과 지구단위계획에 맞는 건축만 가능해요 (국토계획법 시행령 제79조)" },
  { test: /복합용도지구$/, level: "info", reason: "복합용도지구: 특정 시설의 입지를 완화하는 지구예요 (국토계획법 시행령 제81조)" },

  // ── 도시·군계획시설 부지 (포함이면 그 시설 외 건축 제한, 국토계획법 제64조) ──
  { test: /^(광로|대로|중로|소로)[0-9]류|^도로구역$|^일반도로$|^도로$/, level: "block", reason: "도로 부지(도시·군계획시설): 도로 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /공원$/, level: "block", reason: "공원 부지(도시·군계획시설): 공원시설 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /^(초등학교|중학교|고등학교|학교|유치원|대학교|특수학교)$/, level: "block", reason: "학교 부지(도시·군계획시설): 학교시설 외 건축이 제한돼요 (국토계획법 제64조)" },
  { test: /^(주차장|전기공급설비|가스공급설비|열공급설비|하수도|하수처리시설|저수지|유수지|광장|운동장|철도|방수설비|공동구|녹지|완충녹지|경관녹지|연결녹지)$/, level: "block", reason: "공공시설·녹지 부지(도시·군계획시설): 해당 시설 외 건축이 제한돼요 (국토계획법 제64조)" },

  // ── 실제 부산 토지이용계획에 나온 지구·구역 (VWorld 이름 기준) ──
  { test: /^(국가지정문화유산구역|시도지정문화유산구역|시·도지정문화유산구역|지정문화유산구역|국가지정문화재|시도지정문화재)$/, level: "block", reason: "지정문화유산 부지: 건축·현상변경이 원칙적으로 허용되지 않아요 (문화유산의 보존 및 활용에 관한 법률)" },
  { test: /(등록문화유산구역|전통사찰보존구역)/, level: "caution", reason: "등록문화유산·전통사찰 구역: 현상변경 신고·허가가 필요해요 (문화유산법, 전통사찰의 보존 및 지원에 관한 법률)" },
  { test: /(문화유산보호구역|역사문화환경보존지역|문화재보호구역)/, level: "caution", reason: "문화유산 주변 보호구역: 현상변경 허가·심의가 필요해요 (문화유산의 보존 및 활용에 관한 법률)" },
  { test: /(공원자연환경지구|공원자연보존지구|공원마을지구)/, level: "caution", reason: "자연공원 지구: 허용되는 행위가 제한돼요 (자연공원법)" },
  { test: /철도보호지구$/, level: "caution", reason: "철도보호지구: 건축물 신축 등을 하려면 철도운영자에게 신고·협의해야 해요 (철도안전법)" },
  { test: /(자연재해위험개선지구|해일위험지구|급경사지붕괴위험지구|침수흔적)/, level: "caution", reason: "재해 위험 지구: 재해예방 조치와 건축 제한이 있을 수 있어요 (자연재해대책법)" },
  { test: /(주거환경개선지구|재정비촉진지구|공공지원민간임대주택 공급촉진지구|환경정비구역|교육·연구 및 사업화시설구역|지원시설구역|지구단위계획구역)/, level: "caution", reason: "개발 계획 지구: 지정 목적과 계획 내용에 맞는 건축만 가능해요" },
  { test: /(군사기지 및 군사시설 보호구역|군사시설보호구역)/, level: "caution", reason: "군사기지·군사시설 보호구역: 관할 군 협의가 필요하고 통제보호구역은 건축이 제한돼요 (군사기지 및 군사시설 보호법)" },
  { test: /(생태·경관보전지역|생태경관보전지역|습지보호지역)/, level: "caution", reason: "생태·경관보전지역: 핵심구역에서는 건축이 금지되고 완충구역에서는 제한돼요 (자연환경보전법)" },
  { test: /(온천지구|온천원보호지구)/, level: "caution", reason: "온천 보호 지구: 온천 이용에 지장을 주는 개발이 제한돼요 (온천법)" },
  { test: /^(교육환경보호구역|상대보호구역|절대보호구역)$/, level: "info", reason: "교육환경보호구역: 유해시설(숙박·유흥 등)만 제한되고 청사·공공주택은 대상이 아니에요 (교육환경 보호에 관한 법률)" },
  { test: /^(가축사육제한구역|토지거래계약에관한허가구역|지적재조사사업지구|도시지역|입체적도로구역)$/, level: "info", reason: "건축 가능 여부와 직접 관련이 없는 구역이에요" },

  // ── 타법 지역지구 ──
  { test: /^농업진흥구역$/, level: "block", reason: "농업진흥구역(절대농지): 농업 생산 관련 행위·시설, 농업인 주택, 일부 공공시설(도로·상하수도 등) 외에는 지을 수 없어요. 공공주택·청사는 허용 목록에 없어요 (농지법 제32조, 시행령 제29조)" },
  { test: /^상수원보호구역$/, level: "block", reason: "상수원보호구역: 건축물 신축이 원칙적으로 금지돼요 (상수원관리법 제7조)" },
  { test: /^통제보호구역$/, level: "block", reason: "통제보호구역: 군사 목적 외 건축이 제한돼요 (군사기지 및 군사시설 보호법)" },
  { test: /^농업보호구역$/, level: "caution", reason: "농업보호구역: 농업진흥구역을 보호하는 구역으로 건축 가능한 시설이 제한돼요 (농지법 제34조)" },
  { test: /(건축허가\s*제한|착공\s*제한)/, level: "caution", reason: "건축허가·착공이 제한되는 지역이에요 (건축법 제18조: 최대 2년, 1회 1년 연장)" },
  { test: /^개발행위허가제한지역$/, level: "caution", reason: "개발행위허가 제한 기간 중에는 건축 허가가 제한될 수 있어요 (국토계획법 제63조)" },
  { test: /^산지전용·일시사용제한지역$/, level: "caution", reason: "산지전용·일시사용이 제한되는 지역이라 산지 안 건축이 어려울 수 있어요 (산지관리법)" },
  { test: /(하천구역|소하천구역)/, level: "caution", reason: "하천구역: 점용허가 등 하천 관리청 협의가 필요해요 (하천법)" },
  { test: /(공익용산지|보전산지)/, level: "caution", reason: "산지: 산지전용 허가가 필요하고 용도에 따라 제한돼요 (산지관리법)" },
  { test: /(문화재|역사문화환경보존지역)/, level: "caution", reason: "문화재 주변: 현상변경 허가·심의가 필요해요 (문화재보호법)" },
  { test: /(제한보호구역|군사시설보호구역|비행안전구역)/, level: "caution", reason: "군사 관련 구역: 관할 군 협의가 필요해요" },
  { test: /(항만구역|항만재개발)/, level: "caution", reason: "항만 관련 구역: 항만법에 따른 허가·협의가 필요해요" },
  { test: /(정비구역|정비예정구역)/, level: "caution", reason: "정비구역: 정비계획에 따라 건축이 제한돼요 (도시정비법)" },
  { test: /(택지개발지구|산업단지|지구단위계획구역)/, level: "caution", reason: "개발 계획 구역: 지정 목적과 계획 내용을 확인해야 해요 (지구단위계획구역은 국토계획법 제49~52조)" },
  { test: /(가로구역별 최고높이|중점경관관리구역|경관지구)/, level: "caution", reason: "높이·경관 제한이 있을 수 있어요" },
  { test: /(백두대간|자연공원|공원자연)/, level: "caution", reason: "자연공원·보호 구역: 건축 제한이 있을 수 있어요" },
];

// relation: VWorld가 알려 주는 "포함"(땅이 지구 안), "저촉"(일부가 걸침), "접함"(맞닿음)
// purpose를 주면 그 용도에 해당하는 규정만 남기고, 안 주면 용도별 규정에 purposes(해당 용도 목록)를 붙여 돌려줍니다.
export function classifyLandUse(rows: { name: string; relation: string }[], purpose?: string): { blocking: NoBuildHit[]; caution: NoBuildHit[] } {
  const blocking: NoBuildHit[] = [];
  const caution: NoBuildHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.relation !== "포함" && row.relation !== "저촉") continue;
    const rule = RULES.find((r) => r.test.test(row.name));
    if (!rule || rule.level === "info") continue;
    if (rule.only && purpose && !rule.only.includes(purpose)) continue;
    const key = `${row.name}|${row.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit: NoBuildHit = { name: row.name, relation: row.relation, reason: rule.reason, ...(rule.only && !purpose ? { purposes: rule.only } : {}), ...(rule.caps ? { caps: rule.caps } : {}) };
    if (rule.level === "block" && row.relation === "포함") blocking.push(hit);
    else caution.push({ ...hit, reason: rule.level === "block" ? `${rule.reason} — 일부만 걸쳐 있어요` : rule.reason });
  }
  return { blocking, caution };
}

// 필지마다 따로 판정해서, 같은 지구에 걸린 필지 수와 면적 비율을 함께 돌려줌 (묶음 전체가 아니라 일부 필지만 해당할 수 있음)
export function classifyParcels(parcels: { area: number; rows: { name: string; relation: string }[] }[], siteArea: number, purpose?: string): { blocking: NoBuildHit[]; caution: NoBuildHit[] } {
  const agg = (pick: "blocking" | "caution") => {
    const map = new Map<string, NoBuildHit & { parcels: number; areaSum: number }>();
    for (const p of parcels) {
      for (const h of classifyLandUse(p.rows, purpose)[pick]) {
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

// 지구가 정한 수치(건폐율·높이·조경)를 면적의 절반 이상이 그 지구에 포함될 때만 적용
export function districtCapsOf(hits: NoBuildHit[]): { name: string; bcr?: number; height?: number; landscape?: number; reason: string }[] {
  return hits.filter((h) => h.caps && h.relation === "포함" && (h.areaShare ?? 0) >= 0.5).map((h) => ({ name: h.name, ...h.caps!, reason: h.reason }));
}

// ── 도로에 접해야 하는 요건 (건축법 제44조 + 시행령 제28조②) ──
// 건축물의 대지는 2m 이상 도로에 접해야 하고, 연면적 2,000㎡ 이상이면 너비 6m 이상 도로에 4m 이상 접해야 합니다.
// VWorld 토지이용계획에는 도시·군계획도로(폭 구분 포함)와 "접함" 정보만 있고, 현황도로(도시계획에 없는 실제 길)는 없어서
// 이 정보가 없다고 해서 맹지라고 단정하지 않고 "확인 필요"로만 알립니다.
const ROAD_CLASS = /^(광로|대로|중로|소로)([0-9])류(?:\(폭\s*([0-9]+)m?(?:\s*[~-]\s*([0-9]+)m)?\s*(미만)?\))?/;

export function roadAccessCheck(rows: { name: string; relation: string }[]): string | null {
  const touching = rows.filter((r) => r.relation === "접함" && (ROAD_CLASS.test(r.name) || /^(일반도로|도로)$/.test(r.name)));
  const wide = touching.some((r) => {
    const m = ROAD_CLASS.exec(r.name);
    if (!m) return false;
    if (m[1] !== "소로") return true; // 광로·대로·중로는 너비 12m 이상
    return !m[5] && Number(m[3]) >= 6; // 소로 중 폭이 6m 이상으로 적힌 것(소로1·2류)
  });
  if (wide) return null;
  const base = "건축법 제44조·시행령 제28조②: 연면적 2,000㎡ 이상 건축물의 대지는 너비 6m 이상 도로에 4m 이상 접해야 합니다";
  if (touching.length > 0) {
    return `접한 도로(${[...new Set(touching.map((r) => r.name))].join(", ")})의 너비가 6m 이상인지 확인 필요. ${base}`;
  }
  return `도시·군계획도로에 접한다는 정보가 없음 (맹지이거나 현황도로에만 접할 수 있음): 접도 여부 확인 필요. ${base}`;
}
