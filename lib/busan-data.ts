// 부산 전체 데이터 저장본 읽기 (scripts/build-busan-data.mjs 가 만든 .cache/vworld 파일). 서버 쪽 코드에서만 import 하세요.
// 저장본이 없는 동은 몇 개까지만 그 자리에서 받아 오고, 많으면 스크립트를 먼저 돌리라고 알립니다.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DONG_NAME } from "./regions";
import { PUBLIC_OWNER_TYPES } from "./land-types";
import { getParcelsByDong, getPossessionsByDong, VWorldError, type ParcelProperties } from "./vworld";

export const CACHE_DIR = path.join(process.cwd(), ".cache", "vworld");
const DAY = 86_400_000;
const FRESH_DAYS = 28; // 저장본을 믿고 쓰는 기간 (공시지가는 연 1회, 소유정보는 가끔 바뀜)
const MAX_ON_DEMAND = 4; // 저장본이 없을 때 그 자리에서 받아 오는 동의 최대 개수

export class DataNotReadyError extends VWorldError {}

export type ParcelRecord = { area: number; jimok: string; ownerTypes: string[]; hasPrivate: boolean };
export type DongData = {
  fetchedAt: number;
  parcels: Record<string, ParcelRecord>; // 국·공유 소유자가 한 명이라도 있는 필지만
  geometries: Record<string, { geometry: GeoJSON.MultiPolygon; props: ParcelProperties }>;
};

const memory = new Map<string, DongData>();

// 배포 환경에서는 저장본이 파일로 없으므로 DATA_BASE_URL(Vercel Blob 주소)에서 gzip 파일을 받아 씀
const REMOTE = process.env.DATA_BASE_URL?.replace(/\/$/, "");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    if (!REMOTE) return null;
  }
  try {
    const res = await fetch(`${REMOTE}/${path.basename(file)}.gz`, { cache: "no-store" });
    if (!res.ok) return null;
    return JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function hasDongFile(code: string): Promise<boolean> {
  if (REMOTE) return true; // 배포본은 부산 전체 동 파일이 모두 올라가 있음
  try {
    await stat(path.join(CACHE_DIR, `dong-${code}.json`));
    return true;
  } catch {
    return false;
  }
}

// 저장본이 없을 때 VWorld에서 직접 받아 같은 형식으로 저장 (동 하나에 수십 초)
async function fetchDong(code: string): Promise<DongData> {
  const [rows, parcels] = await Promise.all([getPossessionsByDong(code), getParcelsByDong(code)]);
  const byPnu: DongData["parcels"] = {};
  for (const row of rows) {
    const p = (byPnu[row.pnu] ??= { area: row.area, jimok: row.jimok, ownerTypes: [], hasPrivate: false });
    if (PUBLIC_OWNER_TYPES.includes(row.ownerType)) {
      if (!p.ownerTypes.includes(row.ownerType)) p.ownerTypes.push(row.ownerType);
    } else p.hasPrivate = true;
  }
  for (const pnu of Object.keys(byPnu)) if (byPnu[pnu].ownerTypes.length === 0) delete byPnu[pnu];
  const geometries: DongData["geometries"] = {};
  for (const f of parcels.features) {
    if (byPnu[f.properties.pnu]) geometries[f.properties.pnu] = { geometry: f.geometry, props: f.properties };
  }
  return { fetchedAt: Date.now(), parcels: byPnu, geometries };
}

export async function loadDong(code: string): Promise<DongData> {
  const cached = memory.get(code);
  if (cached) return cached;
  const file = path.join(CACHE_DIR, `dong-${code}.json`);
  let data = await readJson<DongData>(file);
  if (!data || Date.now() - Number(data.fetchedAt) > FRESH_DAYS * DAY) {
    if (data) console.warn(`dong-${code} 저장본이 ${FRESH_DAYS}일보다 오래되었지만 다시 받지 못하면 그대로 씁니다`);
    if (!data) {
      if (REMOTE) throw new DataNotReadyError(`dong-${code} 자료를 불러오지 못했습니다.`);
      data = await fetchDong(code);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(data));
    }
  }
  memory.set(code, data);
  return data;
}

// 여러 동을 읽음. 저장본이 없는 동이 많으면 스크립트를 먼저 돌리라고 안내
export async function loadDongs(codes: string[]): Promise<DongData[]> {
  const unknown = codes.filter((c) => !DONG_NAME.has(c));
  if (unknown.length) throw new VWorldError(`알 수 없는 지역 코드: ${unknown.slice(0, 3).join(", ")}`);
  const missing: string[] = [];
  for (const c of codes) if (!memory.has(c) && !(await hasDongFile(c))) missing.push(c);
  if (missing.length > MAX_ON_DEMAND) {
    throw new DataNotReadyError(
      `선택한 지역 중 ${missing.length}개 동의 데이터가 아직 준비되지 않았습니다. 터미널에서 'node --env-file=.env scripts/build-busan-data.mjs'를 한 번 실행해 주세요 (부산 전체 약 10~20분).`,
    );
  }
  const out: DongData[] = [];
  for (const c of codes) out.push(await loadDong(c)); // 순서대로 (VWorld에 한꺼번에 몰리지 않게)
  return out;
}

// ── 맞닿은 필지 쌍 ──
type EdgeFile = { fetchedAt: number; tolM: number; edges: [string, string][] };
let edgesMemory: [string, string][] | null = null;

export async function loadEdges(): Promise<[string, string][] | null> {
  if (edgesMemory) return edgesMemory;
  const f = await readJson<EdgeFile>(path.join(CACHE_DIR, "edges-busan.json"));
  return (edgesMemory = f?.edges ?? null);
}

// ── 필지별 용도지역 비율 (검색 목록을 빠르게 거르기 위한 근사값) ──
export type ParcelZones = Record<string, { z: [string, number][]; g: number }>;
let zonesMemory: ParcelZones | null = null;

export async function loadParcelZones(): Promise<ParcelZones | null> {
  if (zonesMemory) return zonesMemory;
  return (zonesMemory = await readJson<ParcelZones>(path.join(CACHE_DIR, "parcel-zones.json")));
}

// ── 용도지역·개발제한구역 도형 ──
export type ZoningRecord = { k: "urban" | "manage" | "agri" | "nature" | "greenbelt"; u: string; y: string; n: string; b: [number, number, number, number]; g: number[][][][] };
export type ZoningFile = { fetchedAt: number; features: ZoningRecord[] };
let zoningMemory: ZoningFile | null = null;

export async function loadZoningFile(): Promise<ZoningFile> {
  if (zoningMemory) return zoningMemory;
  const f = await readJson<ZoningFile>(path.join(CACHE_DIR, "zoning-busan.json"));
  if (!f) {
    throw new DataNotReadyError(
      "용도지역 데이터가 아직 준비되지 않았습니다. 터미널에서 'node --env-file=.env scripts/build-busan-data.mjs'를 한 번 실행해 주세요.",
    );
  }
  return (zoningMemory = f);
}
