// 건물 디자인(BuildingDesign)을 Three.js 3D 모델로 만들고, MapLibre 지도 위에 얹거나 GLB 파일로 내보냅니다.
// 브라우저에서만 실행하세요 (캔버스·WebGL 사용).

import * as THREE from "three";
import * as maplibregl from "maplibre-gl";
import type { BuildingDesign, DesignVolume, XY } from "@/lib/land-types";

const BAY = 3; // 창 한 칸의 너비(m)

type Palette = {
  wall: string; // 벽·슬래브 색
  glass: [string, string]; // 유리 위·아래 색
  mullion: string; // 창틀 색
  roof: string;
  accent: string; // 옥상 구조물·차양 색
  windowRatio: number; // 한 칸에서 창이 차지하는 너비 비율
  fins: boolean; // 세로 루버(수직 살)를 넣을지
  balcony?: boolean; // 발코니 난간(가로 띠)을 넣을지
};

const PALETTES: Record<string, Palette> = {
  청사: { wall: "#d9dde2", glass: ["#3b6a99", "#a4cbe8"], mullion: "#2b3a4a", roof: "#6b727c", accent: "#2f3944", windowRatio: 0.92, fins: true },
  공공주택: { wall: "#f3f0e9", glass: ["#6f8fa8", "#c4d8e6"], mullion: "#ffffff", roof: "#8b9096", accent: "#5f6670", windowRatio: 0.62, fins: false, balcony: true },
  기타: { wall: "#e2e5e8", glass: ["#4d7a9c", "#a8c9df"], mullion: "#33414e", roof: "#6c747d", accent: "#3f4852", windowRatio: 0.8, fins: false },
};

// 한 층 × 한 칸 크기의 외벽 무늬. lobby면 1층용(키 큰 유리 + 어두운 기단)
function facadeCanvas(p: Palette, lobby: boolean): HTMLCanvasElement {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = lobby ? p.accent : p.wall;
  ctx.fillRect(0, 0, size, size);

  const slab = size * (lobby ? 0.08 : 0.16);
  const winW = size * (lobby ? 0.96 : p.windowRatio);
  const x0 = (size - winW) / 2;
  const top = lobby ? 6 : 10;
  const grad = ctx.createLinearGradient(0, top, 0, size - slab);
  grad.addColorStop(0, p.glass[0]);
  grad.addColorStop(0.55, p.glass[1]);
  grad.addColorStop(1, p.glass[0]);
  ctx.fillStyle = grad;
  ctx.fillRect(x0, top, winW, size - slab - top - 2);

  if (p.balcony && !lobby) {
    // 발코니 난간: 창 아래쪽에 흰 가로 띠
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillRect(x0, size - slab - 34, winW, 22);
    ctx.fillStyle = "rgba(60,70,80,0.35)";
    ctx.fillRect(x0, size - slab - 34, winW, 2);
  }

  ctx.fillStyle = lobby ? "#1f2830" : p.mullion;
  ctx.fillRect(x0 - 1, top - 3, 3, size - slab - top + 3);
  ctx.fillRect(x0 + winW - 2, top - 3, 3, size - slab - top + 3);
  ctx.fillRect(size / 2 - 1.2, top, 2.4, size - slab - top - 2);
  ctx.fillRect(x0 - 1, top - 3, winW + 2, 3);
  ctx.fillRect(x0 - 1, size - slab - 5, winW + 2, 3);

  if (p.fins && !lobby) {
    ctx.fillStyle = "rgba(255,255,255,0.35)"; // 햇빛에 반짝이는 세로 루버
    ctx.fillRect(size * 0.22, top, 2, size - slab - top - 2);
    ctx.fillRect(size * 0.78, top, 2, size - slab - top - 2);
  }
  // 유리에 대각선으로 반사광
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, top, winW, size - slab - top - 2);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.moveTo(x0, top + 40);
  ctx.lineTo(x0 + winW * 0.55, top);
  ctx.lineTo(x0 + winW * 0.85, top);
  ctx.lineTo(x0, top + 80);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "rgba(0,0,0,0.12)"; // 슬래브 아래 그림자 선
  ctx.fillRect(0, size - slab, size, 3);
  return canvas;
}

// 면 하나는 세로로 층고, 가로로 한 칸 단위로 무늬가 반복되도록 (ExtrudeGeometry 옆면 UV는 미터 단위)
function makeTexture(canvas: HTMLCanvasElement, floorH: number) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / BAY, 1 / floorH);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const shapeOf = (ring: XY[], holes: XY[][] = []) => {
  const s = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  return s;
};

function inRing(p: XY, ring: XY[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distToRing(p: XY, ring: XY[]) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

const signedArea = (ring: XY[]) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
};

// 시드가 같으면 같은 수를 내는 간단한 난수 (나무 배치가 다시 그려도 변하지 않게)
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Z가 위쪽인 좌표계(x=동, y=북, 단위 m)로 건물 모델을 만듭니다. 원점은 design.origin입니다.
export function buildDesignGroup(design: BuildingDesign): THREE.Group {
  const palette = PALETTES[design.purpose] ?? PALETTES.기타;
  const floorH = design.params.floorHeight;
  const root = new THREE.Group();
  root.name = "건물 디자인";

  const wallTex = makeTexture(facadeCanvas(palette, false), floorH);
  const lobbyTex = makeTexture(facadeCanvas(palette, true), floorH);
  const sideMat = (map: THREE.Texture) =>
    new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.38, roughness: 0.45, metalness: 0.05 });
  const wallMat = sideMat(wallTex);
  // 아파트 단지: 동마다 꼭대기 두 층에 다른 색 포인트를 줘 단지가 획일적으로 보이지 않게 함 (동별 다른 디자인)
  const isApt = design.purpose === "공공주택" && design.buildings.some((bd) => bd.volumes.some((vv) => !!vv.shape));
  const ACCENTS = ["#6f9bd8", "#e39a7b", "#7fb89a", "#e6c068", "#a58bc9", "#6fbcbc"];
  const accentWalls = isApt
    ? ACCENTS.map((c) => {
        const m = wallMat.clone();
        m.color = new THREE.Color(c);
        return m;
      })
    : [];
  let aptIndex = 0;
  const lobbyMat = sideMat(lobbyTex);
  const slabMat = new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.8 });
  const roofGray = new THREE.MeshStandardMaterial({ color: palette.roof, roughness: 0.9 });
  const roofGreen = new THREE.MeshStandardMaterial({ color: "#6f9a58", roughness: 1 });
  const accentMat = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.6 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x1f2933, transparent: true, opacity: 0.4 });
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x0b1620, transparent: true, opacity: 0.16, depthWrite: false });

  // 대지 바닥 (잔디 느낌의 얇은 판)
  if (design.site) {
    const ground = new THREE.Mesh(
      new THREE.ShapeGeometry(shapeOf(design.site.ring, design.site.holes)),
      new THREE.MeshStandardMaterial({ color: "#cfdcc2", roughness: 1, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    ground.position.z = 0.04;
    ground.name = "대지";
    root.add(ground);
  }

  const allRings: XY[][] = [];
  const many = design.buildings.reduce((s, x) => s + x.volumes.length, 0) > 16; // 동이 많으면 모서리 선·옥상 설비를 생략해 가볍게
  design.buildings.forEach((b, bi) => {
    const group = new THREE.Group();
    group.name = `건물 ${bi + 1}${b.zone ? ` (${b.zone})` : ""}`;
    const topFloor = Math.max(...b.volumes.map((v) => v.startFloor + v.floors));

    // 가려지는 아래층 덩어리부터 그려 계단식·저층부 위 타워가 자연스럽게 겹치도록
    for (const v of b.volumes) {
      allRings.push(v.ring);
      const z0 = v.startFloor * floorH;
      const height = v.floors * floorH;
      const shape = shapeOf(v.ring);
      const isTop = v.startFloor + v.floors === topFloor;

      const addExtrusion = (z: number, h: number, mats: THREE.Material[]) => {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.z = z;
        group.add(mesh);
        if (!many) {
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), lineMat);
          edges.position.z = z;
          group.add(edges);
        }
      };

      // 1층은 키 큰 유리(로비), 나머지는 일반 외벽. 재료 순서: [윗면·아랫면, 옆면]
      const band = isApt && v.floors >= 5 ? 2 * floorH : 0; // 꼭대기 두 층
      const accent = band > 0 ? accentWalls[aptIndex++ % accentWalls.length] : null;
      if (v.startFloor === 0 && v.floors >= 2) {
        addExtrusion(0, floorH, [slabMat, lobbyMat]);
        addExtrusion(floorH, height - floorH - band, [slabMat, wallMat]);
      } else {
        addExtrusion(z0, height - band, [slabMat, wallMat]);
      }
      if (accent) addExtrusion(z0 + height - band, band, [slabMat, accent]);

      // 옥상: 덮여 있지 않은 덩어리는 지붕 슬래브, 낮은 덩어리(테라스)는 녹지
      const covered = b.volumes.some((o) => o !== v && o.startFloor === v.startFloor + v.floors && o.floors > 0 && inRing(centroidOf(o.ring), v.ring));
      if (!covered) {
        const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false }), [isTop || isApt ? roofGray : roofGreen, slabMat]);
        roof.position.z = z0 + height;
        group.add(roof);

        if (isTop && !many) {
          const c = interiorPoint(v.ring);
          if (distToRing(c, v.ring) > 3) {
            const size = Math.max(2, Math.min(8, distToRing(c, v.ring) * 0.9));
            const hv = Math.min(3.2, floorH * 0.9);
            const box = new THREE.Mesh(new THREE.BoxGeometry(size * 1.4, size, hv), accentMat);
            box.position.set(c[0], c[1], z0 + height + 0.5 + hv / 2);
            group.add(box);
          }
        }
      }

      // 가짜 그림자: 햇빛이 남서쪽에서 오므로 북동쪽으로 길게 (높이의 절반, 최대 40m)
      const len = Math.min(40, (z0 + height) * 0.5);
      if (len > 1) {
        const dx = len * 0.8, dy = len * 0.6;
        const pos: number[] = [];
        const tri = (a: XY, bb: XY, c: XY) => pos.push(a[0], a[1], 0, bb[0], bb[1], 0, c[0], c[1], 0);
        const ccw = signedArea(v.ring) > 0;
        const moved = v.ring.map(([x, y]) => [x + dx, y + dy] as XY);
        for (let i = 0; i < v.ring.length; i++) {
          const j = (i + 1) % v.ring.length;
          const [a, bq, a2, b2] = [v.ring[i], v.ring[j], moved[i], moved[j]];
          if (ccw) { tri(a, bq, b2); tri(a, b2, a2); } else { tri(a, b2, bq); tri(a, a2, b2); }
        }
        // 이동한 윗면도 채움
        const cap = new THREE.ShapeGeometry(shapeOf(moved));
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        for (const geo of [g, cap]) {
          const m = new THREE.Mesh(geo, shadowMat);
          m.position.z = 0.08;
          m.material.side = THREE.DoubleSide;
          group.add(m);
        }
      }
    }

    if (isApt) {
      const tall = b.volumes.filter((vv) => vv.floors >= 14);
      let pair: [DesignVolume, DesignVolume, number] | null = null;
      for (let i = 0; i < tall.length; i++) {
        for (let j = i + 1; j < tall.length; j++) {
          const pa = interiorPoint(tall[i].ring), pb = interiorPoint(tall[j].ring);
          const dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
          if (dist >= 20 && dist <= 70 && (!pair || dist < pair[2])) pair = [tall[i], tall[j], dist];
        }
      }
      if (pair) {
        const pa = interiorPoint(pair[0].ring), pb = interiorPoint(pair[1].ring);
        const zBridge = (Math.min(pair[0].floors, pair[1].floors) - 3) * floorH;
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(pair[2], 3.4, floorH * 0.95), accentMat);
        bridge.position.set((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, zBridge + (floorH * 0.95) / 2);
        bridge.rotation.z = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
        bridge.name = "스카이브릿지";
        group.add(bridge);
      }
    }

    // 현관 차양: 1층이 있는 덩어리의 가장 긴 변 가운데에 얇은 지붕과 기둥
    const base = b.volumes.filter((v) => v.startFloor === 0).sort((a, c) => c.area - a.area)[0];
    if (base) {
      const ring = base.ring;
      const ccw = signedArea(ring) > 0;
      let bestI = 0, bestLen = 0;
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const l = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
        if (l > bestLen) { bestLen = l; bestI = i; }
      }
      const a = ring[bestI], c = ring[(bestI + 1) % ring.length];
      const ex = (c[0] - a[0]) / bestLen, ey = (c[1] - a[1]) / bestLen;
      const nx = ccw ? ey : -ey, ny = ccw ? -ex : ex; // 바깥쪽 법선
      if (bestLen >= 12) {
        const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
        const w = Math.min(9, bestLen * 0.35), dp = 3.2;
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(w, dp, 0.35), accentMat);
        canopy.position.set(mx + nx * (dp / 2), my + ny * (dp / 2), Math.min(floorH, 4) * 0.92);
        canopy.rotation.z = Math.atan2(ey, ex);
        group.add(canopy);
        for (const s of [-1, 1]) {
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, Math.min(floorH, 4) * 0.92, 10), accentMat);
          col.rotation.x = Math.PI / 2;
          col.position.set(mx + ex * s * (w / 2 - 0.3) + nx * (dp - 0.3), my + ey * s * (w / 2 - 0.3) + ny * (dp - 0.3), (Math.min(floorH, 4) * 0.92) / 2);
          group.add(col);
        }
      }
    }
    root.add(group);
  });

  // 나무: 대지 안에서 건물과 4m 이상 떨어진 곳에 흩뿌림
  if (design.site && allRings.length > 0) {
    const rand = rng(Math.round(design.site.ring[0][0] * 100 + design.site.ring[0][1] * 31));
    const xs = design.site.ring.map((p) => p[0]), ys = design.site.ring.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const trunkMat = new THREE.MeshStandardMaterial({ color: "#6b4f3a", roughness: 1 });
    const leafMats = ["#5f8f4e", "#6fa05a", "#4f7f45"].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
    const trees = new THREE.Group();
    trees.name = "조경";
    let placed = 0;
    for (let k = 0; k < 400 && placed < 45; k++) {
      const p: XY = [minX + rand() * (maxX - minX), minY + rand() * (maxY - minY)];
      if (!inRing(p, design.site.ring) || design.site.holes.some((h) => inRing(p, h))) continue;
      if (distToRing(p, design.site.ring) < 1.2) continue;
      if (allRings.some((r) => inRing(p, r) || distToRing(p, r) < 4)) continue;
      const h = 4 + rand() * 3;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, h * 0.45, 6), trunkMat);
      trunk.rotation.x = Math.PI / 2;
      trunk.position.set(p[0], p[1], h * 0.225);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(h * 0.33, 10, 8), leafMats[Math.floor(rand() * leafMats.length)]);
      crown.position.set(p[0], p[1], h * 0.7);
      trees.add(trunk, crown);
      placed++;
    }
    root.add(trees);
  }
  return root;
}

// 다각형 안쪽에서 가장자리에서 가장 먼 점 (오목한 형태에서도 안쪽에 놓이게)
function interiorPoint(ring: XY[]): XY {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best: XY = centroidOf(ring);
  let bestD = inRing(best, ring) ? distToRing(best, ring) : -1;
  for (let i = 1; i < 8; i++) {
    for (let j = 1; j < 8; j++) {
      const p: XY = [minX + ((maxX - minX) * i) / 8, minY + ((maxY - minY) * j) / 8];
      if (!inRing(p, ring)) continue;
      const d = distToRing(p, ring);
      if (d > bestD) {
        best = p;
        bestD = d;
      }
    }
  }
  return best;
}

function centroidOf(ring: XY[]): XY {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}

export type BuildingLayer = maplibregl.CustomLayerInterface & { dispose: () => void };

// MapLibre 지도의 3D 레이어로 건물을 그립니다. 지도 카메라(기울기·회전)를 그대로 따라갑니다.
export function createBuildingLayer(id: string, design: BuildingDesign): BuildingLayer {
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  const group = buildDesignGroup(design);
  scene.add(group);

  // 조명: 하늘빛 + 햇빛 방향 (건물 면마다 밝기가 달라 입체감이 남)
  scene.add(new THREE.HemisphereLight(0xdbe9ff, 0x9aa0a8, 2.0));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-0.6, -0.5, 0.9).normalize();
  scene.add(sun);

  const origin = maplibregl.MercatorCoordinate.fromLngLat(design.origin, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  let renderer: THREE.WebGLRenderer | null = null;
  let mapRef: maplibregl.Map | null = null;

  return {
    id,
    type: "custom",
    renderingMode: "3d",
    onAdd(map, gl) {
      mapRef = map;
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(_gl, options) {
      if (!renderer) return;
      const main = new THREE.Matrix4().fromArray(Array.from(options.defaultProjectionData.mainMatrix as ArrayLike<number>));
      // 건물 좌표(미터)를 지도의 메르카토르 좌표로 옮기고 확대 (메르카토르는 북쪽이 -y)
      const place = new THREE.Matrix4()
        .makeTranslation(origin.x, origin.y, origin.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale));
      camera.projectionMatrix = main.multiply(place);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      disposeGroup(group);
      renderer?.dispose();
      renderer = null;
      mapRef = null;
    },
    dispose() {
      mapRef?.triggerRepaint();
    },
  };
}

// GLB(3D 모델 파일)로 내보냅니다. Blender, SketchUp, Rhino 같은 프로그램에서 열 수 있습니다.
// glTF는 Y가 위쪽이라 모델을 눕혀서 내보내고, 단위는 미터입니다.
export async function exportDesignGlb(design: BuildingDesign): Promise<Blob> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const model = buildDesignGroup(design);
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // Z-up → Y-up
  root.add(model);
  root.updateMatrixWorld(true);
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true });
    return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
  } finally {
    disposeGroup(model);
  }
}

export type { DesignVolume };
