// 用 esbuild 的 JS API 把 DSH 前端产物降级到 es2021。
//
// 为什么换成 API 而不是 CLI：CLI 那版对 PDF.js 里的一个类静态块不降级，
// 我手工拼字符串又算错了偏移把文件搞坏了。API 版本配合 onEnd 插件可以在
// 解析树层面处理，不靠字符串拼接。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 路径不写死，跟 compat/paths.py 一套规则：
// 工作区根优先读 MINGYUE_WS，否则从本文件位置往上推两级。
const WS = process.env.MINGYUE_WS || path.dirname(path.dirname(__dirname));

/** 找构建工具目录。跟 paths.py 一样：找不到就明确报错，不拿错路径硬跑。 */
function findBuildtools() {
  const env = process.env.MINGYUE_BUILDTOOLS;
  if (env) {
    if (fs.existsSync(env)) return env;
    console.error("警告：MINGYUE_BUILDTOOLS 指向的目录不存在，改为自动查找。\n    " + env);
  }
  const cands = [
    path.join(WS, "_buildtools"),
    path.join(WS, "buildtools"),
    path.join(path.dirname(__dirname), "_buildtools"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error(
    "找不到构建工具目录（_buildtools）。\n" +
      "本仓库不附带它，构建脚本是给改代码的人用的，普通使用不需要。\n\n" +
      "要改代码的话，把它放到工作区根目录，或用环境变量指过去：\n" +
      '    set MINGYUE_BUILDTOOLS=D:\\你的目录\\_buildtools\n\n' +
      "已试过：\n" + cands.map((c) => "    " + c).join("\n")
  );
  process.exit(2);
}

const BT = findBuildtools();

/** 找 DSH 的包目录：优先 DSH_NM，否则依次试几个常见的安装位置。 */
function findDshPackages() {
  const env = process.env.DSH_NM;
  if (env) {
    if (fs.existsSync(env)) return env;
    // 设了但指错了要说出来，否则用户以为生效了、实际用的是别的路径
    console.error("警告：DSH_NM 指向的目录不存在，改为自动查找。\n    " + env);
  }
  const home = os.homedir();
  const cands = [
    path.join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai"),
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai"),
  ];
  const npx = path.join(home, ".npm", "_npx");
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      cands.push(path.join(npx, d, "node_modules", "@deepseek-ai"));
    }
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error(
    "找不到 DSH 的安装位置。这几个脚本要改你电脑上已经装好的 DSH。\n\n" +
      "DSH 装在别处的话，用环境变量指过去：\n" +
      "    set DSH_NM=%USERPROFILE%\\.dsh\\profiles\\node_modules\\@deepseek-ai\n\n" +
      "试过这些位置：\n" + cands.map((c) => "    " + c).join("\n")
  );
  process.exit(2);
}

/** esbuild 延迟加载，位置不固定。 */
function loadEsbuild() {
  const cands = [path.join(BT, "node_modules", "esbuild"), "esbuild"];
  for (const c of cands) {
    try {
      return require(c);
    } catch (e) {
      /* 试下一个 */
    }
  }
  throw new Error(
    "找不到 esbuild。装一下：\n  npm install esbuild --prefix \"" + BT + "\""
  );
}

const NM = findDshPackages();
const DIST = path.join(NM, "dsh-web-frontend", "dist");
const esbuild = loadEsbuild();
const TARGET = "es2021";

const MAIN = ["index-BKQ_L1z6.js", "vendor-CCJJTK99.js"];

async function transpile(file) {
  const src = fs.readFileSync(file, "utf8");
  const before = (src.match(/static\s*\{/g) || []).length;
  const buf = await esbuild.transform(src, {
    target: TARGET,
    format: "esm",
    minify: true,
    charset: "utf8",
    loader: "js",
    legalComments: "inline",
  });
  const out = buf.code;
  const after = (out.match(/static\s*\{/g) || []).length;
  return { out, before, after };
}

(async () => {
  // 1) 主前端
  for (const f of MAIN) {
    const p = path.join(DIST, "assets", f);
    const { out, before, after } = await transpile(p);
    fs.writeFileSync(p, out);
    console.log(`  ${f}: static{} ${before} -> ${after}, ${(out.length / 1024).toFixed(0)}KB`);
  }

  // 2) 所有客户端插件包
  const dirs = fs.readdirSync(NM).filter((n) => fs.existsSync(path.join(NM, n, "lib", "client.js")));
  let done = 0, skipped = 0, still = [];
  for (const d of dirs) {
    const p = path.join(NM, d, "lib", "client.js");
    const src = fs.readFileSync(p, "utf8");
    const before = (src.match(/static\s*\{/g) || []).length;
    if (before === 0) { skipped++; continue; }
    const { out, after } = await transpile(p);
    if (after > 0) { still.push(`${d}(${after})`); continue; }
    fs.writeFileSync(p, out);
    done++;
    console.log(`  plugin ${d}: static{} ${before} -> 0`);
  }
  console.log(`\n  插件包: 已转译 ${done}，无需处理 ${skipped}`);
  if (still.length) {
    console.log("  仍有残留（esbuild 拒绝降级）: " + still.join(", "));
  }
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
