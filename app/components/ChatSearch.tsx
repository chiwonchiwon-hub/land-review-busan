"use client";

import { useEffect, useRef, useState } from "react";
import { NL_EXAMPLES, parseQuery, type NlState } from "@/lib/nl-query";

type Msg = { role: "user" | "bot"; text: string; lines?: string[]; questions?: string[] };

const WELCOME: Msg = {
  role: "bot",
  text: "찾고 싶은 땅을 말로 알려 주세요. 지역·용도·소유 구분·최소 면적을 알아듣고 바로 검색해요. 이어서 \"2천㎡ 이상으로\" 처럼 조건을 고칠 수도 있어요.",
};

export default function ChatSearch({
  state,
  busy,
  onApply,
}: {
  state: NlState;
  busy: boolean;
  onApply: (next: NlState, search: boolean) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  function send(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    const r = parseQuery(q, state);
    const reply: Msg = r.canSearch
      ? { role: "bot", text: "이렇게 이해했어요. 바로 찾아볼게요.", lines: r.understood, questions: r.questions }
      : { role: "bot", text: r.understood.length ? "일부만 알아들었어요." : "다시 말씀해 주세요.", lines: r.understood, questions: r.questions };
    setMessages((m) => [...m, { role: "user", text: q }, reply]);
    setText("");
    if (r.understood.length > 0) onApply(r.state, r.canSearch);
  }

  return (
    <section className="border-b border-zinc-200 bg-zinc-50 p-4" aria-label="말로 조건 입력">
      <h2 className="mb-2 text-base font-semibold">말로 찾기</h2>
      <div className="max-h-52 space-y-2 overflow-y-auto pr-1 text-xs" data-chat-log>
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
            <div className={`max-w-[92%] rounded-lg px-2.5 py-1.5 ${m.role === "user" ? "bg-blue-600 text-white" : "border border-zinc-200 bg-white text-zinc-800"}`}>
              <div>{m.text}</div>
              {m.lines && m.lines.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-zinc-700">
                  {m.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
              {m.questions && m.questions.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-amber-800">
                  {m.questions.map((l) => (
                    <li key={l}>? {l}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {NL_EXAMPLES.map((ex) => (
          <button key={ex} type="button" disabled={busy} onClick={() => send(ex)} className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-50">
            {ex}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="예: 해운대구 청사용 국유지 3천㎡ 이상"
          className="min-w-0 flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm"
          aria-label="찾고 싶은 땅을 말로 입력"
        />
        <button type="submit" disabled={busy || !text.trim()} className="rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          보내기
        </button>
      </form>
    </section>
  );
}
