/**
 * Fast tests for the gateway. The fake DSH below reproduces the real one's rules
 * (per-process launch token, 303 + authority-bound dsh-auth-* cookie, /api fence
 * that requires Host=loopback and Origin==Host), so a green run means the
 * gateway really interops rather than merely starting.
 *
 * usage: node test-gateway.js
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createGateway } from './gateway.js';

let passed = 0, failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok   ${name}`); })
    .catch((e) => { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); });
}

// ------------------------------------------------------------------ fake DSH

const LAUNCH_TOKEN = crypto.randomBytes(18).toString('base64url');
const SIGNING_SECRET = crypto.randomBytes(32);
const COOKIE_PREFIX = 'dsh-auth-';
/** Bumped to invalidate every outstanding DSH session (simulates a restart). */
let dshEpoch = 'e0';

function cookieNameFor(authority) {
  return COOKIE_PREFIX + crypto.createHash('sha256').update(authority).digest('base64url');
}

function makeCookie(authority) {
  const payload = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(`auth:${authority}:${dshEpoch}`).digest('base64url');
  return { name: cookieNameFor(authority), value: payload };
}

function makeFakeDsh() {
  const state = { upgradePaths: [], apiHosts: [], tokenTries: 0, port: 0 };
  /** The authority the real DSH would see once the gateway pins the Host. */
  const loopbackAuthority = () => `127.0.0.1:${state.port}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://dsh.invalid');
    const host = req.headers.host;

    // index auth: token query -> 303 + cookie
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.tokenTries++;
      if (url.searchParams.get('token') === LAUNCH_TOKEN) {
        const { name, value } = makeCookie(host);
        res.writeHead(303, {
          'set-cookie': `${name}=${value}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict`,
          location: '/',
        });
        res.end();
        return;
      }
      res.writeHead(401).end('unauthorized');
      return;
    }

    // every other page: cookie must match this exact authority and epoch
    const wantsCookie = cookieNameFor(host);
    const expected = makeCookie(host).value;
    const sent = (req.headers.cookie ?? '').split(';').map((s) => s.trim());
    const okCookie = sent.some((c) => c === `${wantsCookie}=${expected}`);

    if (url.pathname === '/api/ping') {
      state.apiHosts.push(host);
      // reproduces DSH's fence: loopback host, origin == host
      const originOk = !req.headers.origin || new URL(req.headers.origin).host === host;
      if (process.env.GW_DEBUG) {
        console.log('    [dsh] /api/ping host=%j origin=%j originOk=%s cookie=%j',
          host, req.headers.origin, originOk, req.headers.cookie);
      }
      if (host !== loopbackAuthority() || !originOk) {
        res.writeHead(403).end('fence');
        return;
      }
      if (!okCookie) { res.writeHead(401).end('needs session'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host }));
      return;
    }

    if (!okCookie) { res.writeHead(401).end('needs session'); return; }
    // Real DSH re-issues its authority-bound cookie on rendered pages; mirror
    // that so the "cookie reaches the client" path is genuinely exercised.
    const fresh = makeCookie(host);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `${fresh.name}=${fresh.value}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict; Secure`,
    });
    res.end(`<!doctype html><title>DSH</title><div id=app data-host="${host}">ok</div>`);
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://dsh.invalid');
    state.upgradePaths.push({ path: url.pathname, host: req.headers.host });
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write('hello-from-dsh');
  });

  return { server, state };
}

// ------------------------------------------------------------------- helpers

function request(port, path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawUpgrade(port, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      let raw = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
        + `Sec-WebSocket-Version: 13\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';
      socket.write(raw);
    });
    let data = '';
    socket.on('data', (d) => {
      data += d.toString('utf8');
      if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 3000);
  });
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function cookiePair(setCookie) {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first.split(';')[0];
}

// ---------------------------------------------------------------------- run

console.log('\ngateway tests\n');

const dsh = makeFakeDsh();
const dshPort = await listen(dsh.server);
dsh.state.port = dshPort;
const gw = createGateway({
  dsh: `http://127.0.0.1:${dshPort}`,
  secret: crypto.randomBytes(32).toString('base64url'),
  verbose: false,
});
const gwPort = await listen(gw.server);

// 1. unauthenticated HTTP
await check('unauthenticated request is refused with the login page', async () => {
  const r = await request(gwPort, '/');
  assert.equal(r.status, 401);
  assert.match(r.body, /需要访问令牌/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

// 2. unauthenticated upgrade
await check('unauthenticated WebSocket upgrade is refused', async () => {
  const raw = await rawUpgrade(gwPort, '/ws', {});
  assert.match(raw, /^HTTP\/1\.1 401/);
});

// 3. bad token
await check('a wrong token is rejected and does not sign you in', async () => {
  const r = await request(gwPort, '/?token=nope');
  assert.equal(r.status, 401);
  assert.match(r.body, /令牌不对/);
  assert.equal(r.headers['set-cookie'], undefined);
});

// 4. good token
let sessionCookieValue = null;
await check('the real token signs in, redirects clean, and sets both cookies', async () => {
  const r = await request(gwPort, `/?token=${LAUNCH_TOKEN}`, {
    headers: { origin: `http://127.0.0.1:${gwPort}` },
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  const list = r.headers['set-cookie'];
  assert.ok(list, 'expected cookies');
  const joined = (Array.isArray(list) ? list : [list]).join(' | ');
  assert.match(joined, /mingyue-gw=/, 'gateway session cookie');
  assert.match(joined, /dsh-auth-/, "DSH's own cookie should be forwarded too");
  assert.ok(!/;\s*Secure/i.test(joined), 'Secure must be stripped for plain-HTTP clients');
  sessionCookieValue = cookiePair(list);
});

// 5. token is scrubbed from the redirect target
await check('a token on a deep link is stripped from the redirect', async () => {
  const r = await request(gwPort, `/some/page?keep=1&token=${LAUNCH_TOKEN}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/some/page?keep=1');
  assert.ok(!String(r.headers.location).includes('token'));
});

// 6. session works end to end: the gateway holds a DSH session on our behalf
await check('a signed-in request reaches DSH with Host pinned to loopback', async () => {
  const r = await request(gwPort, '/', { headers: { cookie: sessionCookieValue } });
  assert.equal(r.status, 200);
  assert.match(r.body, /data-host="127\.0\.0\.1:\d+"/);
});

// 7. the /api fence still passes
await check('the /api fence accepts proxied calls (Host + Origin normalised)', async () => {
  const r = await request(gwPort, '/api/ping', {
    headers: {
      cookie: sessionCookieValue,
      origin: `http://127.0.0.1:${gwPort}`,
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, host: `127.0.0.1:${dshPort}` });
});

// 8. the DSH cookie reaches the client and comes back
await check("DSH's session cookie is forwarded to the client and accepted on return", async () => {
  const page = await request(gwPort, '/', { headers: { cookie: sessionCookieValue } });
  assert.equal(page.status, 200);
  const dshCookie = cookiePair(page.headers['set-cookie']);
  assert.match(dshCookie, /^dsh-auth-/);
  const api = await request(gwPort, '/api/ping', {
    headers: { cookie: `${sessionCookieValue}; ${dshCookie}`, origin: `http://127.0.0.1:${gwPort}` },
  });
  assert.equal(api.status, 200, 'DSH cookie should authenticate the /api call');
});

// 9. authenticated upgrade
await check('a signed-in WebSocket upgrade is proxied to DSH', async () => {
  const before = dsh.state.upgradePaths.length;
  const raw = await rawUpgrade(gwPort, '/ws', { Cookie: sessionCookieValue });
  assert.match(raw, /^HTTP\/1\.1 101/);
  assert.match(raw, /hello-from-dsh/);
  assert.equal(dsh.state.upgradePaths.length, before + 1);
  assert.equal(dsh.state.upgradePaths.at(-1).host, `127.0.0.1:${dshPort}`);
});

// 10. HTTP Basic sign-in with the launch token as the password.
// This is the mode the APK uses, so the gateway must complete the browser
// handshake on the phone's behalf.
await check('Basic auth with the launch token as password reaches the app', async () => {
  const basic = 'Basic ' + Buffer.from('phone:' + LAUNCH_TOKEN).toString('base64');
  const r = await request(gwPort, '/', { headers: { authorization: basic } });
  assert.equal(r.status, 200, 'Basic sign-in must work without any prior browser login');
  assert.match(r.body, /id=app/);
});

await check('Basic auth also passes the /api fence', async () => {
  const basic = 'Basic ' + Buffer.from('phone:' + LAUNCH_TOKEN).toString('base64');
  const r = await request(gwPort, '/api/ping', {
    headers: { authorization: basic, origin: `http://127.0.0.1:${gwPort}` },
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

await check('Basic auth with a wrong password is refused', async () => {
  const basic = 'Basic ' + Buffer.from('phone:wrong').toString('base64');
  const r = await request(gwPort, '/api/ping', { headers: { authorization: basic } });
  assert.equal(r.status, 401);
});

// 10b. a DSH session that died underneath must be re-established, not surfaced
await check('a stale DSH cookie triggers a re-handshake and a transparent retry', async () => {
  const basic = 'Basic ' + Buffer.from('phone:' + LAUNCH_TOKEN).toString('base64');
  const first = await request(gwPort, '/api/ping', {
    headers: { authorization: basic, origin: `http://127.0.0.1:${gwPort}` },
  });
  assert.equal(first.status, 200);
  assert.match(gw.ctx.dshCookie, /^dsh-auth-/);
  // the gateway still believes it holds a good session, but DSH has moved on
  dshEpoch = 'e1';
  const again = await request(gwPort, '/api/ping', {
    headers: { authorization: basic, origin: `http://127.0.0.1:${gwPort}` },
  });
  assert.equal(again.status, 200, 'the gateway should refresh and retry rather than leak the 401');
  assert.match(gw.ctx.dshCookie, /^dsh-auth-/);
});

// 11. a forged session cookie is refused
await check('a forged session cookie is refused', async () => {
  const forged = `mingyue-gw=${Date.now() + 1e9}.deadbeef`;
  const r = await request(gwPort, '/', { headers: { cookie: forged } });
  assert.equal(r.status, 401);
});

await check('an expired session cookie is refused', async () => {
  const expired = `mingyue-gw=${Date.now() - 1000}.${crypto.randomBytes(8).toString('hex')}`;
  const r = await request(gwPort, '/', { headers: { cookie: expired } });
  assert.equal(r.status, 401);
});

// 12. upstream down
await check('a dead DSH produces a 502, not a hang or a crash', async () => {
  const dead = makeFakeDsh();
  const deadPort = await listen(dead.server);
  await new Promise((r) => dead.server.close(r));
  const lonely = createGateway({
    dsh: `http://127.0.0.1:${deadPort}`,
    secret: 'x'.repeat(40),
    launchToken: LAUNCH_TOKEN,
  });
  const lonelyPort = await listen(lonely.server);
  const basic = 'Basic ' + Buffer.from('phone:' + LAUNCH_TOKEN).toString('base64');
  const r = await request(lonelyPort, '/', { headers: { authorization: basic } });
  assert.equal(r.status, 502);
  await new Promise((r2) => lonely.server.close(r2));
});

gw.server.close();
dsh.server.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
