"use client";

import type { BuildingDesign, LandGroup, LandReview } from "@/lib/land-types";
import {
  UNIT_COST_DEFAULT,
  formatWon,
  resolveProjectCost,
  type AreaBasis,
  type CostParams,
} from "@/lib/project-cost";

const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const shortAddr = (addr: string) => addr.replace("부산광역시 ", "");

export default function CostPanel({
  group,
  review,
  design,
  params,
  onParamsChange,
}: {
  group: LandGroup;
  review: LandReview | undefined;
  design: BuildingDesign | undefined;
  params: CostParams;
  onParamsChange: (p: CostParams) => void;
}) {
  // 고른 기준의 연면적을 아직 모르면 사업비는 계산하지 않고, 토지 가격만 보여 줌
  const { designFloor, maxFloor, land, cost } = resolveProjectCost(group, review, design, params);

  return (
    <section>
      <h4 className="mb-2 text-base font-semibold">토지 가격과 사업비</h4>

      {/* 토지 가격 */}
      <div className="rounded border border-zinc-200 p-3 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="font-semibold">토지 가격 (참고용)</span>
          <span className="font-semibold">{formatWon(land.land.total)}</span>
        </div>
        <div className="text-right text-xs text-zinc-500">{fmt(land.land.total)}원</div>
        <p className="mt-1 text-xs text-zinc-600">
          필지별 면적 × 개별공시지가의 합계예요. 공시 기준 {land.land.priceDates.join(", ") || "확인 불가"} · 출처 VWorld(연속지적도 개별공시지가)
        </p>
        {!land.land.complete && (
          <p className="mt-1 rounded bg-amber-50 p-2 text-xs text-amber-900">
            공시지가를 찾지 못한 필지({fmt(land.land.missingArea)}㎡)는 합계에서 뺐습니다. 확인 필요.
          </p>
        )}
        <details className="mt-2 text-xs text-zinc-600">
          <summary className="cursor-pointer font-medium">필지별 계산 ({land.land.rows.length}필지)</summary>
          <table className="mt-1 w-full">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-0.5 font-medium">주소</th>
                <th className="text-right font-medium">면적(㎡) × 공시지가(원/㎡)</th>
                <th className="text-right font-medium">금액(원)</th>
              </tr>
            </thead>
            <tbody>
              {land.land.rows.map((r) => (
                <tr key={r.pnu} className="border-t border-zinc-100">
                  <td className="py-0.5">{shortAddr(r.addr)}</td>
                  <td className="text-right">
                    {fmt(r.area)} × {r.price === null ? "확인 불가" : fmt(r.price)}
                  </td>
                  <td className="text-right">{r.amount === null ? "-" : fmt(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="mt-2 text-xs text-amber-800">
          공시지가는 세금 등의 기준이 되는 가격이라 실제 거래가나 감정평가액이 아닙니다. 국·공유재산의 매각·대부 가격은 감정평가로 정해지므로
          이 금액은 검토용 참고값이에요.
        </p>
      </div>

      {/* 공사비 가정값 */}
      <div className="mt-3 space-y-2 text-xs">
        <label className="block">
          <span className="mb-0.5 block text-zinc-600">㎡당 공사비 (원, 가정값)</span>
          <input
            type="number"
            min={0}
            step={10000}
            className="w-full rounded border border-zinc-300 px-2 py-1"
            value={params.unitCost}
            onChange={(e) => onParamsChange({ ...params, unitCost: Math.max(0, Number(e.target.value)) })}
          />
          <button
            type="button"
            className="mt-0.5 text-blue-700 underline"
            onClick={() => onParamsChange({ ...params, unitCost: UNIT_COST_DEFAULT.value })}
          >
            기본값({fmt(UNIT_COST_DEFAULT.value)}원)으로 되돌리기
          </button>
        </label>
        <div className="rounded bg-amber-50 p-2 text-amber-900">
          <div className="font-semibold">기본값 출처</div>
          <div>{UNIT_COST_DEFAULT.label}</div>
          <div className="mt-1">{UNIT_COST_DEFAULT.scope}</div>
          <div className="mt-1">
            {UNIT_COST_DEFAULT.verified}{" "}
            <a href={UNIT_COST_DEFAULT.url} target="_blank" rel="noopener noreferrer" className="underline">
              자료 보기
            </a>
          </div>
        </div>
        <label className="block">
          <span className="mb-0.5 block text-zinc-600">기타 비용 (공사비 대비 %, 가정값)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            className="w-full rounded border border-zinc-300 px-2 py-1"
            value={params.otherCostRate}
            onChange={(e) => onParamsChange({ ...params, otherCostRate: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />
          <span className="text-zinc-500">설계·감리·부대비용 등. 기본값 0은 &quot;포함하지 않음&quot;이에요.</span>
        </label>
        <fieldset>
          <legend className="mb-0.5 text-zinc-600">연면적 기준</legend>
          {(
            [
              ["design", "설계한 건물", designFloor],
              ["max", "계산된 최대 연면적", maxFloor],
            ] as [AreaBasis, string, number | null][]
          ).map(([value, label, area]) => (
            <label key={value} className="mr-3 inline-flex items-center gap-1">
              <input
                type="radio"
                name="areaBasis"
                checked={params.areaBasis === value}
                onChange={() => onParamsChange({ ...params, areaBasis: value })}
              />
              {label} {area === null ? "(없음)" : `${fmt(area)}㎡`}
            </label>
          ))}
        </fieldset>
      </div>

      {/* 총사업비 */}
      {cost ? (
        <div className={`mt-3 rounded border p-3 text-sm ${cost.complete ? "border-violet-300 bg-violet-50" : "border-amber-300 bg-amber-50"}`}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-zinc-600">토지 가격</dt>
            <dd className="text-right">{formatWon(cost.land.total)}</dd>
            <dt className="text-zinc-600">
              예상 공사비
              <div className="text-xs text-zinc-500">
                {fmt(cost.floorArea)}㎡ × {fmt(params.unitCost)}원
              </div>
            </dt>
            <dd className="text-right">{formatWon(cost.construction)}</dd>
            <dt className="text-zinc-600">기타 비용 ({params.otherCostRate}%)</dt>
            <dd className="text-right">{formatWon(cost.other)}</dd>
            <dt className="border-t border-violet-200 pt-1 font-semibold">총사업비</dt>
            <dd className="border-t border-violet-200 pt-1 text-right font-semibold">{formatWon(cost.total)}</dd>
          </dl>
          <div className="mt-1 text-right text-xs text-zinc-500">{fmt(cost.total)}원</div>
          {!cost.complete && <p className="mt-1 text-xs text-amber-900">토지 가격 일부가 빠져 있어 총사업비도 그만큼 적게 나옵니다.</p>}
        </div>
      ) : (
        <p className="mt-3 rounded border border-zinc-200 p-2 text-xs text-zinc-600">
          {params.areaBasis === "design" && design && design.buildings.length === 0
            ? "배치한 건물이 없어 사업비를 계산하지 않았습니다. 연면적 기준을 '계산된 최대 연면적'으로 바꾸면 계산돼요."
            : "선택한 연면적 기준의 값이 아직 없어 사업비를 계산하지 않았습니다. 건물 디자인이 만들어지면 자동으로 계산돼요."}
        </p>
      )}

      <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        <div className="mb-1 font-semibold">포함하지 않은 것</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            공사비는 연면적에 단가를 곱한 값이에요. 지하층·주차장, 토목·조경, 철거, 인허가 비용, 금융비용, 세금은 따로 넣지 않았어요 (기타 비용 비율로
            대신 넣을 수 있어요).
          </li>
          <li>수익(분양·임대)과 수익률 분석은 하지 않아요.</li>
          <li>모든 금액은 검토용 참고값이며 실제 사업비·감정평가·예산 편성의 근거가 아닙니다.</li>
        </ul>
      </div>
    </section>
  );
}
