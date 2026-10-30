// 자동으로 읽은 조례 규칙(data/ordinances/<지자체>.json)과 사람이 코드에 옮긴 규칙표(lib/zoning-rules.ts)를 대조합니다.
// 사용: node scripts/check-ordinance.mjs 부산광역시
//  - 완전 일치 / 조례의 단서값(예: 공업지역 건폐율 60%)으로 일치 / 불일치를 알려 줍니다. 불일치가 있으면 종료 코드 1.
import { readFileSync } from "node:fs";

const city = process.argv[2] ?? "부산광역시";
const j = JSON.parse(readFileSync(`data/ordinances/${city.replace(/\s+/g, "")}.json`, "utf8"));
const src = readFileSync("lib/zoning-rules.ts", "utf8");
const re = /(\S+지역|\S+보전지역):\s*\{\s*item:\s*\d+,\s*bcr:\s*(\d+),\s*far:\s*(\d+)/g;
const hand = {};
for (let m; (m = re.exec(src)); ) hand[m[1]] = { bcr: Number(m[2]), far: Number(m[3]) };

let exact = 0, cond = 0, bad = 0;
for (const [zone, r] of Object.entries(j.rules)) {
  const h = hand[zone];
  if (!h) { console.log("코드 표에 없음:", zone); continue; }
  const bcrOk = h.bcr === r.bcr || h.bcr === r.bcrAlt;
  const farOk = h.far === r.far || h.far === r.farAlt;
  if (h.bcr === r.bcr && h.far === r.far) exact++;
  else if (bcrOk && farOk) { cond++; console.log(`조건부 값으로 일치: ${zone} 코드 ${h.bcr}/${h.far} · 조례 기본 ${r.bcr}/${r.far} · 단서값 ${r.bcrAlt ?? "-"}/${r.farAlt ?? "-"}`); }
  else { bad++; console.log(`불일치: ${zone} 코드 ${h.bcr}/${h.far} · 조례 ${r.bcr}/${r.far}`); }
}
console.log(`${city}: 완전 일치 ${exact} / 단서값으로 일치 ${cond} / 불일치 ${bad}`);
process.exit(bad ? 1 : 0);
