// 지자체 도시계획 조례에서 용도지역별 건폐율·용적률을 읽어 규칙 파일(data/ordinances/<지자체>.json)로 만듭니다.
//
// 사용: node --env-file=.env scripts/ingest-ordinance.mjs --city "부산광역시" [--name "부산광역시 도시계획 조례"]
//   LAW_OC(법제처 Open API 인증키)가 .env에 있어야 합니다.
//
// 하는 일
//  1. 법제처 API로 조례 원문을 받아 '용도지역 안에서의 건폐율·용적률' 조문(영 제84조·제85조에 따른 조례)을 찾음
//  2. "제1종전용주거지역 : 50퍼센트 이하" 형식의 항목을 숫자로 바꿈 (단서·예외 문구는 그대로 보존)
//  3. 국토계획법 시행령 제84조·제85조의 법정 상한을 같은 방식으로 읽어, 조례 값이 상한을 넘으면 경고
//  4. 결과는 항상 verified:false(사람이 확인하기 전)로 저장. 이 파일의 값을 그대로 믿고 쓰지 말고 검증 리포트를 확인하세요.

import { mkdirSync, writeFileSync } from "node:fs";

const OC = process.env.LAW_OC;
if (!OC) throw new Error("LAW_OC(법제처 Open API 인증키)가 .env에 없습니다.");
const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const city = arg("city");
if (!city) throw new Error('--city "세종특별자치시" 처럼 지자체 이름을 주세요.');

async function getJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      return JSON.parse(await res.text());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}
const flat = (v) => (Array.isArray(v) ? v.map(flat).join("\n") : typeof v === "object" && v ? Object.values(v).map(flat).join("\n") : String(v ?? ""));

// "1천300" → 1300, "5백" → 500, "60" → 60
function koreanNumber(raw) {
  const s = raw.replace(/[,\s]/g, "");
  const m = /^(?:(\d+)천)?(?:(\d+)백)?(\d+)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 1000 + Number(m[2] ?? 0) * 100 + Number(m[3] ?? 0);
}

// 조문 본문에서 "<번호>. <지역명> : <숫자>퍼센트 이하 <단서>" 항목들을 뽑음 (제1항만).
// 항목의 시작("번호. 지역명 :")을 먼저 찾고, 다음 항목 시작 전까지를 그 항목으로 보아 값과 단서를 읽습니다.
// 단서는 괄호 안이든 "…이하. 다만, …"처럼 뒤따르든 모두 보존하고, 개정 이력(<개정…>, (개정…))은 뺍니다.
function parseZoneList(text) {
  const t = text.replace(/\s+/g, " ");
  const first = t.split(/\s?②/)[0]; // 제1항까지
  const starts = [...first.matchAll(/(?:^|[^0-9])(\d+)\.\s*([가-힣0-9·ㆍ]+(?:지역|지구|구역))\s*:\s*/g)];
  const items = {};
  starts.forEach((m, i) => {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index + (/^[^0-9]/.test(starts[i + 1][0]) ? 1 : 0) : first.length;
    const seg = first.slice(bodyStart, bodyEnd);
    const vm = /([0-9천백,]+)\s*퍼센트\s*이하/.exec(seg);
    if (!vm) return;
    const value = koreanNumber(vm[1]);
    if (value === null) return;
    const rest = seg
      .slice(vm.index + vm[0].length)
      .replace(/<[^>]*>/g, "")
      .replace(/\((?:개정|신설|삭제)[^)]*\)/g, "")
      .replace(/\d+\.\s*삭제.*$/, "") // 뒤따르는 삭제된 항(예: "18. 삭제")은 단서가 아님
      .replace(/^[\s.,)(]+|[\s.]+$/g, "");
    const note = rest.length > 2 ? rest.replace(/^\(|\)$/g, "") : undefined;
    const altRaw = note ? /([0-9천백,]+)\s*퍼센트\s*이하/.exec(note) : null;
    items[m[2]] = { value, note, alt: altRaw ? (koreanNumber(altRaw[1]) ?? undefined) : undefined };
  });
  return { items, raw: first };
}

async function findOrdinance(cityName) {
  const names = [arg("name"), `${cityName} 도시계획 조례`, `${cityName} 도시ㆍ군계획 조례`, `${cityName} 도시·군계획 조례`].filter(Boolean);
  for (const n of names) {
    const s = await getJson(`https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=ordin&type=JSON&query=${encodeURIComponent(n)}&display=100`);
    const list = [].concat(s.OrdinSearch?.law ?? []);
    const hit = list.find((l) => l["자치법규명"] === n && (l["지자체기관명"] ?? "") === cityName) ?? list.find((l) => l["자치법규명"] === n);
    if (hit) return hit;
  }
  throw new Error(`${cityName}의 도시계획 조례를 찾지 못했습니다.`);
}

async function articleText(mst, titleRe) {
  const d = await getJson(`https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=ordin&MST=${mst}&type=JSON`);
  const arts = [].concat((d["LawService"] ?? d)["조문"]?.["조"] ?? []);
  return arts.filter((a) => titleRe.test(String(a["조제목"] ?? "").replace(/\s/g, ""))).map((a) => ({ no: a["조문번호"], title: a["조제목"], text: flat(a["조내용"]) }));
}

// 국토계획법 시행령 제84조(건폐율)·제85조(용적률)의 법정 상한
async function nationalCaps() {
  const s = await getJson(`https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=law&type=JSON&query=${encodeURIComponent("국토의 계획 및 이용에 관한 법률 시행령")}`);
  const hit = [].concat(s.LawSearch?.law ?? []).find((l) => l["법령명한글"] === "국토의 계획 및 이용에 관한 법률 시행령");
  const get = async (jo) => {
    const d = await getJson(`https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=law&MST=${hit["법령일련번호"]}&type=JSON&JO=${jo}`);
    return flat(d["법령"]?.["조문"]?.["조문단위"] ?? []);
  };
  const bcr = parseZoneList((await get("008400")).replace(/제\d+조\([^)]*\)/, ""));
  const far = parseZoneList((await get("008500")).replace(/제\d+조\([^)]*\)/, ""));
  return { bcr: bcr.items, far: far.items, effective: hit["시행일자"] };
}

const hit = await findOrdinance(city);
const mst = hit["자치법규일련번호"];
const bcrArts = await articleText(mst, /용도지역(안|내)?에서의건폐율/);
const farArts = await articleText(mst, /용도지역(안|내)?에서의용적률/);
if (!bcrArts.length || !farArts.length) throw new Error("건폐율·용적률 조문을 찾지 못했습니다 (조문 제목이 다른 형식일 수 있음).");

const bcr = parseZoneList(bcrArts[0].text);
const far = parseZoneList(farArts[0].text);
const caps = await nationalCaps();

const issues = [];
const zones = [...new Set([...Object.keys(bcr.items), ...Object.keys(far.items)])];
for (const z of zones) {
  const b = bcr.items[z], f = far.items[z];
  if (!b) issues.push(`${z}: 건폐율 값을 읽지 못함`);
  if (!f) issues.push(`${z}: 용적률 값을 읽지 못함`);
  if (b && caps.bcr[z] && b.value > caps.bcr[z].value) issues.push(`${z}: 건폐율 ${b.value}%가 법정 상한 ${caps.bcr[z].value}%를 넘음`);
  if (f && caps.far[z] && f.value > caps.far[z].value) issues.push(`${z}: 용적률 ${f.value}%가 법정 상한 ${caps.far[z].value}%를 넘음`);
  if (b?.note) issues.push(`${z}: 건폐율에 단서가 있음 — "${b.note.slice(0, 60)}" (사람이 확인 필요)`);
  if (f?.note) issues.push(`${z}: 용적률에 단서가 있음 — "${f.note.slice(0, 60)}" (사람이 확인 필요)`);
}
if (zones.length < 10) issues.push(`읽은 용도지역이 ${zones.length}개뿐이라 형식이 다를 수 있음`);

const out = {
  city,
  ordinance: { name: hit["자치법규명"], mst, effective: hit["시행일자"], bcrArticle: bcrArts[0].title, farArticle: farArts[0].title },
  nationalCapsEffective: caps.effective,
  nationalCapsChecked: { bcr: Object.keys(caps.bcr).length, far: Object.keys(caps.far).length },
  fetchedAt: new Date().toISOString(),
  verified: false,
  rules: Object.fromEntries(zones.map((z) => [z, { bcr: bcr.items[z]?.value ?? null, bcrAlt: bcr.items[z]?.alt, bcrNote: bcr.items[z]?.note, far: far.items[z]?.value ?? null, farAlt: far.items[z]?.alt, farNote: far.items[z]?.note }])),
  issues,
  source: { bcrText: bcr.raw.slice(0, 6000), farText: far.raw.slice(0, 6000) },
};
mkdirSync("data/ordinances", { recursive: true });
const slug = city.replace(/\s+/g, "");
writeFileSync(`data/ordinances/${slug}.json`, JSON.stringify(out, null, 2));
console.log(`저장: data/ordinances/${slug}.json  (${out.ordinance.name}, 시행 ${out.ordinance.effective})`);
console.log(`읽은 용도지역 ${zones.length}개, 경고 ${issues.length}건`);
for (const z of zones) console.log(`  ${z.padEnd(10, "　")} 건폐율 ${String(bcr.items[z]?.value ?? "-").padStart(4)}% | 용적률 ${String(far.items[z]?.value ?? "-").padStart(5)}%`);
for (const i of issues) console.log("  ⚠", i);
