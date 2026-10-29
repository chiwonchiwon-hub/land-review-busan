// .cache/vworld 의 부산 자료를 gzip으로 압축해 Vercel Blob에 올립니다.
// 사용: node --env-file=.env.blob scripts/upload-data.mjs   (BLOB_READ_WRITE_TOKEN 필요)
import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { put } from "@vercel/blob";

const DIR = ".cache/vworld";
const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let base = "";
for (const f of files) {
  const gz = gzipSync(await readFile(`${DIR}/${f}`), { level: 9 });
  const res = await put(`${f}.gz`, gz, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/gzip", cacheControlMaxAge: 86400 });
  base = res.url.slice(0, res.url.lastIndexOf("/"));
  console.log(f, Math.round(gz.length / 1024), "KB");
}
console.log("DATA_BASE_URL=" + base);
