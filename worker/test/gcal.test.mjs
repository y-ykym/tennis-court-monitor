import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createJwt, pemToDer, fetchAccessToken, resetTokenCache, createGcalClient, GcalError, isGcalAuthError, SCOPE } from '../src/gcal.js';

// テスト用の鍵(毎回作る。本物の鍵は使わない)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = { GCAL_CLIENT_EMAIL: 'bot@example.iam.gserviceaccount.com', GCAL_PRIVATE_KEY: PEM };
const NOW = Date.parse('2026-10-08T03:00:00Z');

const b64uDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('gcal: JWT は RS256 で署名され、公開鍵で検証できる(iss・scope・aud・exp)', async () => {
  const jwt = await createJwt({ clientEmail: ENV.GCAL_CLIENT_EMAIL, privateKey: PEM, now: NOW });
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64uDecode(h).toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(b64uDecode(c).toString());
  assert.equal(claims.iss, ENV.GCAL_CLIENT_EMAIL);
  assert.equal(claims.scope, SCOPE);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.iat, Math.floor(NOW / 1000));
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.equal(v.verify(publicKey, b64uDecode(sig)), true);
});

test('gcal: 秘密鍵は改行が "\\n" のまま Secret に入っていても読める', async () => {
  const escaped = PEM.replace(/\n/g, '\\n');
  assert.deepEqual(pemToDer(escaped), pemToDer(PEM));
  const jwt = await createJwt({ clientEmail: 'x@y', privateKey: escaped, now: NOW });
  assert.equal(jwt.split('.').length, 3);
  assert.throws(() => pemToDer(''), /秘密鍵が空/);
});

test('gcal: アクセストークンは 1 回取ったら使い回し、失効が近ければ取り直す。400 invalid_grant は認証エラー扱い', async () => {
  resetTokenCache();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    return Response.json({ access_token: `tok${calls.length}`, expires_in: 3600 });
  };
  let r = await fetchAccessToken(ENV, { fetchFn, now: NOW });
  assert.deepEqual([r.token, r.cached], ['tok1', false]);
  assert.match(calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  r = await fetchAccessToken(ENV, { fetchFn, now: NOW + 10 * 60 * 1000 });
  assert.deepEqual([r.token, r.cached], ['tok1', true], '10 分後はまだ使い回す');
  r = await fetchAccessToken(ENV, { fetchFn, now: NOW + 59.5 * 60 * 1000 });
  assert.deepEqual([r.token, r.cached], ['tok2', false], '残り 60 秒を切ったら取り直す');
  // メールが変わったら(鍵を差し替えたら)取り直す
  r = await fetchAccessToken({ ...ENV, GCAL_CLIENT_EMAIL: 'other@x' }, { fetchFn, now: NOW });
  assert.equal(r.cached, false);

  resetTokenCache();
  const bad = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(fetchAccessToken(ENV, { fetchFn: bad, now: NOW }), (e) => e instanceof GcalError && e.status === 401 && isGcalAuthError(e));
});

test('gcal: 一覧はボットの目印で絞り、ページをまたいで集める。削除の 404/410 は「もう無い」として成功扱い。通信回数を数える', async () => {
  resetTokenCache();
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
    const u = new URL(url);
    if (init.method === 'GET') {
      assert.equal(u.searchParams.get('privateExtendedProperty'), 'tennisBot=1');
      assert.equal(u.searchParams.get('singleEvents'), 'true');
      assert.equal(u.searchParams.get('timeMin'), '2026-10-08T00:00:00+09:00');
      if (!u.searchParams.get('pageToken')) return Response.json({ items: [{ id: 'e1' }], nextPageToken: 'p2' });
      return Response.json({ items: [{ id: 'e2' }] });
    }
    if (init.method === 'DELETE') {
      if (u.pathname.endsWith('/gone')) return new Response('', { status: 410 });
      if (u.pathname.endsWith('/missing')) return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 });
      if (u.pathname.endsWith('/forbidden')) return Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status: 403 });
      return new Response(null, { status: 204 });
    }
    if (init.method === 'POST') return Response.json({ id: 'new', ...JSON.parse(init.body) });
    if (init.method === 'PATCH') return Response.json({ id: u.pathname.split('/').pop() });
    throw new Error(`unexpected ${init.method}`);
  };
  const gcal = createGcalClient({ ...ENV }, { fetchFn, now: () => NOW });
  const items = await gcal.listBotEvents('a@gmail.com', { timeMin: '2026-10-08T00:00:00+09:00' });
  assert.deepEqual(items.map((i) => i.id), ['e1', 'e2']);
  assert.equal(gcal.calls, 3, 'トークン 1 + 一覧 2 ページ');
  assert.equal(seen[1].url.includes('/calendars/a%40gmail.com/events'), true, 'カレンダー ID は URL エンコード');

  assert.equal(await gcal.remove('a@gmail.com', 'ok'), true);
  assert.equal(await gcal.remove('a@gmail.com', 'gone'), false);
  assert.equal(await gcal.remove('a@gmail.com', 'missing'), false);
  await assert.rejects(gcal.remove('a@gmail.com', 'forbidden'), (e) => isGcalAuthError(e) && e.status === 403);
  const ins = await gcal.insert('a@gmail.com', { summary: 's' });
  assert.equal(ins.id, 'new');
  const pat = await gcal.patch('a@gmail.com', 'e1', { summary: 's2' });
  assert.equal(pat.id, 'e1');
  assert.equal(gcal.calls, 3 + 4 + 1 + 1, 'トークンは使い回すので以後は 1 通信 = 1 回');
});
