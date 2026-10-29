// 부산 전체 데이터를 한 번 받아 .cache/vworld 에 저장합니다. (약 10~20분, 중간에 멈춰도 이어서 할 수 있음)
//
//   node --env-file=.env scripts/build-busan-data.mjs                  전체
//   node --env-file=.env scripts/build-busan-data.mjs --gu=26500       수영구만 (시험용)
//   node --env-file=.env scripts/build-busan-data.mjs --steps=zones,edges   일부 단계만
//   node --env-file=.env scripts/build-busan-data.mjs --force           저장본이 있어도 다시 받기
//
// 단계: ① zoning  용도지역·개발제한구역 도형   ② dongs  동별 국·공유 필지(소유정보 + 도형)
//       ③ zones   필지마다 용도지역 비율       ④ edges  서로 맞닿은 필지 쌍(일단의 토지 묶기용)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = process.env.VWORLD_KEY;
const DOMAIN = process.env.VWORLD_DOMAIN ?? "localhost";
if (!KEY) {
  console.error(".env에 VWORLD_KEY가 없습니다. `node --env-file=.env scripts/build-busan-data.mjs` 로 실행하세요.");
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const STEPS = String(args.steps ?? "zoning,dongs,zones,edges").split(",");
const FORCE = !!args.force;
const GU = args.gu ? String(args.gu) : null;
const CACHE = fileURLToPath(new URL("../.cache/vworld/", import.meta.url));
mkdirSync(CACHE, { recursive: true });
const DONGS = JSON.parse(readFileSync(new URL("../lib/busan-dongs.json", import.meta.url), "utf8")).filter((d) => !GU || d.gu === GU);
const PUBLIC = ["국유지", "시 도유지", "군유지"];
const FRESH_MS = 7 * 86400_000;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 7) => Math.round(n * 10 ** d) / 10 ** d;

async function vget(url, tries = 4) {
  const full = `${url}${url.includes("?") ? "&" : "?"}key=${KEY}&domain=${DOMAIN}`;
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(full, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        // VWorld가 값이 역슬래시 하나인 데이터("buldDongNm" : "\")를 보내 JSON이 깨지는 경우가 있어 고쳐서 읽음
        const repaired = text.replace(/:\s*"\\"\s*([,}])/g, ': ""$1');
        if (repaired === text) throw e;
        return JSON.parse(repaired);
      }
    } catch (e) {
      if (i >= tries) throw new Error(`${e.message} (${url.slice(0, 90)}…)`);
      await sleep(800 * i);
    }
  }
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

const toMulti = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
const roundMulti = (m) => m.map((poly) => poly.map((ring) => ring.map(([x, y]) => [round(x), round(y)])));
const bboxOfMulti = (m) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0]) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
  return [a, b, c, d];
};

// ── ① 용도지역·개발제한구역 ──
async function stepZoning() {
  const file = `${CACHE}zoning-busan.json`;
  if (!FORCE && existsSync(file) && Date.now() - JSON.parse(readFileSync(file, "utf8")).fetchedAt < FRESH_MS) { log("zoning: 저장본 사용"); return; }
  const BOX = "128.75,34.95,129.32,35.40";
  const layers = [["LT_C_UQ111", "urban"], ["LT_C_UQ112", "manage"], ["LT_C_UQ113", "agri"], ["LT_C_UQ114", "nature"], ["LT_C_UD801", "greenbelt"]];
  const features = [];
  for (const [layer, kind] of layers) {
    const first = await vget(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${layer}&geomFilter=BOX(${BOX})&crs=EPSG:4326&format=json&size=100&page=1`);
    const total = Number(first.response.record.total);
    const pages = Math.ceil(total / 100);
    const results = new Array(pages);
    results[0] = first;
    await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 3, async (p) => {
      results[p - 1] = await vget(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${layer}&geomFilter=BOX(${BOX})&crs=EPSG:4326&format=json&size=100&page=${p}`);
    });
    let n = 0;
    for (const r of results) for (const f of r.response.result.featureCollection.features) {
      const g = roundMulti(toMulti(f.geometry));
      features.push({ k: kind, u: f.properties.uname || "", y: f.properties.dyear, n: f.properties.dnum, b: bboxOfMulti(g), g });
      n++;
    }
    log(`zoning ${layer} ${kind}: ${n}/${total}`);
  }
  writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), features }));
  log("zoning 저장 완료", features.length, "도형");
}

// ── ② 동별 국·공유 필지 ──
async function stepDongs() {
  let done = 0, skipped = 0;
  await pool(DONGS, 2, async (d) => {
    const file = `${CACHE}dong-${d.code}.json`;
    if (!FORCE && existsSync(file)) {
      try { if (Date.now() - JSON.parse(readFileSync(file, "utf8")).fetchedAt < FRESH_MS * 4) { skipped++; return; } } catch { /* 다시 받음 */ }
    }
    const base = `https://api.vworld.kr/ned/data/getPossessionAttr?pnu=${d.code}&format=json&numOfRows=1000`;
    const first = await vget(`${base}&pageNo=1`);
    const total = Number(first.possessions.totalCount);
    const pages = Math.ceil(total / 1000);
    const parcels = {};
    const addRows = (fields = []) => {
      for (const f of fields) {
        const p = (parcels[f.pnu] ??= { area: Number(f.lndpclAr), jimok: f.lndcgrCodeNm, ownerTypes: [], hasPrivate: false });
        if (PUBLIC.includes(f.posesnSeCodeNm)) { if (!p.ownerTypes.includes(f.posesnSeCodeNm)) p.ownerTypes.push(f.posesnSeCodeNm); }
        else p.hasPrivate = true;
      }
    };
    addRows(first.possessions.field);
    await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 5, async (p) => addRows((await vget(`${base}&pageNo=${p}`)).possessions.field));
    // 국·공유 소유자가 한 명이라도 있는 필지만 남김
    for (const pnu of Object.keys(parcels)) if (parcels[pnu].ownerTypes.length === 0) delete parcels[pnu];
    // 그 필지들의 도형
    const pnus = Object.keys(parcels);
    const chunks = [];
    for (let i = 0; i < pnus.length; i += 60) chunks.push(pnus.slice(i, i + 60));
    const geometries = {};
    await pool(chunks, 3, async (chunk) => {
      const j = await vget(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&attrFilter=${encodeURIComponent("pnu:in:" + chunk.join(","))}&crs=EPSG:4326&format=json&size=100&page=1`);
      if (j.response.status !== "OK") return;
      for (const f of j.response.result.featureCollection.features) {
        const pr = f.properties;
        geometries[pr.pnu] = { geometry: { type: "MultiPolygon", coordinates: roundMulti(toMulti(f.geometry)) }, props: { pnu: pr.pnu, addr: pr.addr, jibun: pr.jibun, jiga: pr.jiga, gosi_year: pr.gosi_year, gosi_month: pr.gosi_month, bonbun: pr.bonbun, bubun: pr.bubun } };
      }
    });
    writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), parcels, geometries }));
    done++;
    log(`dongs ${done + skipped}/${DONGS.length} ${d.guName} ${d.name}: 소유정보 ${total}행 → 국·공유 필지 ${pnus.length}개, 도형 ${Object.keys(geometries).length}개`);
  });
  log(`dongs 끝: 새로 받음 ${done}, 저장본 사용 ${skipped}`);
}

// ── 공통: 도형 도우미 ──
function pointInRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const pointInPoly = (x, y, poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h));

function loadDongFiles() {
  const out = [];
  for (const f of readdirSync(CACHE)) {
    if (!/^dong-\d{8}\.json$/.test(f)) continue;
    const code = f.slice(5, 13);
    if (GU && !code.startsWith(GU)) continue;
    out.push(JSON.parse(readFileSync(CACHE + f, "utf8")));
  }
  return out;
}

// ── ③ 필지마다 용도지역 비율 ──
async function stepZones() {
  const z = JSON.parse(readFileSync(`${CACHE}zoning-busan.json`, "utf8"));
  const CELL = 0.01;
  const grid = new Map();
  const feats = z.features.map((f) => ({ ...f, pb: f.g.map((poly) => bboxOfMulti([poly])) }));
  feats.forEach((f, i) => {
    for (let cx = Math.floor(f.b[0] / CELL); cx <= Math.floor(f.b[2] / CELL); cx++)
      for (let cy = Math.floor(f.b[1] / CELL); cy <= Math.floor(f.b[3] / CELL); cy++) {
        const k = `${cx},${cy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  const hit = (f, x, y) => {
    if (x < f.b[0] || x > f.b[2] || y < f.b[1] || y > f.b[3]) return false;
    for (let i = 0; i < f.g.length; i++) {
      const b = f.pb[i];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInPoly(x, y, f.g[i])) return true;
    }
    return false;
  };
  const files = loadDongFiles();
  const out = {};
  let n = 0;
  for (const d of files) {
    for (const [pnu, g] of Object.entries(d.geometries)) {
      const polys = g.geometry.coordinates;
      // 가장 큰(바깥 고리 면적이 큰) 폴리곤에서 점을 찍음
      let best = polys[0], bestA = -1;
      for (const p of polys) { const b = bboxOfMulti([p]); const a = (b[2] - b[0]) * (b[3] - b[1]); if (a > bestA) { bestA = a; best = p; } }
      const b = bboxOfMulti([best]);
      const pts = [];
      const N = 6;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const x = b[0] + ((i + 0.5) / N) * (b[2] - b[0]), y = b[1] + ((j + 0.5) / N) * (b[3] - b[1]);
        if (pointInPoly(x, y, best)) pts.push([x, y]);
      }
      if (pts.length < 3) { // 작은 필지: 꼭짓점을 중심 쪽으로 조금 당긴 점
        const cx = best[0].reduce((s, p) => s + p[0], 0) / best[0].length, cy = best[0].reduce((s, p) => s + p[1], 0) / best[0].length;
        pts.push([cx, cy]);
        for (const [x, y] of best[0].slice(0, 6)) pts.push([x + (cx - x) * 0.15, y + (cy - y) * 0.15]);
      }
      const count = {};
      let gb = 0;
      for (const [x, y] of pts) {
        const names = new Set();
        let inGb = false;
        for (const i of grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
          const f = feats[i];
          if (!hit(f, x, y)) continue;
          if (f.k === "greenbelt") inGb = true;
          else if (f.u) names.add(f.u);
        }
        if (inGb) gb++;
        const key = names.size === 0 ? "(없음)" : names.size > 1 ? "(겹침)" : [...names][0];
        count[key] = (count[key] ?? 0) + 1;
      }
      out[pnu] = { z: Object.entries(count).map(([k, v]) => [k, Math.round((v / pts.length) * 1000) / 1000]), g: Math.round((gb / pts.length) * 1000) / 1000 };
      n++;
    }
    if (n % 5000 < Object.keys(d.geometries).length) log(`zones ${n}필지`);
  }
  writeFileSync(`${CACHE}parcel-zones.json`, JSON.stringify(out));
  log(`zones 저장 완료: ${n}필지`);
}

// ── ④ 맞닿은 필지 쌍 ──
async function stepEdges() {
  const TOL_M = 0.3;
  const KX = 91061, KY = 110945; // 위도 35.1° 근처에서 경도·위도 1도의 미터 길이
  const parcels = [];
  for (const d of loadDongFiles()) for (const [pnu, g] of Object.entries(d.geometries)) parcels.push({ pnu, g: g.geometry.coordinates, b: bboxOfMulti(g.geometry.coordinates) });
  log(`edges: 필지 ${parcels.length}개`);
  const CELL = 0.002;
  const grid = new Map();
  const tolX = TOL_M / KX, tolY = TOL_M / KY;
  parcels.forEach((p, i) => {
    for (let cx = Math.floor((p.b[0] - tolX) / CELL); cx <= Math.floor((p.b[2] + tolX) / CELL); cx++)
      for (let cy = Math.floor((p.b[1] - tolY) / CELL); cy <= Math.floor((p.b[3] + tolY) / CELL); cy++) {
        const k = `${cx},${cy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  const segDist2 = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  };
  const near = (A, B) => { // A의 꼭짓점이 B의 변에 TOL_M 안으로 가까운가 (미터 환산)
    const lim = TOL_M * TOL_M;
    for (const pa of A) for (const [x, y] of pa[0]) {
      for (const pb of B) {
        const ring = pb[0];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if (segDist2(x * KX, y * KY, ring[j][0] * KX, ring[j][1] * KY, ring[i][0] * KX, ring[i][1] * KY) <= lim) return true;
        }
      }
    }
    return false;
  };
  const seen = new Set();
  const edges = [];
  let checked = 0;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) {
      const i = Math.min(list[a], list[c]), j = Math.max(list[a], list[c]);
      const key = i * 1e7 + j;
      if (seen.has(key)) continue;
      seen.add(key);
      const A = parcels[i], B = parcels[j];
      if (A.b[2] + tolX < B.b[0] || B.b[2] + tolX < A.b[0] || A.b[3] + tolY < B.b[1] || B.b[3] + tolY < A.b[1]) continue;
      checked++;
      if (near(A.g, B.g) || near(B.g, A.g)) edges.push([A.pnu, B.pnu]);
    }
  }
  writeFileSync(`${CACHE}edges-busan.json`, JSON.stringify({ fetchedAt: Date.now(), tolM: TOL_M, edges }));
  log(`edges 저장 완료: 검사한 쌍 ${checked}, 맞닿은 쌍 ${edges.length}`);
}

log(`시작: 단계 ${STEPS.join(", ")}${GU ? `, 구 ${GU}` : ""}, 동 ${DONGS.length}개, 저장 위치 ${CACHE}`);
if (STEPS.includes("zoning")) await stepZoning();
if (STEPS.includes("dongs")) await stepDongs();
if (STEPS.includes("zones")) await stepZones();
if (STEPS.includes("edges")) await stepEdges();
log("모두 끝");
