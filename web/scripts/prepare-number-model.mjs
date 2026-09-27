import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { create } from "tar";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "public/models/english-numbers-0.15.tar.gz");
const cache = path.join(root, ".speech-model-cache");
const archive = path.join(cache, "english.zip");
const sha256 = "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498";
await fs.mkdir(path.dirname(output), { recursive: true });
if ((await fs.stat(output).catch(() => null))?.size > 30000000) {
  console.log("Number speech model already prepared.");
  process.exit(0);
}
await fs.mkdir(cache, { recursive: true });
let zip = await fs.readFile(archive).catch(() => null);
if (!zip || createHash("sha256").update(zip).digest("hex") !== sha256) {
  console.log("Downloading official Vosk English model (40 MB)…");
  const response = await fetch("https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip", { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  zip = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(zip).digest("hex") !== sha256) throw new Error("Speech model checksum does not match");
  await fs.writeFile(archive, zip);
}
const extraction = path.join(cache, "english");
for (const [name, bytes] of Object.entries(unzipSync(zip))) {
  if (name.endsWith("/")) continue;
  const relative = name.replace(/^vosk-model-small-en-us-0\.15\//, "model/");
  const destination = path.resolve(extraction, relative);
  if (!destination.startsWith(extraction + path.sep)) throw new Error("Invalid model archive path");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}
await create({ file: output, cwd: extraction, gzip: true, portable: true, noMtime: true }, ["model"]);
console.log(`Number speech model prepared (${Math.round((await fs.stat(output)).size / 1000000)} MB).`);
