/**
 * check-format.mjs -- 源码格式检查（无参数，直接运行）。
 *
 * 用途：对仓库中的 .ts / .mjs / .rs / .sh 源文件执行两条与 Git diff 噪声和
 * POSIX 工具链兼容性相关的格式约束：
 *   1. 禁止 CRLF：Windows 行尾会在跨平台协作与 shell 脚本处理中引入
 *      隐蔽差异（脚本 / CI 中常用字符串比较与行处理对 \r 极其敏感）；
 *   2. 必须以换行符结尾：POSIX 文本文件约定，避免 "No newline at end
 *      of file" 的 diff 噪声并保证 cat/concat 场景正确。
 *
 * 运行方式：node scripts/check-format.mjs（从仓库根目录运行）。
 * 角色与设计意图：作为 CI / 提交前的低成本门禁，只检查、不修改文件，
 * 失败即抛错退出，强制贡献者自行修复编辑器 / git 配置（autocrlf 等），
 * 从而保持仓库内容在字节层面跨平台一致。
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 递归收集仓库中需要检查的源文件路径。
 * 行为：跳过生成物与依赖目录（.git / artifacts / coverage / data /
 * dist / node_modules / target）；目录递归下钻；仅保留扩展名为
 * .ts / .mjs / .rs / .sh 的文件。
 * @param {string} directory 起始目录（以 "." 从仓库根开始）
 * @returns {Promise<string[]>} 源文件的绝对路径列表
 */
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "artifacts", "coverage", "data", "dist", "node_modules", "target"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (/\.(ts|mjs|rs|sh)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = await collect(".");

for (const file of files) {
  const text = await readFile(file, "utf8");
  // 检查 \r 而非 \r\n：任何回车符（包括孤立的 \r）都视为违规
  if (text.includes("\r")) throw new Error(`${file}: CRLF is not allowed in source files`);
  if (!text.endsWith("\n")) throw new Error(`${file}: missing final newline`);
}

console.log(`format check passed (${files.length} source files)`);
