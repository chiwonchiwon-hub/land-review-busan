"use client";

import { useRef, useState } from "react";
import ParcelMap, { groupColor, type MapView } from "./ParcelMap";
import ReviewPanel, { type ReviewState } from "./ReviewPanel";
import DesignPanel, { type DesignState } from "./DesignPanel";
import CostPanel from "./CostPanel";
import ReportSummary from "./ReportSummary";
import ChatSearch from "./ChatSearch";
import type { NlState } from "@/lib/nl-query";
import { BUSAN_GUS } from "@/lib/regions";
import { STATUS_STYLE } from "./UsePanel";
import { USE_STATUS_LABEL } from "@/lib/use-rules";
import { DEFAULT_COST_PARAMS, type CostParams } from "@/lib/project-cost";
import {
  ALL_JIMOK,
  DEFAULT_COVERAGE,
  DEFAULT_EXCLUDED_JIMOK,
  DEFAULT_FLOOR_HEIGHT,
  DEFAULT_SETBACK,
  OWNER_TYPES,
  PURPOSES,
  type DesignParams,
  type DesignSet,
  type LandGroup,
  type LandReview,
  type SearchCriteria,
  type SearchResult,
} from "@/lib/land-types";

const ownerLabel = (v: string) => OWNER_TYPES.find((o) => o.value === v)?.label.split(" ")[0] ?? v;
const shortAddr = (addr: string) => addr.replace("부산광역시 ", "");
const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });

function toggle(list: string[], value: string) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function LandFinder() {
  const [criteria, setCriteria] = useState<SearchCriteria>({
    purpose: "청사",
    dongs: [], // 아래 구·군 선택에서 정해짐 (검색할 때 서버로 gus를 보냄)
    ownerTypes: OWNER_TYPES.map((o) => o.value),
    minArea: 1000,
    excludedJimok: DEFAULT_EXCLUDED_JIMOK,
  });
  // 검토할 구·군 (기본은 수영구. 부산 전체를 고를 수도 있음)
  const [gus, setGus] = useState<string[]>(["26500"]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJimok, setShowJimok] = useState(false);
  const [showForm, setShowForm] = useState(false); // 상세 조건 펼치기
  // 토지(묶음)별 규제 검토 결과. 한 번 받은 것은 다시 받지 않습니다.
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});
  // 3D 건물 디자인 결과와 사용자가 고칠 수 있는 가정값
  const [designs, setDesigns] = useState<Record<string, DesignState>>({});
  const [designParams, setDesignParams] = useState<DesignParams>({
    floorHeight: DEFAULT_FLOOR_HEIGHT["청사"],
    setback: DEFAULT_SETBACK,
    coverage: DEFAULT_COVERAGE,
    floors: null,
  });
  const [mapView, setMapView] = useState<MapView>("2d");
  // 토지 가격·사업비 계산의 가정값 (바꾸면 바로 다시 계산)
  const [costParams, setCostParams] = useState<CostParams>(DEFAULT_COST_PARAMS);
  // 리포트 넓게 보기: 검색 패널을 접고 오른쪽 리포트를 넓힘
  const [wide, setWide] = useState(false);

  // 슬라이더를 빠르게 움직이면 요청이 겹치므로, 가장 마지막 요청의 결과만 받아들임
  const designSeq = useRef(0);

  async function loadDesign(group: LandGroup, params: DesignParams) {
    const seq = ++designSeq.current;
    // 다시 만드는 동안에도 이전 건물은 지도에 남겨 둠
    setDesigns((d) => ({ ...d, [group.id]: { ...d[group.id], loading: true, error: undefined } }));
    try {
      const res = await fetch("/api/land-design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 검색할 때 고른 용도로 설계 (검색 뒤에 용도 선택을 바꿔도 이 결과의 용도는 그대로)
        body: JSON.stringify({ pnus: group.parcels.map((p) => p.pnu), purpose: result?.purpose ?? criteria.purpose, ...params }),
      });
      const data = await res.json();
      if (seq !== designSeq.current) return; // 그 사이 더 새로운 요청이 나갔음
      if (res.ok) {
        const set = data.set as DesignSet;
        setDesigns((d) => {
          // 다시 계산해도 사용자가 고른 안은 유지 (없으면 추천 안)
          const kind = set.options.find((o) => o.option.id === d[group.id]?.kind)?.option.id ?? set.recommendedId ?? set.options[0]?.option.id;
          return { ...d, [group.id]: { set, kind, data: set.options.find((o) => o.option.id === kind) } };
        });
        setMapView("3d");
      } else {
        setDesigns((d) => ({ ...d, [group.id]: { ...d[group.id], loading: false, error: data.error ?? "건물을 배치하지 못했습니다 (확인 불가)." } }));
      }
    } catch {
      setDesigns((d) => ({ ...d, [group.id]: { ...d[group.id], loading: false, error: "서버에 연결하지 못했습니다 (확인 불가)." } }));
    }
  }

  async function loadReview(group: LandGroup) {
    setReviews((r) => ({ ...r, [group.id]: { loading: true } }));
    try {
      const res = await fetch("/api/land-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pnus: group.parcels.map((p) => p.pnu) }),
      });
      const data = await res.json();
      setReviews((r) => ({
        ...r,
        [group.id]: res.ok ? { data: data as LandReview } : { error: data.error ?? "검토하지 못했습니다 (확인 불가)." },
      }));
      if (res.ok) void loadDesign(group, designParams); // 규제 검토가 끝나면 건물도 바로 배치
    } catch {
      setReviews((r) => ({ ...r, [group.id]: { error: "서버에 연결하지 못했습니다 (확인 불가)." } }));
    }
  }

  function selectGroup(id: string) {
    setSelectedId(id);
    const group = result?.groups.find((g) => g.id === id);
    const existing = reviews[id];
    if (group && (!existing || (existing.error && !existing.loading))) void loadReview(group);
  }

  async function search(override?: NlState) {
    const useCriteria = override?.criteria ?? criteria;
    const useGus = override?.gus ?? gus;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    setReviews({});
    setDesigns({});
    try {
      const res = await fetch("/api/land-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...useCriteria, gus: useGus }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "검색하지 못했습니다 (확인 불가).");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch {
      setError("서버에 연결하지 못했습니다 (확인 불가).");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const selected = result?.groups.find((g) => g.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`w-96 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm text-zinc-800 ${
          wide && selected ? "hidden" : "flex"
        }`}
      >
        <ChatSearch
          state={{ criteria, gus }}
          busy={loading}
          onApply={(next, run) => {
            setCriteria(next.criteria);
            setGus(next.gus);
            setDesignParams((p) => ({ ...p, floorHeight: DEFAULT_FLOOR_HEIGHT[next.criteria.purpose] }));
            if (run) void search(next);
          }}
        />

        {/* 현재 조건 요약 + 직접 바꾸기 */}
        <section className="border-b border-zinc-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">검색 조건</h2>
            <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
              {showForm ? "접기 ▲" : "직접 바꾸기 ▼"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs" data-criteria-chips>
            {[
              criteria.dongs.length > 0 ? `${criteria.dongs.length}개 동` : gus.length === BUSAN_GUS.length ? "부산 전체" : gus.length === 0 ? "지역 미선택" : gus.length <= 3 ? gus.map((c) => BUSAN_GUS.find((g) => g.code === c)?.name).join("·") : `${gus.length}개 구·군`,
              criteria.purpose,
              criteria.ownerTypes.length === OWNER_TYPES.length ? "국·공유지" : criteria.ownerTypes.map(ownerLabel).join("·") || "소유 미선택",
              `${fmt(criteria.minArea)}㎡ 이상`,
            ].map((c) => (
              <span key={c} className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700">
                {c}
              </span>
            ))}
          </div>

          {showForm && (
            <div className="mt-3 space-y-3 rounded-lg bg-zinc-50 p-3">
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-zinc-600">용도</legend>
                <div className="grid grid-cols-3 gap-1">
                  {PURPOSES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={criteria.purpose === p}
                      onClick={() => {
                        setCriteria({ ...criteria, purpose: p });
                        setDesignParams((d) => ({ ...d, floorHeight: DEFAULT_FLOOR_HEIGHT[p] })); // 용도별 기본 층고
                      }}
                      className={`rounded border py-1 text-xs font-medium ${criteria.purpose === p ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-300 bg-white hover:bg-zinc-100"}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">청사·공공주택은 법령상 지을 수 없는 용도지역의 땅을 추천에서 빼요.</p>
              </fieldset>

              <fieldset>
                <legend className="mb-1 flex w-full items-center justify-between text-xs font-medium text-zinc-600">
                  <span>
                    지역 ({gus.length}/{BUSAN_GUS.length})
                  </span>
                  <span className="space-x-2 font-normal text-blue-700">
                    <button type="button" className="hover:underline" onClick={() => setGus(BUSAN_GUS.map((g) => g.code))}>
                      전체
                    </button>
                    <button type="button" className="hover:underline" onClick={() => setGus(["26500"])}>
                      수영구만
                    </button>
                    <button type="button" className="hover:underline" onClick={() => setGus([])}>
                      해제
                    </button>
                  </span>
                </legend>
                <div className="grid grid-cols-4 gap-x-1 gap-y-1 text-xs">
                  {BUSAN_GUS.map((g) => (
                    <label key={g.code} className="flex items-center gap-1">
                      <input type="checkbox" checked={gus.includes(g.code)} onChange={() => setGus(toggle(gus, g.code))} />
                      {g.name}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 text-xs font-medium text-zinc-600">소유 구분</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {OWNER_TYPES.map((o) => (
                    <label key={o.value} className="flex items-center gap-1">
                      <input type="checkbox" checked={criteria.ownerTypes.includes(o.value)} onChange={() => setCriteria({ ...criteria, ownerTypes: toggle(criteria.ownerTypes, o.value) })} />
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: groupColor({ ownerTypes: [o.value] }) }} />
                      {o.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-600">최소 면적 (㎡)</span>
                <input type="number" min={0} step={100} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm" value={criteria.minArea} onChange={(e) => setCriteria({ ...criteria, minArea: Number(e.target.value) })} />
                <span className="mt-0.5 block text-[11px] text-zinc-500">일단의 토지는 묶인 필지의 합계 면적으로 판단해요.</span>
              </label>

              <div>
                <button type="button" className="text-xs font-medium text-blue-700 hover:underline" onClick={() => setShowJimok(!showJimok)}>
                  제외할 지목 ({criteria.excludedJimok.length}개) {showJimok ? "▲" : "▼"}
                </button>
                {showJimok && (
                  <div className="mt-2 grid grid-cols-4 gap-1">
                    {ALL_JIMOK.map((j) => (
                      <label key={j} className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={criteria.excludedJimok.includes(j)} onChange={() => setCriteria({ ...criteria, excludedJimok: toggle(criteria.excludedJimok, j) })} />
                        {j}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <button type="button" onClick={() => void search()} disabled={loading} className="mt-3 w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-zinc-400">
            {loading ? "찾는 중…" : "국·공유지 찾기"}
          </button>
          {loading && <p className="mt-1 text-center text-[11px] text-zinc-500">처음 한 번은 자료를 불러오느라 조금 걸려요</p>}
          {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        </section>

        {/* 결과 */}
        {result && (
          <section className="px-4 py-3">
            <h2 className="text-sm font-semibold">추천 결과 {result.groups.length}곳</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              후보 {result.candidateCount.toLocaleString("ko-KR")}곳
              {result.usableCount !== null && ` → ${result.purpose} 가능 약 ${result.usableCount.toLocaleString("ko-KR")}곳`}
              {(result.usableCount !== null || result.candidateCount > result.groups.length) && ` · 면적 큰 순 ${result.groups.length}곳 표시`}
            </p>
            <details className="mt-1 text-[11px] text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-700">집계 자세히</summary>
              <p className="mt-1">
                국·공유 필지 {result.stats.publicParcels.toLocaleString("ko-KR")}개 중 지목 제외 {result.stats.excludedByJimok.toLocaleString("ko-KR")}개, 면적 미달{" "}
                {result.stats.belowMinArea.toLocaleString("ko-KR")}곳
                {result.usableCount !== null && `, 법령상 불가 ${result.stats.excludedByUse.toLocaleString("ko-KR")}곳, 판정 범위 밖 ${result.stats.unsupportedZone.toLocaleString("ko-KR")}곳, 건축 불가 지역·지구(도로·공원·학교 시설 부지, 개발제한구역 등) ${(result.stats.excludedByNoBuild ?? 0).toLocaleString("ko-KR")}곳`}
                {result.stats.missingGeometry > 0 && `, 경계 확인 불가 ${result.stats.missingGeometry}개`} · VWorld 기준일 {result.dataDate}
              </p>
            </details>

            <ol className="mt-3 space-y-2">
              {result.groups.map((g, i) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => selectGroup(g.id)}
                    className={`w-full rounded-lg border p-2.5 text-left ${g.id === selectedId ? "border-blue-600 bg-blue-50" : "border-zinc-200 hover:bg-zinc-50"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: groupColor(g) }} />
                      <span className="text-sm font-semibold">
                        {i + 1}. {fmt(g.totalArea)}㎡
                      </span>
                      <span className="text-xs text-zinc-500">{g.parcels.length > 1 ? `일단의 토지 ${g.parcels.length}필지` : "단독 필지"}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-600">
                      {shortAddr(g.parcels[0].addr)}
                      {g.parcels.length > 1 && ` 외 ${g.parcels.length - 1}필지`} · {g.ownerTypes.map(ownerLabel).join("·")}
                    </div>
                    {g.use && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-medium ${STATUS_STYLE[g.use.status]}`}>
                          {result.purpose} {USE_STATUS_LABEL[g.use.status]}
                        </span>
                        <span className="truncate text-zinc-500">{g.use.zones}</span>
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ol>
            {result.groups.length === 0 && <p className="mt-3 text-xs text-zinc-500">조건에 맞는 토지가 없어요.</p>}

            {result.partial.length > 0 && (
              <details className="mt-4 text-xs text-zinc-600">
                <summary className="cursor-pointer font-medium">일부만 국·공유인 필지 {result.partial.length}개 (공동 소유라 추천 제외)</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.partial.map((p) => (
                    <li key={p.pnu}>
                      {shortAddr(p.addr)} · {p.jimok} · {fmt(p.area)}㎡ · {p.ownerTypes.map(ownerLabel).join("·")} 일부
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </aside>

      <div className="relative flex flex-1 flex-col">
        <ParcelMap
          groups={result?.groups ?? []}
          selectedId={selectedId}
          onSelectGroup={selectGroup}
          design={selected ? (designs[selected.id]?.data ?? null) : null}
          view={mapView}
          onViewChange={setMapView}
        />
      </div>

      {/* 선택한 토지 상세 + 규제 검토 + 3D 건물 디자인 */}
      {selected && (
        <ReviewPanel
          purpose={result?.purpose ?? criteria.purpose}
          group={selected}
          state={reviews[selected.id]}
          onRetry={() => void loadReview(selected)}
          onClose={() => setSelectedId(null)}
          wide={wide}
          summary={
            <ReportSummary
              purpose={result?.purpose ?? criteria.purpose}
              group={selected}
              review={reviews[selected.id]}
              design={designs[selected.id]}
              costParams={costParams}
              wide={wide}
              onToggleWide={() => setWide((w) => !w)}
            />
          }
        >
          <DesignPanel
            state={designs[selected.id]}
            params={designParams}
            onParamsChange={setDesignParams}
            onRun={(p) => void loadDesign(selected, p)}
            onSelectKind={(kind) =>
              setDesigns((d) => {
                const cur = d[selected.id];
                return cur?.set ? { ...d, [selected.id]: { ...cur, kind, data: cur.set.options.find((o) => o.option.id === kind) } } : d;
              })
            }
          />
          <CostPanel
            group={selected}
            review={reviews[selected.id]?.data}
            design={designs[selected.id]?.data}
            params={costParams}
            onParamsChange={setCostParams}
          />
        </ReviewPanel>
      )}
    </div>
  );
}
