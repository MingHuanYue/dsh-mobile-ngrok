// Live probe against the running gateway, using node's HTTP stack (this
// machine's schannel/curl TLS path is broken, and plain HTTP here is fine).
const http = require('http');

function req(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 3081, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const results = [];
  const t = (name, ok, detail) => { results.push({ name, ok, detail }); };

  // 1) no credentials at all
  const anon = await req('/');
  t('anonymous -> login page, not the agent',
    anon.status === 401 && /需要访问令牌/.test(anon.body),
    `status=${anon.status} bodyHasLogin=${/需要访问令牌/.test(anon.body)}`);

  // 2) wrong token
  const bad = await req('/?token=definitely-not-the-token');
  t('wrong token -> refused, no session cookie',
    bad.status === 401 && !bad.headers['set-cookie'],
    `status=${bad.status} setCookie=${bad.headers['set-cookie'] ?? 'none'}`);

  // 3) wrong Basic password
  const basicBad = await req('/', { authorization: 'Basic ' + Buffer.from('phone:nope').toString('base64') });
  t('wrong Basic password -> refused',
    basicBad.status === 401,
    `status=${basicBad.status}`);

  // 4) the gateway must never leak DSH's index to an unauthenticated caller
  t('unauthenticated response contains no DSH markup',
    !/id=app|__DSH_BOOT__/.test(anon.body),
    `leaked=${/id=app|__DSH_BOOT__/.test(anon.body)}`);

  // 5) upgrade path refuses anonymous sockets
  const upgrade = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: 3081, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'AAAA', 'Sec-WebSocket-Version': '13' } });
    r.on('upgrade', () => resolve('upgraded'));
    r.on('response', (res) => resolve('http ' + res.statusCode));
    r.on('error', (e) => resolve('error ' + e.message));
    r.end();
    setTimeout(() => resolve('timeout'), 3000);
  });
  t('anonymous websocket upgrade is not forwarded', upgrade.startsWith('http 401'), upgrade);

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}   [${r.detail}]`);
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('probe error:', e.message); process.exit(2); });
