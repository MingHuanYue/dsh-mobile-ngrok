/**
 * Starts the ngrok tunnel that puts the gateway on a public HTTPS URL.
 *
 * Why a tunnel: the phone is on mobile data and the PC is on a campus wired
 * network. They are on different networks, so the phone can never reach the
 * PC's LAN address - and campus networks block inbound traffic anyway. The PC
 * dials OUT to ngrok instead, and the phone opens the resulting URL.
 *
 * Everything stays in this folder (config included) so nothing is written to C:.
 *
 * usage:  node start-tunnel.js
 *         node start-tunnel.js --token <authtoken>     # save a token first
 *         node start-tunnel.js --port 3081
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NGROK = path.join(HERE, 'ngrok.exe');
// Keep the config beside the binary: the default lives in %LOCALAPPDATA% on C:,
// and this machine's C: is nearly full.
const CONFIG = path.join(HERE, 'ngrok.yml');

const line = (s = '') => console.log(s);
const ok = (s) => console.log(`  [ok]  ${s}`);
const warn = (s) => console.log(`  [!]   ${s}`);
const info = (s) => console.log(`  ${s}`);

function parseArgs(argv) {
  const out = { port: 3081 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token') out.token = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
  }
  return out;
}

function runNgrok(args) {
  const r = spawnSync(NGROK, ['--config', CONFIG, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim();
}

function hasToken() {
  try {
    return /authtoken\s*:/.test(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  line();
  line('='.repeat(62));
  line('  溟月 · 手机隧道（ngrok）');
  line('='.repeat(62));
  line();

  if (!fs.existsSync(NGROK)) {
    warn(`找不到 ngrok.exe（应该在 ${NGROK}）`);
    process.exit(1);
  }

  // ---- make sure the gateway itself is up ----
  const gw = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: args.port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(3000, () => { s.destroy(); resolve(false); });
  });
  if (!gw) {
    warn(`本地 ${args.port} 上没有网关在跑。`);
    info('先双击 启动网关.cmd（隧道只是把网关搬出去，它自己不会替你起网关）');
    process.exit(1);
  }
  ok(`本地网关在 ${args.port} 上，可以开隧道了`);

  // ---- token ----
  if (args.token) {
    const r = runNgrok(['config', 'add-authtoken', args.token]);
    if (r.code !== 0) {
      warn('写入令牌失败：');
      info(r.out.trim());
      process.exit(1);
    }
    ok('令牌已保存到本目录的 ngrok.yml');
  }

  if (!hasToken()) {
    line();
    warn('还没有 ngrok 令牌，必须先注册一个免费账号。');
    line();
    info('步骤：');
    info('  1. 电脑浏览器打开  https://dashboard.ngrok.com/signup');
    info('     （可以用 Google / GitHub 账号直接登录，不用填信用卡）');
    info('  2. 登录后打开     https://dashboard.ngrok.com/get-started/your-authtoken');
    info('  3. 复制那串 authtoken，粘到下面回车');
    line();
    const pasted = await ask('  令牌> ');
    if (!pasted) {
      warn('没给令牌，退出。');
      info('也可以之后运行：  node start-tunnel.js --token <你的令牌>');
      process.exit(1);
    }
    const r = runNgrok(['config', 'add-authtoken', pasted]);
    if (r.code !== 0) {
      warn('这个令牌被 ngrok 拒绝了：');
      info(r.out.trim());
      process.exit(1);
    }
    ok('令牌已保存');
  } else {
    ok('已有令牌，直接开隧道');
  }

  // ---- start the tunnel ----
  line();
  line('  正在建立隧道…');
  line('  起来之后会打印一行 Forwarding，形如：');
  line('      Forwarding  https://xxxx.ngrok-free.app -> http://localhost:3081');
  line();
  line('  把那个 https 网址填进手机的「电脑地址」即可（要带 https://）。');
  line('  这个窗口要一直开着 —— 关掉隧道就断了。');
  line();

  const child = spawn(NGROK, ['--config', CONFIG, 'http', String(args.port), '--log', 'stdout'], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('exit', (code) => {
    line();
    warn(`ngrok 退出了（code ${code}）`);
    process.exit(code ?? 0);
  });

  // Try to surface the public URL ourselves, since ngrok's own log is noisy.
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    if (tries > 40) { clearInterval(poll); return; }
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      const j = await res.json();
      const url = j?.tunnels?.[0]?.public_url;
      if (url) {
        clearInterval(poll);
        line();
        line('  ' + '='.repeat(58));
        line(`  手机填这个地址：  ${url}`);
        line('  ' + '='.repeat(58));
        line();
      }
    } catch { /* the local API comes up a moment after the tunnel does */ }
  }, 1000);
}

main().catch((e) => {
  console.error('隧道脚本出错了：', e.message);
  process.exit(1);
});
