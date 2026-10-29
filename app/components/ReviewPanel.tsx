"use client";

import type { LandGroup, LandReview } from "@/lib/land-types";
import { assessUse } from "@/lib/use-rules";
import UsePanel from "./UsePanel";

export type ReviewState = { loading?: boolean; data?: LandReview; error?: string };

const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const pct = (share: number) => `${(share * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
const ownerLabel = (v: string) => (v === "시 도유지" ? "시유지" : v === "군유지" ? "구유지" : v);
const shortAddr = (addr: string) => addr.replace("부산광역시 ", "");

export default function ReviewPanel({
  group,
  state,
  onRetry,
  onClose,
  summary,
  wide,
  purpose,
  children,
}: {
  purpose: string; // 이 결과를 찾을 때 고른 용도
  group: LandGroup;
  state: ReviewState | undefined;
  onRetry: () => void;
  onClose: () => void;
  summary?: React.ReactNode; // 맨 위에 보여 줄 검토 요약
  wide?: boolean; // 리포트를 넓게 볼 때
  children?: React.ReactNode; // 이 아래에 이어서 보여 줄 패널들 (3D 건물 디자인, 사업비)
}) {
  const r = state?.data;

  return (
    <aside
      className={`flex shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white text-sm text-zinc-800 ${
        wide ? "w-[44rem] max-w-[70vw]" : "w-[26rem]"
      }`}
    >
      <div className="flex items-start justify-between border-b border-zinc-200 p-4">
        <h3 className="font-semibold">
          {group.parcels.length > 1 ? `일단의 토지 (${group.parcels.length}필지)` : "단독 필지"} · {fmt(group.totalArea)}㎡
        </h3>
        <button type="button" className="text-zinc-400" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      <div className="space-y-5 p-4">
        {summary}

        {/* 필지 표 */}
        <table className="w-full text-xs">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-1 font-medium">주소</th>
              <th className="font-medium">지목</th>
              <th className="text-right font-medium">면적(㎡)</th>
              <th className="pl-2 font-medium">소유</th>
              <th className="text-right font-medium">공시지가(원/㎡)</th>
            </tr>
          </thead>
          <tbody>
            {group.parcels.map((p) => (
              <tr key={p.pnu} className="border-t border-zinc-100">
                <td className="py-1">{shortAddr(p.addr)}</td>
                <td>{p.jimok}</td>
                <td className="text-right">{fmt(p.area)}</td>
                <td className="pl-2">{p.ownerTypes.map(ownerLabel).join("·")}</td>
                <td className="text-right">
                  {p.price === null ? "확인 불가" : fmt(p.price)} <span className="text-zinc-400">({p.priceDate})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 규제·건폐율·용적률 검토 */}
        <section>
          <h4 className="mb-2 text-base font-semibold">규제·건폐율·용적률 검토</h4>

          {state?.loading && <p className="text-zinc-500">용도지역과 조례를 확인하는 중… (처음엔 수십 초 걸릴 수 있어요)</p>}
          {state?.error && (
            <div className="rounded bg-red-50 p-2 text-red-700">
              {state.error}{" "}
              <button type="button" className="underline" onClick={onRetry}>
                다시 시도
              </button>
            </div>
          )}

          {r && (
            <div className="space-y-4">
              {/* 결과 요약 */}
              {r.totals ? (
                <div className={`rounded border p-3 ${r.complete ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
                  <div className="text-xs font-medium">
                    {r.complete ? "조례 기준 계산 완료" : "일부는 확인이 필요해 계산에서 뺐습니다"}
                  </div>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <dt className="text-zinc-600">대지면적</dt>
                    <dd className="text-right font-medium">{fmt(r.siteArea)}㎡</dd>
                    <dt className="text-zinc-600">최대 건축면적</dt>
                    <dd className="text-right font-semibold">{fmt(r.totals.maxBuildingArea)}㎡</dd>
                    <dt className="text-zinc-600">최대 연면적</dt>
                    <dd className="text-right font-semibold">{fmt(r.totals.maxFloorArea)}㎡</dd>
                    <dt className="text-zinc-600">적용 건폐율 · 용적률</dt>
                    <dd className="text-right">
                      {r.multiZone?.rule === "separate"
                        ? `부분별 적용 (평균 ${fmt(r.totals.bcr)}% · ${fmt(r.totals.far)}%, 참고)`
                        : `${fmt(r.totals.bcr)}% · ${fmt(r.totals.far)}%`}
                    </dd>
                  </dl>
                </div>
              ) : (
                <p className="rounded border border-amber-300 bg-amber-50 p-3">용도지역을 확인하지 못해 계산하지 않았습니다 (확인 필요).</p>
              )}

              {/* 용도지역별 계산 근거 */}
              {r.parts.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-zinc-500">용도지역별 계산 (근거)</div>
                  <ul className="space-y-2">
                    {r.parts.map((p) => (
                      <li key={p.zone} className="rounded border border-zinc-200 p-2 text-xs">
                        <div className="flex justify-between font-semibold">
                          <span>{p.zone}</span>
                          <span>
                            {fmt(p.area)}㎡ ({pct(p.share)})
                          </span>
                        </div>
                        <div className="mt-1 text-zinc-700">
                          건축면적 {fmt(p.area)}㎡ × {p.bcr}% = <b>{fmt(p.maxBuildingArea)}㎡</b>
                        </div>
                        <div className="text-zinc-500">{p.bcrBasis}</div>
                        <div className="mt-1 text-zinc-700">
                          연면적 {fmt(p.area)}㎡ × {p.far}% = <b>{fmt(p.maxFloorArea)}㎡</b>
                        </div>
                        <div className="text-zinc-500">{p.farBasis}</div>
                        {p.notes.map((n) => (
                          <div key={n} className="mt-1 text-amber-700">
                            ※ {n}
                          </div>
                        ))}
                        {p.designatedYear && <div className="mt-1 text-zinc-400">용도지역도 지정 연도 {p.designatedYear}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.multiZone && <p className="rounded bg-zinc-100 p-2 text-xs">{r.multiZone.text}</p>}

              {r.excluded.reasons.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-800">
                  {r.excluded.reasons.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}

              {/* 용도 적합 여부: 고른 용도(청사·공공주택)를 이 용도지역에 지을 수 있는가 */}
              <UsePanel assessment={assessUse(purpose, r)} />

              {/* 확인 필요 */}
              {r.checks.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">
                  <div className="mb-1 font-semibold text-amber-900">확인 필요</div>
                  <ul className="list-disc space-y-1 pl-4 text-amber-900">
                    {r.checks.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}

              {r.noBuild.blocking.length > 0 && (
                <div className="rounded border border-red-300 bg-red-50 p-2 text-xs" data-no-build>
                  <div className="mb-1 font-semibold text-red-900">건축할 수 없는 지역·지구에 포함된 필지가 있어요</div>
                  <ul className="list-disc space-y-1 pl-4 text-red-900">
                    {r.noBuild.blocking.map((h) => (
                      <li key={h.name}>
                        <span className="font-medium">{h.name}</span> — {h.reason}
                        {h.parcels !== undefined && h.areaShare !== undefined && (
                          <span className="text-red-700"> (필지 {h.parcels}개, 대지 면적의 약 {Math.round(h.areaShare * 100)}%)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.noBuild.caution.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">
                  <div className="mb-1 font-semibold text-amber-900">건축 전에 허가·협의가 필요한 지역·지구</div>
                  <ul className="list-disc space-y-1 pl-4 text-amber-900">
                    {r.noBuild.caution.map((h) => (
                      <li key={h.name + h.relation}>
                        <span className="font-medium">{h.name}</span> <span className="text-amber-700">({h.relation})</span> — {h.reason}
                        {h.parcels !== undefined && h.areaShare !== undefined && <span className="text-amber-700"> (필지 {h.parcels}개, 약 {Math.round(h.areaShare * 100)}%)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.landUse.length > 0 && (
                <details className="text-xs text-zinc-600">
                  <summary className="cursor-pointer font-medium">그 외 지역·지구 ({r.landUse.length}건, VWorld 토지이용계획)</summary>
                  <ul className="mt-1 space-y-0.5">
                    {r.landUse.map((l) => (
                      <li key={`${l.name}-${l.relation}`}>
                        {l.name} <span className="text-zinc-400">({l.relation})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <details className="text-xs text-zinc-600">
                <summary className="cursor-pointer font-medium">완화 규정 (조건을 만족해야 적용, 계산에 반영 안 함)</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {r.relaxations.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </details>

              <p className="text-xs text-zinc-500">
                기준: {r.basis.ordinance} (시행 {r.basis.effective}, 원문 대조 {r.basis.checkedOn}){" "}
                <a href={r.basis.url} target="_blank" rel="noopener noreferrer" className="underline">
                  원문
                </a>
                . 용도지역은 {r.basis.zoningSource} ({r.basis.zoningDate} 수신) 기준입니다. 참고용 계산이며 건축허가 등 공식 판단이
                아닙니다.
              </p>
            </div>
          )}
        </section>

        {r && children}
      </div>
    </aside>
  );
}
