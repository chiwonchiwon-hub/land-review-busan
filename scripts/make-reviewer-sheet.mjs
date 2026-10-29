// 담당자 검산용 표(검산용_샘플10곳.md)를 만듭니다.
// 개발 서버나 운영 서버가 켜져 있어야 합니다.   사용법: node scripts/make-reviewer-sheet.mjs [포트=3000]
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "3000";
const base = `http://localhost:${port}`;
const DONGS = ["2650010100", "2650010200", "2650010300", "2650010400", "2650010500"];
const post = async (path, body) => (await (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json());

const criteria = (minArea) => ({
  purpose: "기타",
  dongs: DONGS,
  ownerTypes: ["국유지", "시 도유지", "군유지"],
  minArea,
  excludedJimok: ["도로", "구거", "하천", "제방", "유지", "철도용지", "묘지", "학교용지", "공원"],
});

// 후보: 면적 300㎡ 이상 국·공유지 묶음 전체의 규제 검토 결과
const search = await post("/api/land-search", criteria(300));
const all = [];
for (const g of search.groups) {
  const r = await post("/api/land-review", { pnus: g.parcels.map((p) => p.pnu) });
  if (r.parts) all.push({ g, r });
}
const complete = all.filter((x) => x.r.complete && x.r.totals);

// 다양한 경우를 고르게: 용도지역 7종 + 제2종 소규모(용적률 220%) + 가중평균 + 부분별 적용
const picks = [];
const take = (label, pred) => {
  const c = complete.filter((x) => !picks.some((p) => p.x === x) && pred(x)).sort((a, b) => b.r.siteArea - a.r.siteArea)[0];
  if (c) picks.push({ label, x: c });
};
for (const z of ["제1종일반주거지역", "제3종일반주거지역", "준주거지역", "일반상업지역", "준공업지역", "자연녹지지역"]) {
  take(`${z} 단일`, (x) => x.r.parts.length === 1 && x.r.parts[0].zone === z && x.r.siteArea <= 20000);
}
take("제2종일반주거지역 단일 (대지 1,000㎡ 초과 → 용적률 200%)", (x) => x.r.parts.length === 1 && x.r.parts[0].zone === "제2종일반주거지역" && x.r.siteArea > 1000 && x.r.siteArea <= 20000);
take("제2종일반주거지역 단일 (대지 1,000㎡ 이하 → 용적률 220%)", (x) => x.r.parts.length === 1 && x.r.parts[0].zone === "제2종일반주거지역" && x.r.siteArea <= 1000);
take("용도지역 2개에 걸침 — 가중평균 (가장 작은 부분 330㎡ 이하)", (x) => x.r.multiZone?.rule === "weighted");
take("용도지역 2개에 걸침 — 부분별 적용 (가장 작은 부분 330㎡ 초과)", (x) => x.r.multiZone?.rule === "separate" && x.r.parts.length === 2);

const fmt = (n) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const lines = [];
lines.push("# 건폐율·용적률 검산용 샘플 (담당자 확인용)");
lines.push("");
lines.push(`작성일 ${new Date().toISOString().slice(0, 10)} · 시범 지역 부산광역시 수영구 · 앱이 계산한 값과 담당자가 직접 계산한 값을 비교하는 표입니다.`);
lines.push("");
lines.push("## 검산 방법 (샘플마다 같음)");
lines.push("");
lines.push("1. **면적·용도지역 확인**: 토지이음(luris.molit.go.kr) 또는 토지대장에서 각 필지의 면적과 용도지역을 확인합니다. 아래 값은 VWorld에서 받은 값입니다.");
lines.push("2. **건폐율·용적률 확인**: 「부산광역시 도시계획 조례」 제49조(건폐율)·제50조(용적률)의 용도지역별 값을 확인합니다 (시행 2026-04-08 기준).");
lines.push("3. **계산**: 최대 건축면적 = 대지면적 × 건폐율, 최대 연면적 = 대지면적 × 용적률. 용도지역이 둘 이상이면 국토계획법 제84조에 따라 부분별로 계산하거나, 가장 작은 부분이 330㎡ 이하이면 가중평균합니다.");
lines.push("4. **비교**: 아래 표의 '담당자 값' 칸에 적고, 앱 값과 같으면 ○, 다르면 ✕와 이유를 적어 주세요.");
lines.push("");
lines.push("> 앱은 방화지구 건폐율 80%, 정비구역·지구단위계획구역 등 **조건부·별도 규정은 계산에 넣지 않고 '확인 필요'로만 알립니다.** 그런 규정을 적용한 값과 다르면 그 이유를 비고에 적어 주세요.");
lines.push("");
lines.push("## 한눈에 보기");
lines.push("");
lines.push("| # | 구분 | 대지면적(㎡) | 용도지역 | 앱: 최대 건축면적(㎡) | 담당자 값 | 앱: 최대 연면적(㎡) | 담당자 값 | 일치 | 비고 |");
lines.push("|---|---|---|---|---|---|---|---|---|---|");
picks.forEach(({ label, x }, i) => {
  const zones = x.r.parts.map((p) => (x.r.parts.length > 1 ? `${p.zone} ${(p.share * 100).toFixed(1)}%` : p.zone)).join(", ");
  lines.push(`| ${i + 1} | ${label} | ${fmt(x.r.siteArea)} | ${zones} | **${fmt(x.r.totals.maxBuildingArea)}** | | **${fmt(x.r.totals.maxFloorArea)}** | | | |`);
});
lines.push("");
lines.push("## 샘플별 상세");
picks.forEach(({ label, x }, i) => {
  lines.push("");
  lines.push(`### ${i + 1}. ${label}`);
  lines.push("");
  lines.push("**필지**");
  lines.push("");
  lines.push("| 주소 | 지목 | 면적(㎡) | 소유 |");
  lines.push("|---|---|---|---|");
  for (const p of x.g.parcels) lines.push(`| ${p.addr} | ${p.jimok} | ${fmt(p.area)} | ${p.ownerTypes.join("·")} |`);
  lines.push("");
  lines.push(`대지면적(토지대장 면적 합계): **${fmt(x.r.siteArea)}㎡**` + (x.g.parcels.length > 1 ? " — 붙어 있는 필지를 한 대지로 합쳐 계산 (합필 가정)" : ""));
  lines.push("");
  lines.push("**앱의 계산 (용도지역별)**");
  lines.push("");
  lines.push("| 용도지역 | 면적(㎡) | 건폐율 | 최대 건축면적(㎡) | 용적률 | 최대 연면적(㎡) | 근거 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of x.r.parts) {
    lines.push(`| ${p.zone} | ${fmt(p.area)} | ${p.bcr}% | ${fmt(p.maxBuildingArea)} | ${p.far}% | ${fmt(p.maxFloorArea)} | ${p.bcrBasis.replace("부산광역시 도시계획 조례 ", "조례 ")}, ${p.farBasis.replace("부산광역시 도시계획 조례 ", "조례 ")} |`);
  }
  lines.push("");
  lines.push(`합계: 최대 건축면적 **${fmt(x.r.totals.maxBuildingArea)}㎡**, 최대 연면적 **${fmt(x.r.totals.maxFloorArea)}㎡**`);
  if (x.r.multiZone) lines.push(`\n${x.r.multiZone.text}`);
  const notes = x.r.parts.flatMap((p) => p.notes);
  for (const n of notes) lines.push(`\n- ${n}`);
  if (x.r.checks.length) {
    lines.push("\n**앱이 '확인 필요'로 알린 것 (계산에는 넣지 않음)**\n");
    for (const c of x.r.checks) lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("**담당자 기입**");
  lines.push("");
  lines.push("| 항목 | 앱 값 | 담당자 값 | 일치(○/✕) | 비고 |");
  lines.push("|---|---|---|---|---|");
  lines.push(`| 대지면적(㎡) | ${fmt(x.r.siteArea)} | | | |`);
  lines.push(`| 용도지역 | ${x.r.parts.map((p) => p.zone).join(", ")} | | | |`);
  lines.push(`| 최대 건축면적(㎡) | ${fmt(x.r.totals.maxBuildingArea)} | | | |`);
  lines.push(`| 최대 연면적(㎡) | ${fmt(x.r.totals.maxFloorArea)} | | | |`);
});
lines.push("");
lines.push("## 끝나면");
lines.push("");
lines.push("10곳 모두 최대 건축면적·최대 연면적이 ○이면 PRD 3번 목표(\"샘플 10곳에서 담당자 검산과 모두 일치\")를 달성한 것입니다. ✕가 있으면 그 샘플의 필지 주소와 담당자가 적용한 기준을 알려 주세요. 앱의 규칙표(`lib/zoning-rules.ts`)나 계산을 고칩니다.");
lines.push("");
writeFileSync(new URL("../검산용_샘플10곳.md", import.meta.url), lines.join("\n"));
console.log("picked", picks.length, "samples:", picks.map((p) => `${p.label} | ${p.x.g.parcels[0].addr.replace("부산광역시 수영구 ", "")} | ${p.x.r.siteArea}㎡`));
