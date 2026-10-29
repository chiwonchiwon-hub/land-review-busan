import LandFinder from "./components/LandFinder";

export default function Home() {
  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-900">국·공유지 개발 검토</h1>
        <p className="text-sm text-zinc-500">검토 지역: 부산광역시 (16개 구·군)</p>
      </header>
      <LandFinder />
    </div>
  );
}
