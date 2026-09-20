#!/usr/bin/env node
/**
 * mingyue-dsh-gateway
 * -------------------
 * Lets a phone reach a localhost-only DSH Web GUI without weakening DSH.
 *
 * Why this exists: `dsh web` refuses `--host 0.0.0.0` on purpose - binding the
 * agent to the network would expose remote code execution. So DSH keeps
 * listening on 127.0.0.1 and this gateway is the only thing that faces the LAN.
 *
 * How it protects the agent:
 *   1. A signed-in check runs on EVERY request and every WebSocket upgrade
 *      before anything is forwarded. Unsigned-in traffic gets a login page.
 *   2. Sign-in is either HTTP Basic (the app just keeps credentials - see the
 *      APK settings) or one visit to /?token=<the token `dsh web` printed>,
 *      which is validated against DSH itself and then exchanged for a signed
 *      gateway cookie.
 *   3. Forwarding is transparent: DSH's own authority-bound session cookie is
 *      passed through, only Host/Origin are pinned to what DSH expects, so
 *      DSH's browser-trust fence and cookie binding keep working unchanged.
 *
 * usage: node gateway.js [--port 3081] [--dsh http://127.0.0.1:3080] [--host 0.0.0.0]
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'gateway.config.json');
const SECRET_PATH = path.join(HERE, '.gateway-secret');
const COOKIE_NAME = 'mingyue-gw';
const SESSION_DAYS = 30;

// --------------------------------------------------------------------- config

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--dsh') out.dsh = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadConfig(cli) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* first run */ }
  return {
    host: cli.host ?? file.host ?? '0.0.0.0',
    port: cli.port ?? file.port ?? 3081,
    dsh: cli.dsh ?? file.dsh ?? 'http://127.0.0.1:3080',
  };
}

function loadSecret() {
  try {
    const existing = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* generate below */ }
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  } catch (e) {
    console.error(`gateway: could not persist the session secret (${e.message}); sessions end when this stops`);
  }
  return secret;
}

// ------------------------------------------------------------------- sessions

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function mintSession(secret) {
  const expiresAt = Date.now() + SESSION_DAYS * 86400000;
  return `${expiresAt}.${hmac(String(expiresAt), secret)}`;
}

function sessionValid(cookieHeader, secret) {
  if (!cookieHeader) return false;
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== COOKIE_NAME) continue;
    const raw = segment.slice(at + 1).trim();
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return false;
    const payload = raw.slice(0, dot);
    const mac = raw.slice(dot + 1);
    const expected = hmac(payload, secret);
    if (mac.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
    const expiresAt = Number(payload);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }
  return false;
}

const sessionCookie = (value) =>
  `${COOKIE_NAME}=${value}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax`;

/** Decode Basic credentials; returns {user, pass} or null. */
function basicCredentials(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    if (at === -1) return null;
    return { user: decoded.slice(0, at), pass: decoded.slice(at + 1) };
  } catch {
    return null;
  }
}

/** The launch token is the shared secret for Basic sign-in; a browser/WebView
 *  is not prompted for Basic, so any username is accepted and ignored. */
function authorized(req, ctx) {
  if (sessionValid(req.headers.cookie, ctx.secret)) return true;
  const creds = basicCredentials(req.headers.authorization);
  if (creds && ctx.launchToken && constantTimeEqual(creds.pass, ctx.launchToken)) return true;
  return false;
}

// ------------------------------------------------------------------ login page

function loginPage({ badToken = false } = {}) {
  const title = badToken ? '令牌不对' : '需要访问令牌';
  const lead = badToken
    ? 'DSH 拒绝了这个令牌。想想是不是电脑上的 DSH 重启过——重启会换新令牌。'
    : '这个网关不是开放的。把电脑上 <code>dsh web</code> 启动时打印的地址里 <code>token=</code> 后面那一串填进来，或者直接打开带令牌的完整地址。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 手机端 · ${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0A1220; color:#E8F1F8; font:15px/1.7 -apple-system,"Noto Sans SC",sans-serif; padding:24px; }
  .card { width:100%; max-width:420px; background:#141F33; border-radius:16px; padding:22px; }
  h1 { font-size:19px; margin:0 0 8px; }
  p { color:#8FA6BF; font-size:13px; margin:0 0 16px; }
  input { width:100%; box-sizing:border-box; height:48px; padding:0 12px; border-radius:12px;
          border:1px solid #2E6B7E; background:#0E1B2E; color:#E8F1F8; font-size:14px; }
  button { width:100%; height:48px; margin-top:12px; border:0; border-radius:12px;
           background:#7FD1E8; color:#0A1220; font-size:15px; font-weight:600; }
  code { color:#7FD1E8; word-break:break-all; }
</style></head>
<body><div class="card">
  <h1>${title}</h1>
  <p>${lead}</p>
  <form method="get" action="/">
    <input name="token" placeholder="粘贴令牌" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button type="submit">连接</button>
  </form>
</div></body></html>`;
}

function sendHtml(res, status, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(buf);
}

// ------------------------------------------------------------- token exchange

/**
 * Perform DSH's launch-token handshake and return its session cookie.
 * DSH answers `/?token=<launchToken>` with 303 + an authority-bound
 * `dsh-auth-*` cookie, so a successful exchange is the token check itself.
 */
async function exchangeToken(dshUrl, token) {
  const target = new URL(dshUrl);
  target.pathname = '/';
  target.search = '';
  target.searchParams.set('token', token);
  const res = await fetch(target, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'text/html' },
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith('dsh-auth-'));
  if (res.status !== 303 || session === undefined) return null;
  return { pair: session.split(';')[0], setCookie: session };
}

// ------------------------------------------------------------------ the gateway

export function createGateway({ dsh, secret, launchToken = null, verbose = false }) {
  const dshUrl = new URL(dsh);
  const log = (...a) => { if (verbose) console.log('[gw]', ...a); };
  const ctx = { secret, launchToken, dshCookie: null, refreshing: null };

  /**
   * Ensure we hold a usable DSH session cookie. Safe to await concurrently:
   * parallel misses share one handshake.
   */
  async function ensureDshCookie() {
    if (ctx.dshCookie !== null) return ctx.dshCookie;
    if (ctx.launchToken === null) return null;
    if (ctx.refreshing === null) {
      ctx.refreshing = exchangeToken(dshUrl, ctx.launchToken)
        .then((result) => {
          if (result === null) {
            log('DSH rejected the held launch token; forgetting it');
            ctx.launchToken = null;
            return null;
          }
          ctx.dshCookie = result.pair;
          return result.pair;
        })
        .catch((e) => { log('handshake failed:', e.message); return null; })
        .finally(() => { ctx.refreshing = null; });
    }
    return ctx.refreshing;
  }

  const dropDshCookie = () => { ctx.dshCookie = null; };

  /** Copy request headers, pinning everything DSH's fences care about. */
  function forwardHeaders(req, extraCookie) {
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    headers.host = dshUrl.host;

    const cookies = [];
    if (extraCookie) cookies.push(extraCookie);
    if (headers.cookie) {
      for (const c of headers.cookie.split(';')) {
        const t = c.trim();
        if (t === '' || t.startsWith(`${COOKIE_NAME}=`)) continue;
        cookies.push(t);
      }
    }
    if (cookies.length) headers.cookie = cookies.join('; ');
    else delete headers.cookie;

    // DSH rejects cross-site /api calls and requires Origin == Host, but the
    // phone's origin differs by port, so normalise both to DSH's own origin.
    if (headers.origin) headers.origin = `${dshUrl.protocol}//${dshUrl.host}`;
    if (headers.referer) {
      try {
        const r = new URL(headers.referer);
        headers.referer = `${dshUrl.protocol}//${dshUrl.host}${r.pathname}${r.search}`;
      } catch { /* leave as-is */ }
    }
    headers['sec-fetch-site'] = 'same-origin';
    return headers;
  }

  const server = http.createServer(async (req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://${req.headers.host ?? 'gateway'}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // ---- sign in with a launch token, once ----
    const token = requestUrl.searchParams.get('token');
    if (token) {
      let handshake = null;
      try {
        handshake = await exchangeToken(dshUrl, token);
      } catch (e) {
        log('token exchange failed:', e.message);
        sendHtml(res, 502, '<h1>DSH 没应答</h1><p>确认电脑上的 dsh web 还在运行。</p>');
        return;
      }
      if (handshake === null) {
        log('token rejected by DSH');
        sendHtml(res, 401, loginPage({ badToken: true }));
        return;
      }
      ctx.launchToken = token;
      ctx.dshCookie = handshake.pair;
      requestUrl.searchParams.delete('token');
      const rest = requestUrl.searchParams.toString();
      const location = requestUrl.pathname + (rest ? `?${rest}` : '');
      res.writeHead(303, {
        location,
        // Ours gates the LAN; DSH's is forwarded so the phone's own requests
        // carry a real DSH session too.
        'set-cookie': [
          sessionCookie(mintSession(secret)),
          handshake.setCookie.replace(/;\s*Secure/gi, ''),
        ],
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end();
      return;
    }

    // ---- everything else needs a signed-in identity ----
    if (!authorized(req, ctx)) {
      sendHtml(res, 401, loginPage());
      return;
    }

    // Hold a DSH session on the phone's behalf. This is what makes plain
    // Basic sign-in usable: the phone never performs the browser handshake,
    // so the gateway does it and injects the cookie.
    await ensureDshCookie();

    /** Send the request upstream; on a DSH 401, refresh once and retry. */
    function forward(dshCookie, retrying) {
      const upstream = http.request(
        {
          host: dshUrl.hostname,
          port: Number(dshUrl.port || 80),
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req, dshCookie),
        },
        (up) => {
          if (up.statusCode === 401 && dshCookie !== null && !retrying) {
            up.resume();
            dropDshCookie();
            ensureDshCookie()
              .then((fresh) => {
                if (fresh === null) { res.writeHead(401).end('DSH session expired'); return; }
                forward(fresh, true);
              })
              .catch(() => res.writeHead(401).end('DSH session expired'));
            return;
          }
          const outHeaders = { ...up.headers };
          delete outHeaders['transfer-encoding'];
          if (outHeaders['set-cookie']) {
            // Plain HTTP to the phone: a Secure cookie would never come back.
            const list = Array.isArray(outHeaders['set-cookie']) ? outHeaders['set-cookie'] : [outHeaders['set-cookie']];
            outHeaders['set-cookie'] = list.map((c) => c.replace(/;\s*Secure/gi, ''));
          }
          // 给静态资源补缓存头。
          //
          // 为什么必须在这里补：实测 DSH 的前端服务对 /assets/ 只返回
          // content-type / transfer-encoding / vary，【没有 Cache-Control、
          // 没有 ETag、也没有 Last-Modified】。浏览器因此无法判断资源有没有变过，
          // 也发不了条件请求，于是每次加载都完整重下一遍。
          //
          // 一次冷加载约 1.17 MB（主资源 380KB + 插件包 804KB），
          // 手机走 ngrok 隧道，这些流量全都要算额度。曾有用户一天用掉 447 MB。
          //
          // 三类资源都带版本标识，可以放心长期缓存：
          //   /assets/index-BKQ_L1z6.js  文件名里的哈希是构建时算的，内容变名字就变
          //   /plugins/...client.js&rev=7aa91ea0e9fb   rev 变了才算新版本
          //   /dsh-whale/...             挂件的图片/脚本/音效，基本不变
          // 首页 HTML 绝对不能缓存（它引用带哈希的资源名），/api 也不能。
          //
          // 实测数据（真机 CDP 抓的）：一次冷启动整页 0.91 MB，其中
          //   /dsh-whale/image.png      250 KB   ← 同一张图还下了两遍
          //   /dsh-whale/widget.js      206 KB
          //   /dsh-whale/rua.gif         92 KB
          // 挂件占了 88%，而 DSH 自身资源加了缓存头之后已经是 0 传输。
          // DSH 给 /dsh-whale/ 发的是 no-store（严禁缓存），这里覆盖掉。
          if (up.statusCode === 200 && (req.method === 'GET' || req.method === 'HEAD')) {
            const p = (req.url || '').split('?')[0];
            if (p.startsWith('/assets/')) {
              outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
            } else if (p.startsWith('/plugins/')) {
              outHeaders['cache-control'] = 'public, max-age=604800';
            } else if (p.startsWith('/dsh-whale/')) {
              // 图片/脚本/音效都不常变；用 30 天，够省流量又不怕过期太久
              outHeaders['cache-control'] = 'public, max-age=2592000';
              delete outHeaders['etag'];
            }
          }
          res.writeHead(up.statusCode ?? 502, outHeaders);
          up.pipe(res);
        },
      );

      upstream.on('error', (e) => {
        log('upstream error:', e.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`DSH is not answering on ${dsh} - is it still running?`);
        } else {
          res.destroy();
        }
      });

      req.pipe(upstream);
    }

    forward(ctx.dshCookie, false);
  });

  // ---- WebSocket / live-stream upgrades: same gate, then a raw pipe ----
  server.on('upgrade', async (req, socket, head) => {
    if (!authorized(req, ctx)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const dshCookie = await ensureDshCookie();
    const headers = forwardHeaders(req, dshCookie);
    const upstream = net.connect(
      { host: dshUrl.hostname, port: Number(dshUrl.port || 80) },
      () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      },
    );
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return { server, ctx };
}

// --------------------------------------------------------------------------- cli

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(`mingyue-dsh-gateway

  --port <n>     port to listen on (default 3081)
  --host <addr>  bind address (default 0.0.0.0, i.e. the LAN)
  --dsh <url>    the local DSH Web GUI (default http://127.0.0.1:3080)

Start DSH first, then run this and paste the token dsh web printed.
On the phone, either open http://<lan-ip>:<port>/?token=<token> once, or set
that token as the password in the app's settings (username is ignored).`);
    process.exit(0);
  }

  const cfg = loadConfig(cli);
  const secret = loadSecret();
  const { server, ctx } = createGateway({ dsh: cfg.dsh, secret, verbose: !process.env.MINGYUE_QUIET });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`gateway: port ${cfg.port} is already in use. Pass --port <other>.`);
    } else {
      console.error('gateway:', e.message);
    }
    process.exit(1);
  });

  // Prove DSH is actually there before claiming to be ready.
  try {
    const probe = await fetch(cfg.dsh, { redirect: 'manual' });
    if (probe.status < 100) throw new Error('unexpected status');
  } catch {
    console.error(`gateway: nothing is answering at ${cfg.dsh} - start DSH first (Start-DSH.cmd).`);
    process.exit(1);
  }

  const addrs = localAddresses();
  console.log('');
  console.log('  DSH 手机端 · DSH 手机网关');
  console.log('  --------------------------------------------------');
  console.log(`  DSH      : ${cfg.dsh}`);
  console.log(`  listening: ${cfg.host}:${cfg.port}`);

  // 交互提示只有在「确实有人在终端前能回答」时才显示。
  //
  // 这里踩过一个坑：原来只判断 process.stdin.isTTY，结果被 GUI 启动时
  // 子进程继承了父进程的终端，isTTY 为真 —— 但那个提示在子进程里没人看得见，
  // 于是网关永远卡在 await ask()，永远不开始监听端口。界面显示「没运行」是对的。
  //
  // 所以再加两个条件：
  //   1. --no-prompt 时绝不出提示（GUI 启动时会带上它）
  //   2. 输出必须是 TTY：只有在自己窗口里跑（双击 .cmd）才需要提示
  const wantPrompt = process.stdin.isTTY
    && process.stdout.isTTY
    && !process.argv.includes('--no-prompt');

  if (wantPrompt) {
    console.log('');
    console.log('  把电脑上 dsh web 启动时打印的那串 token 粘进来（直接回车可跳过，');
    console.log('  之后用带 ?token= 的地址登录也行）：');
    const pasted = await ask('  token> ');
    if (pasted) {
      const handshake = await exchangeToken(new URL(cfg.dsh), pasted).catch(() => null);
      if (handshake) {
        ctx.launchToken = pasted;
        ctx.dshCookie = handshake.pair;
        console.log('  ✓ 令牌有效，手机上直接填这个地址就能进：');
      } else {
        console.log('  ✗ 这个令牌 DSH 不认，稍后用带 ?token= 的地址登录，或者重跑一次。');
      }
    }
  }

  if (addrs.length) {
    console.log('');
    for (const a of addrs) console.log(`  手机地址 : http://${a}:${cfg.port}`);
  } else {
    console.log('  手机地址 : 没检测到局域网地址，检查一下网络');
  }
  console.log('');
  console.log('  网关只放行握过令牌的设备，DSH 本身仍然只听 127.0.0.1。');
  console.log('  按 Ctrl+C 停止。');
  console.log('');

  server.listen(cfg.port, cfg.host, () => { /* banner already printed */ });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\ngateway: stopping');
      server.close(() => process.exit(0));
    });
  }
}
