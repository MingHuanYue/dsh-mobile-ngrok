/**
 * Network self-check for the phone gateway.
 *
 * Run via 网络自检.cmd, or directly:  node net-check.js
 *
 * Answers, with NO privileges and NO child processes:
 *   1. is the gateway listening at all?
 *   2. can this PC reach it over each of its own addresses?
 *   3. which address should the phone use, and is the firewall a suspect?
 *
 * Deliberately does not shell out. Under a DSH sandbox a program cannot capture
 * another program's output through a pipe (execFileSync comes back with
 * status=null and empty output), so anything based on `netsh` would silently
 * report nothing. Firewall state needs administrator rights and lives in
 * 管理自检.ps1 instead - run that one elevated when this script points at it.
 *
 * Lives in Node rather than the .cmd because cmd.exe shreds parentheses and
 * redirection inside `for /f`, and because non-ASCII output is safe from Node
 * but not from a batch file's parser.
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const PORT = Number(process.env.GW_PORT || 3081);

const line = (s = '') => console.log(s);
const ok = (s) => console.log(`  [ok]  ${s}`);
const warn = (s) => console.log(`  [!]   ${s}`);
const info = (s) => console.log(`  ${s}`);

/** Every non-internal IPv4 address, with its interface name. */
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4') out.push({ name, address: i.address, internal: i.internal });
    }
  }
  return out;
}

function connectable(host) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: PORT }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(3000, () => { s.destroy(); resolve(false); });
  });
}

function probe(address) {
  return new Promise((resolve) => {
    const req = http.request({ host: address, port: PORT, path: '/', method: 'GET' }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}

async function main() {
  line();
  line('='.repeat(62));
  line('  DSH 手机端 · 网关网络自检');
  line('='.repeat(62));

  // ---- 1. listening ----
  line();
  line(`--- 1. 网关端口 ${PORT} 有人在听吗 ---`);
  const listening = await connectable('127.0.0.1');
  if (listening) {
    ok(`${PORT} 上有服务在听（网关已经在跑）`);
  } else {
    warn(`${PORT} 上什么都没有 —— 这是手机连不上的第一位原因`);
    info('双击 启动网关.cmd 起网关，然后重新跑这个自检');
  }

  // ---- 2. self-reach ----
  const addrs = localAddresses();
  line();
  line('--- 2. 本机通过每个地址能不能连上自己的网关 ---');
  info('（401 = 连到了，只是在等令牌，这是正常状态）');
  const results = [];
  for (const a of addrs) {
    const r = await probe(a.address);
    const label = a.address.padEnd(18);
    const reached = r.status === 200 || r.status === 401;
    results.push({ ...a, reached });
    if (reached) {
      ok(`${label} HTTP ${r.status}${r.status === 401 ? '（等令牌，正常）' : ''}  [${a.name}]`);
    } else if (r.error) {
      warn(`${label} ${r.error}  [${a.name}]`);
    } else {
      warn(`${label} HTTP ${r.status}  [${a.name}]`);
    }
  }
  const lanReached = results.filter((r) => !r.internal && r.reached);

  // ---- 3. what to type ----
  line();
  line('--- 3. 手机上该填哪个地址 ---');
  const usable = results.filter((a) => !a.internal);
  if (usable.length === 0) {
    warn('没有找到局域网地址');
  } else {
    for (const a of usable) {
      const mark = a.reached ? '' : '   ← 本机都连不上，先起网关';
      line(`     http://${a.address}:${PORT}/     [${a.name}]${mark}`);
    }
  }

  // ---- 4. firewall ----
  line();
  line('--- 4. 防火墙 ---');
  if (!listening) {
    info('网关没跑，先不用管防火墙。');
  } else if (lanReached.length === 0) {
    warn('网关起来了，但一张局域网网卡都连不上 —— 先解决这个再看防火墙');
  } else {
    info('网关在跑，而且本机的局域网地址都能连上。');
    info('所以手机若还超时，只剩两种可能：');
    info('  a) 防火墙规则没覆盖手机所在网络的那个档（Private/Public）');
    info('  b) 这张 WiFi 禁止设备互访（公司/校园/访客网络极常见）');
    line();
    info('想知道是 a 还是 b，用管理员身份跑一次 管理自检.ps1 ——');
    info('它需要读防火墙和网络配置，普通权限读不到。');
  }

  // ---- 5. how to read it ----
  line();
  line('='.repeat(62));
  line('  怎么读这个结果');
  line('='.repeat(62));
  line();
  line('  手机说「拒绝」 → 网关没跑，或端口填错（要 3081，不是 3080）');
  line('  手机说「超时」 → 手机的包根本没到这台电脑，三种可能：');
  line('       a) 手机和电脑不在同一张网');
  line('       b) 这张 WiFi 开了客户端隔离（公司/校园/访客网极常见）。');
  line('          这时开防火墙也没用 —— 包在更外层就被丢了。');
  line('       c) 防火墙规则没覆盖这张网的档');
  line();
  line('  第 2 节全绿而手机仍超时，基本就是 b)。唯一的解法是让两台设备');
  line('  走一条点对点私有网络（Tailscale / ZeroTier / WireGuard），');
  line('  然后用那条网的地址，不要用 WiFi 地址。');
  line();
}

main().catch((e) => {
  console.error('自检脚本自己出错了：', e.message);
  process.exit(1);
});
