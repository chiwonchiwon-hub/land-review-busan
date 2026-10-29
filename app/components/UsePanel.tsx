"use client";

import { USE_RULE_SOURCES, USE_STATUS_LABEL, type UseAssessment, type UseStatus } from "@/lib/use-rules";

export const STATUS_STYLE: Record<UseStatus, string> = {
  allowed: "border-emerald-300 bg-emerald-50 text-emerald-900",
  conditional: "border-amber-300 bg-amber-50 text-amber-900",
  not_allowed: "border-red-300 bg-red-50 text-red-900",
  unknown: "border-zinc-300 bg-zinc-50 text-zinc-800",
};

const fmt = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const pct = (share: number) => `${(share * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;

export default function UsePanel({ assessment: a }: { assessment: UseAssessment }) {
  return (
    <section>
      <h4 className="mb-2 text-base font-semibold">용도 적합 여부 ({a.purpose})</h4>

      <div className={`rounded border p-3 ${STATUS_STYLE[a.overall]}`} data-use-status={a.overall}>
        <div className="font-semibold">{a.supported ? USE_STATUS_LABEL[a.overall] : "판정하지 않음"}</div>
        <p className="mt-0.5 text-sm">{a.headline}</p>
        {a.conditions.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">
            {a.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>

      {a.supported && a.parts.length > 1 && (
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-0.5 font-medium">용도지역</th>
              <th className="text-right font-medium">면적(㎡)</th>
              <th className="pl-2 font-medium">판정</th>
              <th className="font-medium">반영</th>
            </tr>
          </thead>
          <tbody>
            {a.parts.map((p) => (
              <tr key={p.zone} className="border-t border-zinc-100">
                <td className="py-0.5">{p.zone}</td>
                <td className="text-right">
                  {fmt(p.area)} ({pct(p.share)})
                </td>
                <td className="pl-2">{USE_STATUS_LABEL[p.status]}</td>
                <td>{p.applies ? "○" : "참고"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {a.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-zinc-700">
          {a.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {a.supported && (
        <details className="mt-2 text-xs text-zinc-600">
          <summary className="cursor-pointer font-medium">근거 원문 (법령·조례)</summary>
          <div className="mt-1 space-y-2">
            {a.parts
              .filter((p) => p.applies)
              .map((p) => (
                <div key={p.zone}>
                  <div className="font-semibold text-zinc-800">{p.zone}</div>
                  <ul className="mt-0.5 space-y-1">
                    {p.rule.basis.map((b) => (
                      <li key={b.ref}>
                        <span className="font-medium">{b.ref}</span>
                        <div className="text-zinc-500">{b.text}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            <p className="text-zinc-500">
              {USE_RULE_SOURCES.checkedOn}에 국가법령정보센터에서 직접 읽은 원문입니다.{" "}
              <a href={USE_RULE_SOURCES.url} target="_blank" rel="noopener noreferrer" className="underline">
                법령 보기
              </a>
            </p>
          </div>
        </details>
      )}

      <p className="mt-2 text-xs text-zinc-500">
        법령 표를 읽어 정리한 참고 판정이에요. 실제 건축허가는 지구단위계획, 정비구역, 경관·고도지구, 건축물의 세부 용도 등 다른 규정까지 따져야 해요.
        부산의 도시지역 용도지역 16종과 자연환경보전지역만 반영했고, 관리·농림지역과 개발제한구역은 판정하지 않아요.
      </p>
    </section>
  );
}
