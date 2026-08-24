/**
 * create-signing-key.mjs -- 生成 Ed25519 更新签名密钥对。
 *
 * 用途：为发布/更新 feed 生成一对 Ed25519 密钥。私钥用于
 * create-update-feed.mjs 对 feed 做签名；公钥分发给客户端，
 * 用于在安装更新前验证 feed 的完整性与来源。
 *
 * 运行方式：
 *   node scripts/create-signing-key.mjs --private <私钥输出路径> --public <公钥输出路径>
 *
 * 设计意图：
 * - 为什么 feed 需要签名：更新归档来自网络，客户端必须能验证“这份 feed
 *   确实出自持有私钥的发布者且未被篡改”，否则任何人都能推送恶意 Runtime。
 *   Ed25519 签名短、快，且 Node 内置支持，适合作为唯一信任锚。
 * - 私钥不入 Git：仓库与产物中只携带公钥；私钥保存在
 *   发布机器 / 密钥管理系统中，泄露面越小越好。脚本用 wx 标志写入，
 *   绝不覆盖已有文件，避免误把正在使用的密钥替换掉。
 * - 公钥写失败会连带删除刚写的私钥，保证磁盘上不会出现“孤立的私钥”
 *   （没有对应公钥可分发）。
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * 解析 --private / --public 两个必填的路径参数。
 * 行为：参数必须成对出现（选项名 + 取值，取值不得以 "--" 开头），
 * 缺失任一即抛出带用法说明的错误。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {{private: string, public: string}} 选项对象
 */
function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error("usage: node scripts/create-signing-key.mjs --private path --public path");
    options[name.slice(2)] = value;
  }
  if (!options.private || !options.public) throw new Error("both --private and --public paths are required");
  return options;
}

const options = argumentsFor(process.argv.slice(2));
const privatePath = resolve(options.private);
const publicPath = resolve(options.public);
// 大小写不敏感比较（Windows 文件系统语义）：两个路径不能指向同一文件
if (privatePath.toLowerCase() === publicPath.toLowerCase()) throw new Error("private and public key paths must be different");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await Promise.all([mkdir(dirname(privatePath), { recursive: true }), mkdir(dirname(publicPath), { recursive: true })]);
// wx 标志：目标已存在则失败，绝不覆盖既有密钥；私钥收紧为 0o600 权限
await writeFile(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
try {
  await writeFile(publicPath, publicKey.export({ format: "pem", type: "spki" }), { flag: "wx", mode: 0o644 });
} catch (error) {
  // 公钥写失败时删除刚生成的私钥，避免留下没有对应公钥的孤立私钥
  const { rm } = await import("node:fs/promises");
  await rm(privatePath, { force: true });
  throw error;
}
console.log(`created Ed25519 private key: ${privatePath}`);
console.log(`created Ed25519 public key: ${publicPath}`);
