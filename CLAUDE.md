# CLAUDE.md — 국·공유지 개발 검토 (캠코 국유재산 담당자용 웹앱)

@AGENTS.md

## 프로젝트 한 줄 설명
부산광역시의 국·공유지(일단의 토지)를 찾고, 건폐율·용적률·용도 적합 여부를 계산하고, 3D 건물 배치안과 토지가격·사업비를 웹에서 보여 준다. 기획은 `PRD.md`, 진행 단계는 `PLAN.md`, 사용법은 `README.md`.

## 기술 스택
Next.js 16 (App Router, Turbopack, Cache Components) · React 19 · TypeScript · Tailwind 4 · MapLibre GL · Three.js · Turf.js · VWorld API.
Next.js 코드를 쓰기 전에 `node_modules/next/dist/docs/`의 해당 안내를 먼저 읽는다 (AGENTS.md).

## 명령 (Windows PowerShell)
- 개발 서버: `npm.cmd run dev` / 타입 검사: `npx.cmd tsc --noEmit` / 린트: `npx.cmd eslint .` / 빌드: `npm.cmd run build`
- 부산 전체 데이터 만들기(최초 1회, 약 10분, 중간에 끊겨도 이어서 진행): `node --env-file=.env scripts/build-busan-data.mjs` (`--gu=26500`, `--steps=zoning,dongs,zones,edges`, `--force`)
- 검산표 만들기: `scripts/make-reviewer-sheet.mjs` (부산 구·군 코드에 맞게 수정 필요)

## 폴더 구조
- `app/api/*` 서버 라우트: land-search, land-review, land-design, parcels (VWorld는 여기서만 호출)
- `app/components/*` 화면: LandFinder(전체 흐름), ParcelMap(지도·3D 회전), ReviewPanel, UsePanel, DesignPanel(안 카드·슬라이더), CostPanel, ReportSummary, `building-3d.ts`(Three.js 모델·GLB)
- `lib/` 계산 로직: `zoning-rules.ts`(건폐율·용적률 조례표), `use-rules*.ts`(용도 적합), `land-review.ts`, `land-search.ts`, `land-use-filter.ts`, `design-engine.ts`(배치안 7종), `project-cost.ts`, `vworld.ts`, `busan-data.ts`, `regions.ts`
- `.cache/vworld/` 내려받은 부산 데이터 (git 제외)

## 반드시 지킬 규칙
1. **데이터를 지어내지 않는다.** 소유 구분·용도지역·건폐율·용적률은 VWorld·법령·조례에 나온 값만 쓴다. 근거가 없으면 "확인 필요/확인 불가"로 표시하고 계산에서 뺀다.
2. 추천 결과는 입력 조건(소유·지역·면적·지목·용도)을 100% 충족해야 한다. 개수보다 정확도.
3. 3D 건물은 대지 경계 안, 최대 건축면적·연면적·용도 상한 이내여야 하고, 화면 숫자는 계산 결과와 항상 같아야 한다.
4. 가정값(층고, 이격, 건축면적 사용률, ㎡당 공사비)은 "가정값"으로 표시하고 사용자가 고칠 수 있게 한다.
5. 개인정보(소유자 이름 등)는 가져오지도 저장하지도 않는다. 공개 데이터만 쓴다.
6. 관리·농림지역, 개발제한구역은 판정하지 않고 추천에서 뺀다 (`unsupportedZone`으로 집계).

## 비밀 값
- VWorld 키는 `.env`의 `VWORLD_KEY`. 서버 코드에서만 쓰고 브라우저·로그·답변에 출력하지 않는다. VWorld 호출에는 `domain=localhost`가 필요하다.
- `.env`에 이 프로젝트와 무관한 토큰(GITHUB/SUPABASE/VERCEL)이 있으면 읽거나 출력하지 말고 지우도록 안내한다.

## 작업 방식
- 한국어 파일은 Edit/Write 도구로 고친다 (PowerShell Get-Content/Set-Content는 인코딩을 깨뜨림).
- 코드를 고친 뒤 `tsc --noEmit`과 eslint를 통과시키고, 화면 변경은 브라우저로 직접 확인한다.
- 배포·푸시·파일 삭제는 사용자가 요청할 때만 한다.
- 담당자 확인이 필요한 것: 건폐율·용적률 샘플 검산(`검산용_샘플10곳.md`), 청사 공사비 기준 단가.
