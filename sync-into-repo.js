// 把工作区里「要发布」的内容同步进仓库目录。
//
// 设计要点：
//   · 发布清单显式列出，一眼看得出收了什么、没收录什么
//   · 敏感项（ngrok 令牌 / 签名私钥 / 日志 / exe）由代码排除，不靠人记性
//   · 每次同步都会打印「被安全规则挡下了什么」，便于发布前复核
//
// 用法：node sync-into-repo.js            （预演，只打印不写）
//       node sync-into-repo.js --write    （真的写）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工作区根：优先读环境变量，否则从本文件位置往上推。
// 别写死绝对路径 —— 别人 clone 下来改不动，也会把自己的目录名留在仓库里。
const REPO = path.dirname(fileURLToPath(import.meta.url));
const WS = process.env.MINGYUE_WS || path.dirname(REPO);
const WRITE = process.argv.includes('--write');

/** [工作区相对路径, 仓库内相对路径] */
const COPY = [
  // ---------- Android 应用 ----------
  ['手机端/app', 'android/app'],
  ['手机端/build-apk.ps1', 'android/build-apk.ps1'],

  // ---------- 电脑端网关 ----------
  ['手机端/网关/gateway.js', 'gateway/gateway.js'],
  ['手机端/网关/gateway-console.cs', 'gateway/gateway-console.cs'],
  ['手机端/网关/start-tunnel.js', 'gateway/start-tunnel.js'],
  ['手机端/网关/net-check.js', 'gateway/net-check.js'],
  ['手机端/网关/live-probe.js', 'gateway/live-probe.js'],
  ['手机端/网关/test-gateway.js', 'gateway/test-gateway.js'],
  ['手机端/网关/gateway.config.example.json', 'gateway/gateway.config.example.json'],
  ['手机端/网关/启动网关.cmd', 'gateway/启动网关.cmd'],
  ['手机端/网关/启动隧道.cmd', 'gateway/启动隧道.cmd'],
  ['手机端/网关/放行防火墙.cmd', 'gateway/放行防火墙.cmd'],
  ['手机端/网关/网络自检.cmd', 'gateway/网络自检.cmd'],
  ['手机端/网关/管理自检.ps1', 'gateway/管理自检.ps1'],
  ['手机端/网关/中继方案判定.ps1', 'gateway/中继方案判定.ps1'],

  // ---------- DSH 前端兼容层（脚本，不含被改的第三方产物）----------
  ['_buildtools/paths.py', 'compat/paths.py'],
  ['_buildtools/polyfills/legacy-polyfill.js', 'compat/legacy-polyfill.js'],
  ['_buildtools/polyfills/narrow-screen.css.js', 'compat/narrow-screen.css.js'],
  ['_buildtools/patch-gateway.py', 'compat/patch-gateway.py'],
  ['_buildtools/inline-polyfill.py', 'compat/inline-polyfill.py'],
  ['_buildtools/transpile-with-api.js', 'compat/transpile-with-api.js'],
  ['_buildtools/fix-static-blocks.py', 'compat/fix-static-blocks.py'],
  ['_buildtools/snapshot.py', 'compat/snapshot.py'],

  // ---------- 文档 ----------
  ['手机端/说明.md', 'docs/手机端使用说明.md'],
];

/** 绝不同步。命中即跳过并说明原因 —— 发布前的安全闸门。 */
const FORBIDDEN = [
  { re: /ngrok\.ya?ml$/i, why: '含 ngrok 认证令牌（账号凭据）' },
  { re: /gateway-console\.ini$/i, why: '控制台设置里存着 ngrok 令牌' },
  { re: /\.keystore$|\.jks$|\.p12$|\.pfx$/i, why: 'APK 签名私钥' },
  { re: /\.gateway-secret$/i, why: '网关会话签名密钥' },
  { re: /\.apk$|\.aab$|\.idsig$/i, why: '构建产物，走 Release 而不是源码库' },
  { re: /\.exe$/i, why: '二进制不入库（ngrok 是专有软件）' },
  { re: /\.log$/i, why: '运行时日志' },
  { re: /whale\.png$|鲸鱼娘\.png$/i, why: '第三方美术素材，不在 MIT 范围' },
  { re: /node_modules/i, why: '第三方依赖' },
  { re: /__pycache__/i, why: 'Python 缓存' },
];

function walk(src, rel, acc) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(src)) walk(path.join(src, e), path.join(rel, e), acc);
  } else {
    acc.push({ src, rel });
  }
}

function main() {
  if (!fs.existsSync(REPO)) {
    console.error('!! 仓库目录不存在: ' + REPO);
    process.exit(1);
  }
  let copied = 0;
  const blocked = [];

  for (const [from, to] of COPY) {
    const srcAbs = path.join(WS, from);
    if (!fs.existsSync(srcAbs)) {
      console.log(`  [缺] ${from}`);
      continue;
    }
    const acc = [];
    walk(srcAbs, '', acc);
    for (const f of acc) {
      const dstRel = path.join(to, f.rel);
      const hit = FORBIDDEN.find((x) => x.re.test(f.rel));
      if (hit) {
        blocked.push(`${dstRel}  <- ${hit.why}`);
        continue;
      }
      const dstAbs = path.join(REPO, dstRel);
      if (WRITE) {
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(f.src, dstAbs);
      }
      copied++;
      if (WRITE) console.log(`  [写] ${dstRel}`);
    }
  }

  console.log('');
  console.log(`  ${WRITE ? '已同步' : '将同步'} ${copied} 个文件`);
  if (blocked.length) {
    console.log(`  被安全规则挡下 ${blocked.length} 个：`);
    for (const b of blocked) console.log('    - ' + b);
  } else {
    console.log('  （没有文件被安全规则挡下）');
  }
  if (!WRITE) console.log('\n  预演模式，什么都没写。加 --write 才真正同步。');
}

main();
