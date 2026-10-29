// 한국어 문장을 검색 조건으로 바꾸는 규칙 기반 해석기 (브라우저·서버 모두에서 쓸 수 있음).
// 문장에 없는 조건은 지금 값을 그대로 두고, 알아듣지 못한 부분은 지어내지 않고 되물어요.

import { BUSAN_DONGS, BUSAN_GUS } from "./regions";
import { ALL_JIMOK, DEFAULT_RESULT_LIMIT, OWNER_TYPES, type SearchCriteria } from "./land-types";

export type NlState = { criteria: SearchCriteria; gus: string[] };

export type NlResult = {
  state: NlState;
  understood: string[]; // 이번 문장에서 알아들은 조건
  questions: string[]; // 더 알려 달라고 되묻는 것
  canSearch: boolean;
};

const ALL_OWNERS = OWNER_TYPES.map((o) => o.value);
const AMBIGUOUS_GU = new Set(["중", "동", "서", "남", "북"]); // 반드시 '구'를 붙여 말해야 구·군으로 봄
const PYEONG = 3.3058;

const ownerLabel = (v: string) => OWNER_TYPES.find((o) => o.value === v)?.label.split(" ")[0] ?? v;

function parseNumber(raw: string): number {
  let s = raw.replace(/,/g, "");
  let mult = 1;
  if (/만$/.test(s)) { mult = 10000; s = s.slice(0, -1); }
  else if (/천$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
  return Number(s) * mult;
}

export function parseQuery(text: string, current: NlState): NlResult {
  const t = text.replace(/\s+/g, " ").trim();
  const next: NlState = { criteria: { ...current.criteria, ownerTypes: [...current.criteria.ownerTypes], excludedJimok: [...current.criteria.excludedJimok] }, gus: [...current.gus] };
  const understood: string[] = [];
  const questions: string[] = [];
  const add = (s: string) => understood.push(s);

  // 지역: 구·군 / 부산 전체 / 동
  const guHits: string[] = [];
  for (const g of BUSAN_GUS) {
    const base = g.name.replace(/[구군]$/, "");
    const withSuffix = t.includes(g.name);
    const bare = !AMBIGUOUS_GU.has(base) && base.length >= 2 && new RegExp(`${base}(?![가-힣])|${base}(?=[와과도만이가을를은는의에])`).test(t);
    if (withSuffix || bare) guHits.push(g.code);
  }
  const wholeBusan = /부산\s*(전체|전역|전부|시\s*전체)|전\s*지역|모든\s*(구|군|지역)/.test(t);
  // 동 이름 앞에 다른 한글이 붙어 있으면(예: '공동주택'의 '공동') 지역으로 보지 않음
  const dongHits = BUSAN_DONGS.filter((d) => new RegExp(`(?<![가-힣])${d.name}(?:(?![가-힣])|(?=[에의을를은는이가도만과와로랑]))`).test(t));
  const byName = new Map<string, typeof dongHits>();
  for (const d of dongHits) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);

  // 동 이름이 같은 구가 여럿이면, 문장에 나온 구로 좁힘
  const codes: string[] = [];
  const names: string[] = [];
  const dongQuestions: string[] = [];
  for (const [name, list0] of byName) {
    const list = list0.length > 1 && guHits.length > 0 ? list0.filter((d) => guHits.includes(d.gu)) : list0;
    if (list.length === 1) { codes.push(list[0].code); names.push(`${list[0].guName} ${name}`); }
    else if (list.length > 1) dongQuestions.push(`'${name}'은(는) ${list.map((d) => d.guName).join(", ")}에 있어요. 어느 구인지 알려 주세요.`);
  }

  if (wholeBusan) {
    next.gus = BUSAN_GUS.map((g) => g.code);
    next.criteria.dongs = [];
    add("지역: 부산 전체 (16개 구·군)");
  } else if (codes.length > 0) {
    next.criteria.dongs = codes;
    next.gus = [];
    add(`지역: ${names.join(", ")}`);
    questions.push(...dongQuestions);
  } else if (guHits.length > 0) {
    next.gus = guHits;
    next.criteria.dongs = [];
    add(`지역: ${guHits.map((c) => BUSAN_GUS.find((g) => g.code === c)!.name).join(", ")}`);
  } else questions.push(...dongQuestions);

  // 용도
  if (/공공\s*주택|임대\s*주택|주택|아파트|주거/.test(t)) { next.criteria.purpose = "공공주택"; add("용도: 공공주택"); }
  else if (/청사|관공서|공공\s*청사|사무소|행정\s*시설/.test(t)) { next.criteria.purpose = "청사"; add("용도: 청사"); }
  else if (/용도\s*(는|:)?\s*기타|기타\s*용도/.test(t)) { next.criteria.purpose = "기타"; add("용도: 기타"); }

  // 소유 구분
  const owners = new Set<string>();
  if (/국[·.\s]?공유지|국공유/.test(t)) ALL_OWNERS.forEach((o) => owners.add(o));
  else {
    if (/국유지|국가\s*(소유|땅|토지)|국가/.test(t)) owners.add("국유지");
    if (/시\s*도?\s*유지|부산시\s*(소유|땅|토지)|시\s*소유/.test(t)) owners.add("시 도유지");
    if (/구\s*[·]?\s*군\s*유지|구유지|군유지|구청\s*(소유|땅)|지자체/.test(t)) owners.add("군유지");
    if (/(^|\s)공유지/.test(t) && owners.size === 0) { owners.add("시 도유지"); owners.add("군유지"); }
  }
  if (owners.size > 0) {
    next.criteria.ownerTypes = ALL_OWNERS.filter((o) => owners.has(o));
    add(`소유: ${next.criteria.ownerTypes.map(ownerLabel).join("·")}`);
  }

  // 최소 면적
  const area = t.match(/(\d[\d,]*(?:\.\d+)?\s*[천만]?)\s*(㎡|제곱\s*미터|m2|평)\s*(이상|넘|초과|최소)?/i);
  if (area) {
    let v = parseNumber(area[1].replace(/\s/g, ""));
    if (/평/.test(area[2])) v = Math.round(v * PYEONG);
    if (/이하|미만|이내|까지/.test(t.slice((area.index ?? 0) + area[0].length, (area.index ?? 0) + area[0].length + 6))) {
      questions.push("면적 상한(이하·미만)은 아직 지원하지 않아요. 최소 면적만 정할 수 있어요.");
    } else if (Number.isFinite(v) && v >= 0) {
      next.criteria.minArea = Math.round(v);
      add(`최소 면적: ${next.criteria.minArea.toLocaleString("ko-KR")}㎡`);
    }
  }

  // 지목
  for (const j of ALL_JIMOK) {
    if (!t.includes(j)) continue;
    const idx = t.indexOf(j);
    const around = t.slice(idx + j.length, idx + j.length + 8);
    if (/포함|도\s*(보여|찾|넣)|까지/.test(around)) {
      next.criteria.excludedJimok = next.criteria.excludedJimok.filter((x) => x !== j);
      add(`지목 ${j} 포함`);
    } else if (/제외|빼|말고|없이/.test(around)) {
      if (!next.criteria.excludedJimok.includes(j)) next.criteria.excludedJimok.push(j);
      add(`지목 ${j} 제외`);
    }
  }

  // 개수
  const lim = t.match(/(?:상위\s*)?(\d+)\s*(곳|개)\s*(만|까지|정도)?/);
  if (lim && /상위|만|까지|정도|보여|알려/.test(t) && !/㎡|평/.test(lim[0])) {
    next.criteria.limit = Math.min(300, Math.max(10, Number(lim[1])));
    add(`결과 개수: ${next.criteria.limit}곳`);
  } else if (/기본\s*개수|개수\s*초기화/.test(t)) {
    next.criteria.limit = DEFAULT_RESULT_LIMIT;
  }

  // 초기화
  if (/처음부터|초기화|다시\s*시작/.test(t)) {
    next.criteria = { ...current.criteria, minArea: 1000, ownerTypes: [...ALL_OWNERS], limit: DEFAULT_RESULT_LIMIT };
    next.gus = ["26500"];
    understood.unshift("조건을 처음 상태로 되돌렸어요");
  }

  if (understood.length === 0 && questions.length === 0) {
    questions.push("조건을 알아듣지 못했어요. 예: \"수영구에서 청사 지을 국유지, 2천㎡ 이상\" 처럼 지역·용도·소유·면적을 말해 주세요.");
  }
  const hasRegion = next.gus.length > 0 || next.criteria.dongs.length > 0;
  if (!hasRegion) questions.push("어느 지역을 볼까요? (예: 수영구, 해운대구, 부산 전체)");
  const canSearch = understood.length > 0 && hasRegion && next.criteria.ownerTypes.length > 0;
  return { state: next, understood, questions, canSearch };
}

export const NL_EXAMPLES = [
  "수영구에서 청사 지을 국유지 2천㎡ 이상",
  "부산 전체 공공주택용 국·공유지 3,000㎡ 이상 상위 50곳",
  "남구랑 수영구 시유지 500평 넘는 땅",
  "학교용지도 포함해서 다시 찾아줘",
];

// ── AI가 돌려준 값을 허용된 값으로만 걸러 조건에 반영 (모델이 만든 값은 믿지 않음) ──
export type AiParse = {
  whole_busan?: boolean | null;
  gus?: string[] | null;
  dongs?: { gu?: string | null; name: string }[] | null;
  purpose?: string | null;
  owners?: string[] | null;
  min_area?: { value: number; unit: string } | null;
  include_jimok?: string[] | null;
  exclude_jimok?: string[] | null;
  limit?: number | null;
  clarify?: string | null;
};

export function applyAiParse(ai: AiParse, current: NlState): NlResult {
  const next: NlState = { criteria: { ...current.criteria, ownerTypes: [...current.criteria.ownerTypes], excludedJimok: [...current.criteria.excludedJimok] }, gus: [...current.gus] };
  const understood: string[] = [];
  const questions: string[] = [];

  if (ai.whole_busan) {
    next.gus = BUSAN_GUS.map((g) => g.code);
    next.criteria.dongs = [];
    understood.push("지역: 부산 전체 (16개 구·군)");
  } else {
    const gus = (Array.isArray(ai.gus) ? ai.gus : []).map((n) => BUSAN_GUS.find((g) => g.name === n)).filter((g): g is { code: string; name: string } => !!g);
    const dongs: typeof BUSAN_DONGS = [];
    for (const d of Array.isArray(ai.dongs) ? ai.dongs : []) {
      if (!d || typeof d.name !== "string") continue;
      const list = BUSAN_DONGS.filter((x) => x.name === d.name && (!d.gu || x.guName === d.gu));
      if (list.length === 1) dongs.push(list[0]);
      else if (list.length > 1) questions.push(`'${d.name}'은(는) ${list.map((x) => x.guName).join(", ")}에 있어요. 어느 구인지 알려 주세요.`);
    }
    if (dongs.length > 0) {
      next.criteria.dongs = dongs.map((d) => d.code);
      next.gus = [];
      understood.push(`지역: ${dongs.map((d) => `${d.guName} ${d.name}`).join(", ")}`);
    } else if (gus.length > 0) {
      next.gus = gus.map((g) => g.code);
      next.criteria.dongs = [];
      understood.push(`지역: ${gus.map((g) => g.name).join(", ")}`);
    }
  }

  if (ai.purpose === "청사" || ai.purpose === "공공주택" || ai.purpose === "기타") {
    next.criteria.purpose = ai.purpose;
    understood.push(`용도: ${ai.purpose}`);
  }

  const ownerMap: Record<string, string> = { 국유지: "국유지", 시유지: "시 도유지", 구군유지: "군유지" };
  const owners = [...new Set((Array.isArray(ai.owners) ? ai.owners : []).map((o) => ownerMap[o]).filter(Boolean))];
  if (owners.length > 0) {
    next.criteria.ownerTypes = ALL_OWNERS.filter((o) => owners.includes(o));
    understood.push(`소유: ${next.criteria.ownerTypes.map(ownerLabel).join("·")}`);
  }

  const ma = ai.min_area;
  const m2 = ma && typeof ma.value === "number" ? ma.value * (ma.unit === "평" ? PYEONG : 1) : NaN; // 환산은 AI가 아니라 코드가 함
  if (Number.isFinite(m2) && m2 >= 0 && m2 <= 10_000_000) {
    next.criteria.minArea = Math.round(m2);
    understood.push(`최소 면적: ${next.criteria.minArea.toLocaleString("ko-KR")}㎡`);
  }
  for (const j of Array.isArray(ai.include_jimok) ? ai.include_jimok : []) {
    if (!ALL_JIMOK.includes(j)) continue;
    next.criteria.excludedJimok = next.criteria.excludedJimok.filter((x) => x !== j);
    understood.push(`지목 ${j} 포함`);
  }
  for (const j of Array.isArray(ai.exclude_jimok) ? ai.exclude_jimok : []) {
    if (!ALL_JIMOK.includes(j)) continue;
    if (!next.criteria.excludedJimok.includes(j)) next.criteria.excludedJimok.push(j);
    understood.push(`지목 ${j} 제외`);
  }
  if (typeof ai.limit === "number" && Number.isFinite(ai.limit)) {
    next.criteria.limit = Math.min(300, Math.max(10, Math.round(ai.limit)));
    understood.push(`결과 개수: ${next.criteria.limit}곳`);
  }

  if (typeof ai.clarify === "string" && ai.clarify) questions.push(ai.clarify.slice(0, 120));
  if (understood.length === 0 && questions.length === 0) questions.push("조건을 알아듣지 못했어요. 지역·용도·소유·면적을 말해 주세요.");
  const hasRegion = next.gus.length > 0 || next.criteria.dongs.length > 0;
  if (!hasRegion) questions.push("어느 지역을 볼까요? (예: 수영구, 해운대구, 부산 전체)");
  return { state: next, understood, questions, canSearch: understood.length > 0 && hasRegion && next.criteria.ownerTypes.length > 0 };
}

// 규칙이 일부만 읽고 놓친 조건이 있어 보이면 true (면적·소유 관련 말이 있는데 그 조건을 못 뽑은 경우)
export function looksIncomplete(text: string, understood: string[]): boolean {
  if (understood.length === 0) return true;
  const hasArea = /[평㎡]|제곱|천s*평|만s*평|넓은|큰s*땅|이상/.test(text);
  const hasOwner = /국유|시유|구유|군유|공유|구청|시청|국가|지자체|가진|소유/.test(text);
  const gotArea = understood.some((u) => u.startsWith("최소 면적"));
  const gotOwner = understood.some((u) => u.startsWith("소유"));
  return (hasArea && !gotArea) || (hasOwner && !gotOwner);
}
