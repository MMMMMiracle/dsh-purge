import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSlot } from "../lib/table-key.js";
import { openSlot } from "../lib/table-read.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 保留本地草稿入口；干净 checkout 使用随仓库分发的当前发布正文。
const draft = path.join(root, "lib", "default-prompt-inject.md");
const src = fs.existsSync(draft) ? draft : path.join(root, "lib", "default-prompt-source.md");
const dest = path.join(root, "lib", "asset-table.js");

if (!fs.existsSync(src)) {
  throw new Error(`missing local source: ${src}`);
}

const text = fs.readFileSync(src, "utf8");
if (!text.trim()) throw new Error("local source is empty");

// 加密使用随机 IV；正文没有变化时保留发布槽，避免构建制造无意义 diff。
if (text === openSlot()) {
  process.stdout.write("default prompt unchanged\n");
  process.exit(0);
}

const packed = sealSlot(text);
const chunk = (s, n = 96) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

const out = `const SLOT_ROWS = ${JSON.stringify(chunk(packed.SLOT), null, 2)};

export const SLOT = SLOT_ROWS.join("");
export const MASK = ${JSON.stringify(packed.MASK)};
export const TAG = ${JSON.stringify(packed.TAG)};
export const IV = ${JSON.stringify(packed.IV)};
`;

fs.writeFileSync(dest, out, "utf8");
process.stdout.write(`wrote ${path.relative(root, dest)} bytes=${text.length}\n`);
