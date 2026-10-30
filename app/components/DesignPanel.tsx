"use client";

import { useEffect, useRef, useState } from "react";
import { DESIGN_KIND_NAME, type BuildingDesign, type DesignKind, type DesignParams, type DesignSet, type XY } from "@/lib/land-types";
import { exportDesignGlb } from "./building-3d";

// data는 고른 안(다른 패널이 쓰는 값). set에는 대지 모양에 맞춰 만든 모든 안이 들어 있음
export type DesignState = { loading?: boolean; set?: DesignSet; kind?: DesignKind; data?: BuildingDesign; error?: string };

const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "-");

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? "text-emerald-700" : "font-semibold text-red-700"}>
      {ok ? "✔" : "✖"} {children}
    </li>
  );
}

// 안의 배치도(위에서 본 모양) 미리보기
function PlanThumb({ design }: { design: BuildingDesign }) {
  const site = design.site?.ring ?? [];
  const pts: XY[] = [...site, ...design.buildings.flatMap((b) => b.volumes.flatMap((v) => v.ring))];
  if (pts.length === 0) return <div className="h-16 w-20 rounded bg-zinc-100" />;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const s = 72 / Math.max(w, h);
  const P = (p: XY) => `${(4 + (p[0] - minX) * s).toFixed(1)},${(4 + (maxY - p[1]) * s).toFixed(1)}`;
  const topFloors = Math.max(1, ...design.buildings.map((b) => b.floors));
  return (
    <svg viewBox={`0 0 ${(w * s + 8).toFixed(1)} ${(h * s + 8).toFixed(1)}`} className="h-16 w-20 shrink-0 rounded bg-zinc-50" aria-hidden>
      {site.length > 0 && <polygon points={site.map(P).join(" ")} fill="#e6efdc" stroke="#9aa890" strokeWidth={0.8} />}
      {[...design.buildings.flatMap((b) => b.volumes)]
        .sort((a, b) => a.startFloor + a.floors - (b.startFloor + b.floors))
        .map((v, i) => (
          <polygon
            key={i}
            points={v.ring.map(P).join(" ")}
            fill={`hsl(212 ${40 + (28 * (v.startFloor + v.floors)) / topFloors}% ${78 - (34 * (v.startFloor + v.floors)) / topFloors}%)`}
            stroke="#1f2933"
            strokeWidth={0.6}
          />
        ))}
    </svg>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-zinc-600">
        <span>{label}</span>
        <span className="font-medium text-zinc-800">{display}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-blue-600" />
    </label>
  );
}

export default function DesignPanel({
  state,
  params,
  onParamsChange,
  onRun,
  onSelectKind,
}: {
  state: DesignState | undefined;
  params: DesignParams;
  onParamsChange: (p: DesignParams) => void;
  onRun: (p: DesignParams) => void;
  onSelectKind: (k: DesignKind) => void;
}) {
  const set = state?.set;
  const d = state?.data;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // 슬라이더를 움직이면 잠깐 뒤에 모든 안을 다시 만듦
  const first = useRef(true);
  const run = useRef(onRun);
  useEffect(() => {
    run.current = onRun;
  });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => run.current(params), 500);
    return () => clearTimeout(t);
  }, [params.floorHeight, params.setback, params.coverage, params.floors]); // eslint-disable-line react-hooks/exhaustive-deps

  async function download(design: BuildingDesign) {
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await exportDesignGlb(design);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `building-${design.option.id}.glb`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("3D 파일을 만들지 못했습니다.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section>
      <h4 className="mb-2 text-base font-semibold">3D 건물 디자인</h4>

      {set && set.metrics && (
        <p className="mb-2 rounded bg-zinc-50 p-2 text-xs text-zinc-600">
          대지 분석: 건물을 놓을 수 있는 땅 {fmt(set.metrics.area)}㎡ · 긴 변 {fmt(set.metrics.length)}m × 짧은 변 {fmt(set.metrics.width)}m (가로세로 {set.metrics.aspect}:1) · 반듯함{" "}
          {Math.round(set.metrics.convexity * 100)}%
        </p>
      )}

      {state?.loading && !set && <p className="rounded bg-sky-50 p-2 text-xs text-sky-800">대지 모양에 맞는 안을 만드는 중…</p>}
      {state?.error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{state.error}</p>}

      {set && set.options.length > 0 && set.options[0].buildings.length > 0 && (
        <div className="space-y-1.5" role="radiogroup" aria-label="건물 배치 안">
          {set.options.map((o) => {
            const on = o.option.id === state?.kind;
            return (
              <button
                key={o.option.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-design-kind={o.option.id}
                onClick={() => onSelectKind(o.option.id)}
                className={`flex w-full gap-2 rounded border p-2 text-left text-xs ${on ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600" : "border-zinc-200 hover:bg-zinc-50"}`}
              >
                <PlanThumb design={o} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-semibold">
                    {o.option.name}
                    {o.option.recommended && <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">추천</span>}
                    <span className="ml-auto text-xs font-normal text-zinc-500">{o.option.score}점</span>
                  </span>
                  <span className="mt-0.5 block text-zinc-600">
                    {o.buildings.length}동 · 최고 {o.totals.maxFloors}층 · 연면적 {fmt(o.totals.floorArea)}㎡
                  </span>
                  <span className="mt-0.5 block text-zinc-500">{o.option.why[0]}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 space-y-2 rounded border border-zinc-200 p-2 text-xs">
        <div className="font-medium text-zinc-700">직접 조절하기 (가정값)</div>
        <Slider label="건축면적 사용률" value={params.coverage} min={0.3} max={1} step={0.05} display={`${Math.round(params.coverage * 100)}%`} onChange={(v) => onParamsChange({ ...params, coverage: v })} />
        <Slider
          label="층수"
          value={params.floors ?? 0}
          min={0}
          max={40}
          step={1}
          display={params.floors ? `${params.floors}층` : "자동 (연면적 한도까지)"}
          onChange={(v) => onParamsChange({ ...params, floors: v >= 1 ? v : null })}
        />
        <Slider label="층고" value={params.floorHeight} min={2.5} max={6} step={0.1} display={`${params.floorHeight.toFixed(1)}m`} onChange={(v) => onParamsChange({ ...params, floorHeight: v })} />
        <Slider label="대지경계 이격" value={params.setback} min={0} max={10} step={0.5} display={`${params.setback}m`} onChange={(v) => onParamsChange({ ...params, setback: v })} />
        {state?.loading && set && <div className="text-sky-700">다시 계산하는 중…</div>}
        {!state?.loading && d && params.floors && d.totals.maxFloors > 0 && d.totals.maxFloors < params.floors && (
          <div className="rounded bg-amber-50 p-1.5 text-amber-800">
            {params.floors}층은 한도를 넘어 최대 {d.totals.maxFloors}층으로 줄였어요 (연면적·용도 상한 또는 건물 폭 대비 높이 제한).
          </div>
        )}
      </div>

      {d && (
        <div className="mt-3 space-y-3 text-xs">
          {d.buildings.length === 0 ? (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">배치할 수 있는 건물이 없습니다.</p>
          ) : (
            <div className="rounded border border-sky-300 bg-sky-50 p-3 text-sm">
              <div className="font-semibold">
                {DESIGN_KIND_NAME[d.option.id]} · 건물 {d.buildings.length}동 · 최고 {d.totals.maxFloors}층 ({fmt(d.totals.maxHeight)}m)
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-700">
                {d.option.why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <dt className="text-zinc-600">건축면적</dt>
                <dd className="text-right">
                  {fmt(d.totals.footprintArea)}㎡{d.limits && <span className="text-zinc-500"> / {fmt(d.limits.maxBuildingArea)}㎡ ({pct(d.totals.footprintArea, d.limits.maxBuildingArea)})</span>}
                </dd>
                <dt className="text-zinc-600">연면적</dt>
                <dd className="text-right">
                  {fmt(d.totals.floorArea)}㎡{d.limits && <span className="text-zinc-500"> / {fmt(d.limits.maxFloorArea)}㎡ ({pct(d.totals.floorArea, d.limits.maxFloorArea)})</span>}
                </dd>
              </dl>
            </div>
          )}

          <ul className="space-y-0.5">
            <Check ok={d.verified.insideSite}>모든 건물이 대지 경계 안에 있음</Check>
            <Check ok={d.verified.withinBuildingLimit}>건축면적이 계산된 최대값 이내</Check>
            <Check ok={d.verified.withinFloorLimit}>연면적이 계산된 최대값 이내</Check>
            {d.use.caps.some((c) => c.floorAreaLt !== undefined || c.maxFloors !== undefined) && (
              <Check ok={d.verified.withinUseLimit}>
                {d.purpose} 용도 규정의 상한 이내
                {d.use.caps
                  .map((c) => [c.floorAreaLt !== undefined ? `연면적 ${c.floorAreaLt.toLocaleString("ko-KR")}㎡ 미만` : "", c.maxFloors !== undefined ? `${c.maxFloors}층 이하` : ""].filter(Boolean).join(", "))
                  .filter(Boolean)
                  .map((t) => ` (${t})`)
                  .join("")}
              </Check>
            )}
          </ul>

          {d.buildings.map((b, i) => (
            <div key={`${b.zone}-${i}`} className="rounded border border-zinc-200 p-2">
              <div className="font-semibold">
                건물 {i + 1}
                {b.zone && <span className="font-normal text-zinc-500"> · {b.zone} 부분</span>}
              </div>
              {b.volumes.length > 6 ? (
                <p className="mt-1 text-zinc-700">
                  동 {b.volumes.length}개 × {b.volumes[0].floors}층 (동당 바닥 약 {fmt(b.volumes[0].area)}㎡)
                </p>
              ) : (
              <ul className="mt-1 space-y-0.5 text-zinc-700">
                {b.volumes.map((v, vi) => (
                  <li key={vi}>
                    {{ main: "본체", base: "저층부", tower: "타워", wing: "날개", tier: "층" }[v.role]} {v.floors}층 (바닥 {fmt(v.area)}㎡)
                  </li>
                ))}
              </ul>
              )}
              {b.complexPlan && (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded bg-zinc-50 p-2" data-complex-plan>
                  <dt className="text-zinc-600">추정 세대수 (가정)</dt>
                  <dd className="text-right">{fmt(b.complexPlan.households)}세대</dd>
                  <dt className="text-zinc-600">법정 주차대수</dt>
                  <dd className="text-right">{fmt(b.complexPlan.parkingSpaces)}대</dd>
                  <dt className="text-zinc-600">지하주차장</dt>
                  <dd className="text-right">
                    {fmt(b.complexPlan.undergroundParkingArea)}㎡ · 지하 {b.complexPlan.undergroundFloors}층
                  </dd>
                  <dt className="text-zinc-600">주민공동시설</dt>
                  <dd className="text-right">{b.complexPlan.communityFacilityArea > 0 ? `${fmt(b.complexPlan.communityFacilityArea)}㎡ 이상` : "의무 없음"}</dd>
                  <dt className="text-zinc-600">조경</dt>
                  <dd className="text-right">{b.complexPlan.landscapeRequired > 0 ? `${fmt(b.complexPlan.landscapeRequired)}㎡ 이상` : "의무 없음"}</dd>
                  <dt className="text-zinc-600">진입도로 기준 폭</dt>
                  <dd className="text-right">{b.complexPlan.entryRoadWidth}m 이상</dd>
                  <dt className="text-zinc-600">외부 공간</dt>
                  <dd className={`text-right ${b.complexPlan.openSpaceEnough ? "" : "text-amber-700"}`}>
                    {fmt(b.complexPlan.openSpace)}㎡ {b.complexPlan.openSpaceEnough ? "(충분)" : "(부족할 수 있음)"}
                  </dd>
                </dl>
              )}
              <div className="mt-1 text-zinc-600">
                건축면적 {fmt(b.footprintArea)}㎡ · 연면적 {fmt(b.floorArea)}㎡ · 높이 {fmt(b.height)}m
              </div>
              {b.notes.map((n) => (
                <div key={n} className="mt-1 text-amber-700">
                  ※ {n}
                </div>
              ))}
            </div>
          ))}

          {d.buildings.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => download(d)}
                disabled={downloading}
                className="w-full rounded bg-zinc-800 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {downloading ? "파일 만드는 중…" : "3D 파일(GLB) 내려받기"}
              </button>
              <p className="mt-1 text-zinc-500">Blender, SketchUp, Rhino 같은 전문 프로그램에서 열 수 있습니다 (단위 m).</p>
              {downloadError && <p className="mt-1 text-red-700">{downloadError}</p>}
            </div>
          )}

          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
            <div className="mb-1 font-semibold">가정과 반영하지 않은 것</div>
            <ul className="list-disc space-y-1 pl-4">
              {d.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
