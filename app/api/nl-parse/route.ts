// 규칙 해석기가 못 알아들은 문장만 OpenAI로 풀어 조건 후보(JSON)를 돌려줍니다.
// 키(OPENAI_API_KEY)는 서버에서만 쓰고, 결과는 화면에서 다시 허용된 값으로만 걸러 씁니다.

import { BUSAN_GUS } from "@/lib/regions";
import { ALL_JIMOK } from "@/lib/land-types";

export const maxDuration = 30;

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_TEXT = 200;
const LIMIT_PER_HOUR = 20; // 한 접속자(IP)가 한 시간에 부를 수 있는 횟수 (비용 보호)
const hits = new Map<string, number[]>();

const SYSTEM = `너는 부산 국·공유지 검색 조건을 뽑는 도우미야. 사용자의 한국어 문장에서 아래 JSON만 출력해. 문장에 없는 값은 null로 둬. 추측하지 마.
{
 "whole_busan": boolean|null,
 "gus": string[]|null,
 "dongs": [{"gu": string|null, "name": string}]|null,
 "purpose": "청사"|"공공주택"|"기타"|null,
 "owners": ("국유지"|"시유지"|"구군유지")[]|null,
 "min_area_m2": number|null,
 "include_jimok": string[]|null,
 "exclude_jimok": string[]|null,
 "limit": number|null,
 "clarify": string|null
}
whole_busan은 부산 전체를 뜻할 때, gus는 구·군 이름, dongs는 읍·면·동 이름(예: 좌동), min_area_m2는 최소 면적(㎡, 평이면 ㎡로 환산), include_jimok은 포함하라고 한 지목, exclude_jimok은 제외하라고 한 지목, limit은 보여 줄 개수, clarify는 알아듣기 어려울 때 사용자에게 되물을 한 문장이야.
면적 환산: 1평 = 3.3058㎡. '천'은 1000, '만'은 10000이야. 예) 500평 = 1653, 천 평 = 3306, 2천㎡ = 2000, 3만㎡ = 30000. 숫자를 계산하고 반올림해서 정수로 줘.
'X 말고', 'X 빼고', 'X 제외'는 exclude_jimok, 'X도 포함', 'X도 같이'는 include_jimok이야. 한 문장에서 X는 한쪽에만 넣어.
구·군은 ${BUSAN_GUS.map((g) => g.name).join(", ")} 중에서만. 지목은 ${ALL_JIMOK.join(", ")} 중에서만.`;

export async function POST(request: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: "AI 해석이 설정되지 않았어요." }, { status: 501 });

  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) return Response.json({ error: "문장이 비어 있어요." }, { status: 400 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= LIMIT_PER_HOUR) return Response.json({ error: "AI 해석을 너무 자주 불렀어요. 잠시 뒤에 다시 해 주세요." }, { status: 429 });
  hits.set(ip, [...recent, now]);
  if (hits.size > 2000) hits.clear();

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      console.error("nl-parse OpenAI 오류:", res.status);
      return Response.json({ error: "AI 해석을 불러오지 못했어요." }, { status: 502 });
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const ai = JSON.parse(typeof content === "string" ? content : "{}");
    return Response.json({ ai });
  } catch (e) {
    console.error("nl-parse 실패:", e instanceof Error ? e.message : e);
    return Response.json({ error: "AI 해석에 실패했어요." }, { status: 502 });
  }
}
