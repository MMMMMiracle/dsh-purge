/** 仅供卸载时清理旧版安装留下的授权记录。 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function clearDrillGrant(dshHome) {
  const file = join(dshHome, "dsh-purge", "drill-grant.json");
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
