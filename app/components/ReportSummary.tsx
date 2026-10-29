"use client";

import type { LandGroup } from "@/lib/land-types";
import { UNIT_COST_DEFAULT, formatWon, resolveProjectCost, type CostParams } from "@/lib/project-cost";
import { USE_STATUS_LABEL, assessUse } from "@/lib/use-rules";
import type { DesignState } from "./DesignPanel";
import type { ReviewState } from "./ReviewPanel";

// 숫자 표기는 아래 패널들(ReviewPanel·DesignPanel·CostPanel)과 같은 형식을 씁니다
const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const pct = (share: number) => `${(share * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
const ownerLabel = (v: string) => (v === "시 도유지" ? "시유지" : v === "군유지" ? "구유지" : v);
const shortAddr = (addr: string) => addr.replace("부산광역시 ", "");

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="rounded border border-zinc-200 bg-white p-2" data-summary={testId}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-base font-semibold leading-tight text-zinc-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export default function ReportSummary({
  group,
  review,
  design,
  costParams,
  wide,
  onToggleWide,
  purpose,
}: {
  purpose: string; // 이 결과를 찾을 때 고른 용도
  group: LandGroup;
  review: ReviewState | undefined;
  design: DesignState | undefined;
  costParams: CostParams;
  wide: boolean;
  onToggleWide: () => void;
}) {
  const r = review?.data;
  const d = design?.data;
  const { land, cost } = resolveProjectCost(group, r, d, costParams);
  const hasBuilding = !!d && d.buildings.length > 0;
  // 설계한 건물 기준인데 놓을 수 있는 건물이 없으면 사업비를 계산할 연면적이 없음 (계산 중이 아님)
  const noBuilding = !!d && !hasBuilding && costParams.areaBasis === "design";
  const noBuildingReason = d?.use.status === "not_allowed" ? "용도 불가" : "배치한 건물이 없어서";
  const n = group.parcels.length;
  const title = `${shortAddr(group.parcels[0].addr)}${n > 1 ? ` 외 ${n - 1}필지` : ""}`;

  const use = r ? assessUse(purpose, r) : null;
  const zonesLabel = r ? r.parts.map((p) => (r.parts.length > 1 ? `${p.zone} ${pct(p.share)}` : p.zone)).join(", ") : "";

  // 한눈에 보는 결론 문장: 아래 패널과 같은 계산 결과로 만듦
  const lines: string[] = [];
  if (use?.supported) {
    lines.push(`${purpose} 용도 적합 여부: ${USE_STATUS_LABEL[use.overall]} — ${use.headline}`);
  }
  if (r?.totals) {
    const zones = r.parts.map((p) => (r.parts.length > 1 ? `${p.zone} ${pct(p.share)}` : p.zone)).join(", ");
    const rates =
      r.multiZone?.rule === "separate"
        ? "용도지역마다 규정이 따로 적용되어"
        : `건폐율 ${fmt(r.totals.bcr)}% · 용적률 ${fmt(r.totals.far)}%로`;
    lines.push(
      `${zones}에 속하며 조례 기준 ${rates} 최대 건축면적 ${fmt(r.totals.maxBuildingArea)}㎡, 최대 연면적 ${fmt(r.totals.maxFloorArea)}㎡까지 지을 수 있습니다.`,
    );
  }
  if (hasBuilding && d) {
    const usage = d.limits ? ` (최대 연면적의 ${Math.round((d.totals.floorArea / d.limits.maxFloorArea) * 100)}%)` : "";
    lines.push(
      `설계한 건물은 최고 ${d.totals.maxFloors}층(${fmt(d.totals.maxHeight)}m), 건축면적 ${fmt(d.totals.footprintArea)}㎡, 연면적 ${fmt(d.totals.floorArea)}㎡${usage}입니다.`,
    );
  }
  if (cost) {
    lines.push(
      `토지 가격(공시지가 기준) ${formatWon(cost.land.total)}, 예상 공사비 ${formatWon(cost.construction)}, 총사업비 ${formatWon(cost.total)}입니다 (㎡당 공사비 ${fmt(costParams.unitCost)}원 가정).`,
    );
  } else {
    lines.push(`토지 가격(공시지가 기준)은 ${formatWon(land.land.total)}입니다.`);
  }

  // 확인이 필요하거나 가정한 것을 한곳에 모음
  const checks: string[] = [];
  if (r) {
    if (!r.complete) checks.push(`용도지역을 확인하지 못한 부분(약 ${fmt(r.excluded.area)}㎡)은 계산에서 뺐습니다`);
    checks.push(...r.checks);
    if (use && !use.supported) {
      checks.push("용도를 '청사' 또는 '공공주택'으로 고르면 법령 기준 용도 적합 여부를 판정합니다");
    } else if (use?.overall === "not_allowed") {
      checks.push(`법령상 ${purpose}을(를) 지을 수 없는 용도지역입니다. 아래 건물 모형은 만들지 않았습니다`);
    } else if (use?.overall === "conditional") {
      for (const c of use.conditions) checks.push(`용도 조건: ${c}`);
    } else if (use?.overall === "unknown") {
      checks.push("용도 적합 여부를 판정하지 못했습니다 (법령 표를 반영하지 않은 용도지역이거나 용도지역을 확인하지 못함)");
    }
  }
  if (d && !d.verified.withinUseLimit) checks.push("건물이 용도 규정의 연면적·층수 상한을 넘었습니다. 이 건물 모형은 쓰지 마세요");
  if (d && d.buildings.length === 0) checks.push("배치할 수 있는 건물이 없습니다");
  if (d && !(d.verified.insideSite && d.verified.withinBuildingLimit && d.verified.withinFloorLimit)) {
    checks.push("건물 배치 검증에 실패했습니다. 이 건물 모형은 쓰지 마세요");
  }
  if (!land.land.complete) checks.push(`공시지가를 찾지 못한 필지(${fmt(land.land.missingArea)}㎡)는 토지 가격에서 뺐습니다`);
  if (costParams.unitCost === UNIT_COST_DEFAULT.value) {
    checks.push("㎡당 공사비는 아파트 기준 기본형건축비입니다. 청사 등은 달라질 수 있어 직접 입력을 권장합니다 (가정)");
  }
  if (costParams.otherCostRate === 0) checks.push("기타 비용(설계·감리 등)은 포함하지 않았습니다 (가정)");
  checks.push("토지 가격은 공시지가 기준 참고값이며 감정평가액이 아닙니다");

  return (
    <section className="rounded-lg border border-zinc-300 bg-zinc-50 p-3" aria-label="검토 요약">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-zinc-500">검토 요약</div>
          <h3 className="text-base font-semibold leading-snug">{title}</h3>
          <p className="text-xs text-zinc-600">
            {group.ownerTypes.map(ownerLabel).join("·")} · {n > 1 ? "일단의 토지" : "단독 필지"}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleWide}
          className="shrink-0 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
        >
          {wide ? "좁게 보기" : "리포트 넓게 보기"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile testId="zones" label="용도지역" value={r ? zonesLabel || "확인 불가" : "계산 중"} />
        <Tile
          testId="use"
          label={`용도 적합 (${purpose})`}
          value={!use ? "계산 중" : use.supported ? USE_STATUS_LABEL[use.overall] : "판정 안 함"}
          sub={use?.supported && use.overall === "conditional" && use.conditions[0] ? use.conditions[0] : undefined}
        />
        <Tile testId="siteArea" label="대지면적" value={`${fmt(r?.siteArea ?? group.totalArea)}㎡`} />
        <Tile testId="maxBuilding" label="최대 건축면적" value={r?.totals ? `${fmt(r.totals.maxBuildingArea)}㎡` : "계산 중"} sub={r?.totals ? `건폐율 ${fmt(r.totals.bcr)}%` : undefined} />
        <Tile testId="maxFloor" label="최대 연면적" value={r?.totals ? `${fmt(r.totals.maxFloorArea)}㎡` : "계산 중"} sub={r?.totals ? `용적률 ${fmt(r.totals.far)}%` : undefined} />
        <Tile
          testId="building"
          label="설계한 건물"
          value={hasBuilding && d ? `${d.totals.maxFloors}층 · ${fmt(d.totals.maxHeight)}m` : d ? "배치 없음" : "계산 중"}
          sub={hasBuilding && d ? `연면적 ${fmt(d.totals.floorArea)}㎡` : undefined}
        />
        <Tile testId="landPrice" label="토지 가격 (참고)" value={formatWon(land.land.total)} sub="공시지가 기준" />
        <Tile
          testId="totalCost"
          label="총사업비 (가정)"
          value={cost ? formatWon(cost.total) : noBuilding ? "계산 안 함" : "계산 중"}
          sub={cost ? `공사비 ${formatWon(cost.construction)}` : noBuilding ? noBuildingReason : undefined}
        />
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-zinc-800" data-summary="sentences">
        {lines.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        <div className="mb-1 font-semibold">확인 필요 · 가정 ({checks.length})</div>
        <ul className="list-disc space-y-0.5 pl-4">
          {checks.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
