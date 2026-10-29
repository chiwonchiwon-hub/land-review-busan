// 용도 적합 여부: 청사·공공주택을 그 용도지역에 지을 수 있는가.
//
// 근거는 국가법령정보센터에서 2026-10-29에 직접 읽은 아래 원문입니다.
//  - 국토의 계획 및 이용에 관한 법률 시행령 별표 4·5·6·7·9·14·17 (제71조제1항 관련)
//  - 부산광역시 도시계획 조례 별표 3·4·5·6·8·13·16 (제30조 관련, 시행 2026-04-08)
//  - 건축법 시행령 별표 1 제14호 가목: "공공업무시설: 국가 또는 지방자치단체의 청사와 외국공관의 건축물로서
//    제1종 근린생활시설에 해당하지 아니하는 것"  → '청사'는 이 항목으로 봅니다
//  - 건축법 시행령 별표 1 제2호 공동주택(아파트·연립주택·다세대주택·기숙사 등) → '공공주택'은 이 항목으로 봅니다
// 수영구에 있는 용도지역 7곳(제1·2·3종일반주거, 준주거, 일반상업, 준공업, 자연녹지)만 넣었고
// 그 밖의 용도지역은 "확인 필요"로 둡니다.

import type { ZonePart } from "./land-types";
import { USE_RULES_BUSAN } from "./use-rules-busan";
import { SMALL_PART_LIMIT_M2 } from "./zoning-rules";

// 판정에 필요한 만큼만 받음 (3단계 검토 결과 전체이거나, 목록에서 필지별 비율로 만든 근사값)
export type UseReviewInput = {
  parts: Pick<ZonePart, "zone" | "area" | "share">[];
  multiZone: { rule: "weighted" | "separate" } | null;
  complete: boolean;
  greenbelt?: { share: number } | null;
  excluded?: { share: number };
};

// 이 비율 이상이면 판정할 수 없는 것으로 봄 (개발제한구역, 법령 표를 반영하지 않은 용도지역)
export const GREENBELT_LIMIT = 0.05;
export const UNSUPPORTED_LIMIT = 0.1;

export type UseStatus = "allowed" | "conditional" | "not_allowed" | "unknown";
export const USE_PURPOSES = ["청사", "공공주택"] as const;
export type UsePurpose = (typeof USE_PURPOSES)[number];

export const USE_STATUS_LABEL: Record<UseStatus, string> = {
  allowed: "가능",
  conditional: "조건부 가능",
  not_allowed: "건축 불가",
  unknown: "확인 필요",
};

export type UseBasis = { ref: string; text: string };

export type UseRule = {
  status: UseStatus;
  summary: string; // 한 줄 결론
  conditions: string[]; // 지켜야 할 조건
  floorAreaLt?: number; // 이 용도로 쓰는 바닥면적 합계가 이 값(㎡) 미만이어야 함
  maxFloors?: number; // 층수 상한
  notes?: string[];
  basis: UseBasis[];
};

export const USE_RULE_SOURCES = {
  checkedOn: "2026-10-29",
  items: [
    "국토의 계획 및 이용에 관한 법률 시행령 별표 4·5·6·7·9·14·17 (국가법령정보센터)",
    "부산광역시 도시계획 조례 별표 3·4·5·6·8·13·16 (시행 2026-04-08)",
    "건축법 시행령 별표 1 제14호·제2호 (개정 2025.10.1.)",
  ],
  url: "https://www.law.go.kr/법령/국토의계획및이용에관한법률시행령",
} as const;

const OFFICE_CAP = 3000;

const BASIS_OFFICE_DEF: UseBasis = {
  ref: "건축법 시행령 별표 1 제14호 가목",
  text: "공공업무시설: 국가 또는 지방자치단체의 청사와 외국공관의 건축물로서 제1종 근린생활시설에 해당하지 아니하는 것",
};

const SMALL_FACILITY_NOTE =
  "동·읍·면 주민센터 같은 제1종 근린생활시설에 해당하는 소규모 공공시설은 별도 기준(건축법 시행령 별표 1 제3호)이라 이 판정에 포함하지 않았습니다.";

export const USE_RULES: Record<UsePurpose, Record<string, UseRule>> = {
  청사: {
    제1종일반주거지역: {
      status: "not_allowed",
      summary: "청사(공공업무시설)를 지을 수 없음 — 허용 목록의 업무시설은 오피스텔뿐",
      conditions: [],
      notes: [SMALL_FACILITY_NOTE],
      basis: [
        BASIS_OFFICE_DEF,
        {
          ref: "국토계획법 시행령 별표 4 제2호 자목",
          text: "「건축법 시행령」 별표 1 제14호의 업무시설 중 오피스텔로서 그 용도에 쓰이는 바닥면적의 합계가 3천제곱미터 미만인 것",
        },
        { ref: "부산광역시 도시계획 조례 별표 3", text: "업무시설이 허용 건축물 목록에 없음 (4층 이하의 건축물에 한정)" },
      ],
    },
    제2종일반주거지역: {
      status: "conditional",
      summary: "조례에 따라 건축 가능 — 청사 용도 바닥면적 합계 3,000㎡ 미만일 때",
      conditions: ["청사 용도로 쓰는 바닥면적의 합계가 3,000㎡ 미만이어야 함"],
      floorAreaLt: OFFICE_CAP,
      basis: [
        BASIS_OFFICE_DEF,
        {
          ref: "국토계획법 시행령 별표 5 제2호 아목",
          text: "「건축법 시행령」 별표 1 제14호의 업무시설 중 오피스텔·금융업소·사무소 및 동호 가목에 해당하는 것으로서 해당용도에 쓰이는 바닥면적의 합계가 3천제곱미터 미만인 것",
        },
        {
          ref: "부산광역시 도시계획 조례 별표 4 제7호",
          text: "「건축법 시행령」 별표 1 제14호의 업무시설 중 공공업무시설 및 일반업무시설(금융업소, 사무소 및 오피스텔에 한정한다)로서 해당 용도에 쓰이는 바닥면적의 합계가 3천제곱미터 미만인 것",
        },
      ],
    },
    제3종일반주거지역: {
      status: "conditional",
      summary: "조례에 따라 건축 가능 — 업무시설 용도 바닥면적 합계 3,000㎡ 미만일 때",
      conditions: ["업무시설(청사) 용도로 쓰는 바닥면적의 합계가 3,000㎡ 미만이어야 함 (조례 기준, 시행령은 3,000㎡ 이하)"],
      floorAreaLt: OFFICE_CAP,
      basis: [
        BASIS_OFFICE_DEF,
        {
          ref: "국토계획법 시행령 별표 6 제2호 아목",
          text: "「건축법 시행령」 별표 1 제14호의 업무시설로서 그 용도에 쓰이는 바닥면적의 합계가 3천제곱미터 이하인 것",
        },
        {
          ref: "부산광역시 도시계획 조례 별표 5 제7호",
          text: "「건축법 시행령」 별표 1 제14호의 업무시설로서 해당 용도에 쓰이는 바닥면적의 합계가 3천제곱미터 미만인 것",
        },
      ],
    },
    준주거지역: {
      status: "allowed",
      summary: "건축 가능 — 업무시설은 건축할 수 없는 건축물 목록에 없음",
      conditions: [],
      basis: [
        BASIS_OFFICE_DEF,
        { ref: "국토계획법 시행령 별표 7", text: "준주거지역안에서 건축할 수 없는 건축물 목록에 업무시설(제14호)이 없음" },
        { ref: "부산광역시 도시계획 조례 별표 6", text: "건축할 수 없는 건축물: 안마시술소, 대규모점포, 자동차 정비공장 (업무시설 없음)" },
      ],
    },
    일반상업지역: {
      status: "allowed",
      summary: "건축 가능 — 업무시설은 건축할 수 없는 건축물 목록에 없음",
      conditions: [],
      basis: [
        BASIS_OFFICE_DEF,
        { ref: "국토계획법 시행령 별표 9", text: "일반상업지역안에서 건축할 수 없는 건축물 목록에 업무시설(제14호)이 없음" },
        { ref: "부산광역시 도시계획 조례 별표 8", text: "건축할 수 없는 건축물: 공동주택(주거복합 제외), 교정시설 등 (업무시설 없음)" },
      ],
    },
    준공업지역: {
      status: "allowed",
      summary: "건축 가능 — 업무시설은 건축할 수 없는 건축물 목록에 없음",
      conditions: [],
      basis: [
        BASIS_OFFICE_DEF,
        { ref: "국토계획법 시행령 별표 14", text: "준공업지역 안에서 건축할 수 없는 건축물 목록에 업무시설(제14호)이 없음" },
        { ref: "부산광역시 도시계획 조례 별표 13", text: "건축할 수 없는 건축물: 공동주택(예외 있음), 단란주점·안마시술소, 숙박시설 (업무시설 없음)" },
      ],
    },
    자연녹지지역: {
      status: "not_allowed",
      summary: "청사(업무시설)를 지을 수 없음 — 허용 목록에 업무시설이 없음",
      conditions: [],
      notes: [SMALL_FACILITY_NOTE],
      basis: [
        BASIS_OFFICE_DEF,
        { ref: "국토계획법 시행령 별표 17", text: "건축할 수 있는 건축물 목록(제1호·제2호)에 업무시설(제14호)이 없음 (4층 이하)" },
        { ref: "부산광역시 도시계획 조례 별표 16", text: "허용 목록에 업무시설이 없음 (4층 이하의 건축물에 한정)" },
      ],
    },
  },
  공공주택: {
    제1종일반주거지역: {
      status: "conditional",
      summary: "아파트를 뺀 공동주택(연립·다세대 등)만, 4층 이하로 건축 가능",
      conditions: ["아파트는 지을 수 없음 (연립주택·다세대주택·기숙사 형태)", "4층 이하"],
      maxFloors: 4,
      basis: [
        { ref: "국토계획법 시행령 별표 4 제1호 나목", text: "「건축법 시행령」 별표 1 제2호의 공동주택(아파트를 제외한다)" },
        {
          ref: "부산광역시 도시계획 조례 별표 3",
          text: "제1종일반주거지역안에서는 영 별표 4 제1호 각 목의 건축물과 같은 표 제2호에 따라 다음 각 호의 건축물을 건축할 수 있다(4층 이하의 건축물에 한정한다).",
        },
      ],
    },
    제2종일반주거지역: {
      status: "allowed",
      summary: "건축 가능 — 공동주택이 허용 목록에 있음",
      conditions: [],
      notes: ["시행령은 경관관리 등을 위해 조례로 층수를 제한할 수 있다고 하나, 확인한 부산 조례 별표 4에는 층수 제한 규정이 없습니다."],
      basis: [{ ref: "국토계획법 시행령 별표 5 제1호 나목", text: "「건축법 시행령」 별표 1 제2호의 공동주택" }],
    },
    제3종일반주거지역: {
      status: "allowed",
      summary: "건축 가능 — 공동주택이 허용 목록에 있음",
      conditions: [],
      basis: [{ ref: "국토계획법 시행령 별표 6 제1호 나목", text: "「건축법 시행령」 별표 1 제2호의 공동주택" }],
    },
    준주거지역: {
      status: "allowed",
      summary: "건축 가능 — 공동주택은 건축할 수 없는 건축물 목록에 없음",
      conditions: [],
      basis: [
        { ref: "국토계획법 시행령 별표 7", text: "준주거지역안에서 건축할 수 없는 건축물 목록에 공동주택(제2호)이 없음" },
        { ref: "부산광역시 도시계획 조례 별표 6", text: "건축할 수 없는 건축물: 안마시술소, 대규모점포, 자동차 정비공장 (공동주택 없음)" },
      ],
    },
    일반상업지역: {
      status: "conditional",
      summary: "조례에 따라 공동주택만으로는 건축 불가 — 주거 외 용도와 복합하고 공동주택 부분이 연면적의 90% 미만일 때 가능",
      conditions: ["주거 외 용도(상가·업무 등)와 복합한 건축물이어야 함", "공동주택 부분의 면적이 연면적 합계의 90% 미만이어야 함"],
      basis: [
        {
          ref: "부산광역시 도시계획 조례 별표 8 제1호 가목",
          text: "「건축법 시행령」 별표 1 제2호의 공동주택[공동주택과 주거용 외의 용도가 복합된 건축물(다수의 건축물이 일체적으로 연결된 하나의 건축물을 포함한다)로서 공동주택 부분의 면적이 연면적의 합계가 90퍼센트 미만인 것은 제외한다]",
        },
        { ref: "국토계획법 시행령 별표 9 제2호 나목", text: "공동주택은 조례로 정하는 바에 따라 건축할 수 없는 건축물에 해당 (주거복합 제외)" },
      ],
    },
    준공업지역: {
      status: "not_allowed",
      summary: "조례에 따라 공동주택을 새로 지을 수 없음 (기숙사·재건축 등 예외만 허용)",
      conditions: [],
      notes: ["예외: 기숙사, 연립·다세대주택(도시계획위원회 심의 등 조건), 재건축·소규모재건축으로 짓는 공동주택"],
      basis: [
        {
          ref: "부산광역시 도시계획 조례 별표 13 제1호",
          text: "「건축법 시행령」 별표 1 제2호의 공동주택. 다만, 다음 각 목의 어느 하나에 해당하는 공동주택은 제외한다. 가. 기숙사 나. 연립주택 및 다세대주택(허가권자가 기존 주거용 건축물에 대해 도시의 균형발전·공업기능의 보호 및 주거환경 등에 지장이 없다고 인정하여 해당 도시계획위원회의 심의를 거쳐 건축하는 경우로 한정한다) 다. 「도시 및 주거환경정비법」에 따른 재건축사업 또는 「빈집 및 소규모주택 정비에 관한 특례법」에 따른 소규모재건축사업으로 건축하는 공동주택",
        },
      ],
    },
    자연녹지지역: {
      status: "conditional",
      summary: "아파트를 뺀 공동주택(연립·다세대 등)만, 4층 이하로 건축 가능",
      conditions: ["아파트는 지을 수 없음 (연립주택·다세대주택 형태)", "4층 이하"],
      maxFloors: 4,
      basis: [
        { ref: "국토계획법 시행령 별표 17 제2호 가목", text: "「건축법 시행령」 별표 1 제2호의 공동주택(아파트를 제외한다)" },
        {
          ref: "부산광역시 도시계획 조례 별표 16",
          text: "자연녹지지역안에서는 영 별표 17 제1호 각 목의 건축물과 같은 표 제2호에 따라 다음 각 호의 건축물을 건축할 수 있다(4층 이하의 건축물에 한정한다). 1. 「건축법 시행령」 별표 1 제2호의 공동주택(아파트는 제외한다)",
        },
      ],
    },
  },
};

// 부산 전체로 넓히면서 추가한 용도지역 10곳을 합침
Object.assign(USE_RULES.청사, USE_RULES_BUSAN.청사);
Object.assign(USE_RULES.공공주택, USE_RULES_BUSAN.공공주택);

const NOT_IMPLEMENTED_ZONE: UseRule = {
  status: "unknown",
  summary: "이 용도지역은 법령 표를 아직 반영하지 않아 판정하지 못함",
  conditions: [],
  basis: [],
};

// ── 판정 ──

export type UsePartAssessment = {
  zone: string;
  area: number;
  share: number;
  status: UseStatus;
  rule: UseRule;
  applies: boolean; // 판정에 반영한 부분인가 (가중평균 적용 땅은 가장 넓은 부분만 반영)
};

export type UseAssessment = {
  purpose: string;
  supported: boolean; // 청사·공공주택이 아니면 판정하지 않음
  mode: "single" | "largest-zone" | "per-part" | "none";
  overall: UseStatus;
  headline: string;
  parts: UsePartAssessment[];
  conditions: string[]; // 반영한 부분들의 조건을 모은 것
  notes: string[];
};

export function ruleFor(purpose: string, zone: string): UseRule | null {
  if (!(USE_PURPOSES as readonly string[]).includes(purpose)) return null;
  return USE_RULES[purpose as UsePurpose][zone] ?? NOT_IMPLEMENTED_ZONE;
}

export function assessUse(purpose: string, review: UseReviewInput): UseAssessment {
  const base: UseAssessment = {
    purpose,
    supported: (USE_PURPOSES as readonly string[]).includes(purpose),
    mode: "none",
    overall: "unknown",
    headline: "",
    parts: [],
    conditions: [],
    notes: [],
  };
  if (!base.supported) {
    return { ...base, headline: "용도를 '청사' 또는 '공공주택'으로 고르면 법령 기준 적합 여부를 판정합니다." };
  }
  if (review.parts.length === 0) {
    return { ...base, headline: "용도지역을 확인하지 못해 판정하지 못했습니다 (확인 필요)." };
  }

  // 국토계획법 제84조제1항: 둘 이상의 용도지역에 걸치고 가장 작은 부분이 330㎡ 이하이면
  // 건폐율·용적률 외의 건축 제한은 가장 넓은 면적이 속하는 용도지역의 규정을 적용
  const mode: UseAssessment["mode"] =
    review.parts.length === 1 ? "single" : review.multiZone?.rule === "weighted" ? "largest-zone" : "per-part";
  const parts: UsePartAssessment[] = review.parts.map((p, i) => {
    const rule = ruleFor(base.purpose, p.zone)!;
    return {
      zone: p.zone,
      area: p.area,
      share: p.share,
      status: rule.status,
      rule,
      applies: mode !== "largest-zone" || i === 0, // review.parts는 면적이 큰 순서
    };
  });

  const applying = parts.filter((p) => p.applies);
  const statuses = applying.map((p) => p.status);
  let overall: UseStatus;
  if (statuses.every((s) => s === "not_allowed")) overall = "not_allowed";
  else if (statuses.every((s) => s === "allowed")) overall = "allowed";
  else if (statuses.includes("unknown")) overall = "unknown";
  else overall = "conditional";

  const notes: string[] = [];
  if (mode === "largest-zone") {
    notes.push(
      `둘 이상의 용도지역에 걸치지만 가장 작은 부분이 ${SMALL_PART_LIMIT_M2}㎡ 이하라서, 건폐율·용적률 외의 건축 제한은 가장 넓은 ${applying[0].zone}의 규정을 적용합니다 (국토계획법 제84조제1항).`,
    );
  }
  if (mode === "per-part") {
    notes.push("용도지역마다 규정이 따로 적용되어 부분별로 판정했습니다 (국토계획법 제84조).");
    if (statuses.some((s) => s === "not_allowed") && statuses.some((s) => s !== "not_allowed")) {
      overall = "conditional";
      notes.push("건축할 수 없는 용도지역 부분이 섞여 있어, 허용되는 부분에서만 건축할 수 있습니다.");
    }
  }
  if (!review.complete) notes.push("용도지역을 확인하지 못한 부분은 판정에서 제외했습니다.");
  for (const p of applying) notes.push(...(p.rule.notes ?? []));

  const conditions = [...new Set(applying.flatMap((p) => p.rule.conditions))];
  let headline =
    mode === "per-part"
      ? applying.map((p) => `${p.zone}: ${USE_STATUS_LABEL[p.status]}`).join(" · ")
      : `${applying[0].zone}: ${applying[0].rule.summary}`;

  // 개발제한구역이나 법령 표를 반영하지 않은 용도지역이 많이 걸치면 판정하지 않음
  const gb = review.greenbelt?.share ?? 0;
  const unsupported = review.excluded?.share ?? 0;
  if (gb >= GREENBELT_LIMIT) {
    overall = "unknown";
    headline = `개발제한구역에 ${Math.round(gb * 100)}% 걸쳐 있어 이 검토로는 판정하지 않습니다 (개발제한구역법 등 별도 법령 적용)`;
    notes.unshift("개발제한구역은 용도지역과 별개로 건축이 크게 제한됩니다. 이 도구는 개발제한구역 안의 건축 가능 여부를 판정하지 않습니다.");
  } else if (unsupported >= UNSUPPORTED_LIMIT) {
    overall = "unknown";
    headline = `법령 표를 반영하지 않은 용도지역(관리·농림지역 등)이 ${Math.round(unsupported * 100)}% 걸쳐 있어 판정하지 않습니다`;
  }

  return { ...base, mode, overall, headline, parts, conditions, notes };
}

// ── 3D 건물 디자인에 넘기는 상한 ──

export type UseLimit = {
  zone: string | null; // null이면 대지 전체에 적용
  allowed: boolean;
  floorAreaLt?: number;
  maxFloors?: number;
  rule: UseRule;
};

// 이 판정에서 실제 건물을 놓을 때 지켜야 할 한도. 판정하지 않는 용도(기타)는 빈 목록 = 제한 없음
export function limitsFor(a: UseAssessment): UseLimit[] {
  if (!a.supported) return [];
  return a.parts
    .filter((p) => p.applies)
    .map((p) => ({
      zone: a.mode === "per-part" ? p.zone : null,
      allowed: p.status !== "not_allowed",
      floorAreaLt: p.rule.floorAreaLt,
      maxFloors: p.rule.maxFloors,
      rule: p.rule,
    }));
}

// 미만 조건은 0.01㎡ 작게 잡아 상한을 넘지 않게 함
export const capBelow = (lt: number) => Math.floor((lt - 0.01) * 100) / 100;
