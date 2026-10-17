import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenewalConfirmationUrl, inspectRenewalConfirmation, confirmRenewal, cleanupRenewalConfirmations } from '../src/services/renewalConfirmation.js';
import { handleRenewalConfirmation } from '../src/handlers/renewal.js';
import { checkExpiringServers, sendNotification } from '../src/services/notification.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache, DEFAULT_NOTIFICATION_TEMPLATE, normalizeNotificationSiteUrl, normalizeNotificationTemplate } from '../src/utils/settings.js';
import { addBillingCycleToDate } from '../src/utils/serverBilling.js';
import worker from '../src/index.js';

// Execute the production SQL against SQLite, including transactions and JSON
// predicates. Node 18/20 can still run the rest of the suite without node:sqlite.
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'Requires Node 22+ with node:sqlite' }, fn);
const NOW = Date.parse('2026-10-17T08:00:00Z');
const DAY_MS = 86400000;
const SETTINGS = {
  jwt_secret: 'a'.repeat(64), notification_site_url: 'https://monitor.example.com',
  notification_timezone: 'Asia/Shanghai', notification_language: 'zh', expire_reminder: '7',
  tg_bot_token: '123:abc', tg_chat_id: '42'
};

function fixture(overrides = {}, settings = {}) {
  clearServersListCache();
  clearSiteSettingsCache();
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, expire_date TEXT, billing_cycle TEXT,
      auto_renewal TEXT, price TEXT, sort_order INTEGER DEFAULT 0);`);
  const server = { id: 'srv-1', name: '测试服务器', expire_date: '2026-10-20', billing_cycle: 'month', auto_renewal: '0', price: '10.00', ...overrides };
  const insertServer = row => sqlite.prepare('INSERT INTO servers (id, name, expire_date, billing_cycle, auto_renewal, price) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name, row.expire_date, row.billing_cycle, row.auto_renewal, row.price);
  insertServer(server);
  const siteSettings = { ...SETTINGS, ...settings };
  sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('site_options', JSON.stringify(siteSettings));
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return this.execute(); },
        execute() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {
    db, sqlite, server, settings: siteSettings,
    addServer(overrides) { insertServer({ ...server, ...overrides }); },
    async issue(now = NOW) {
      return new URL(await createRenewalConfirmationUrl(db, server, siteSettings, now)).searchParams.get('token');
    },
    expiration() { return sqlite.prepare('SELECT expire_date FROM servers').get().expire_date; }
  };
}

test('monitor URL accepts only an http(s) origin', () => {
  assert.equal(normalizeNotificationSiteUrl(' https://monitor.example.com/ '), 'https://monitor.example.com');
  assert.equal(normalizeNotificationSiteUrl('http://localhost:8787'), 'http://localhost:8787');
  for (const value of ['', 'not a url', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=abc', 'https://example.com/#admin']) {
    assert.equal(normalizeNotificationSiteUrl(value), '');
  }
});

test('manual renewal advances exactly one calendar cycle and clamps month ends', () => {
  assert.equal(addBillingCycleToDate('2027-01-31', 'month'), '2027-02-28');
  assert.equal(addBillingCycleToDate('2024-02-29', 'year'), '2025-02-28');
  assert.equal(addBillingCycleToDate('2026-10-31', 'quarter'), '2027-01-31');
});

test('the previous default template gains the renewal list while custom templates stay unchanged', () => {
  assert.equal(normalizeNotificationTemplate('{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n{{time}}'), DEFAULT_NOTIFICATION_TEMPLATE);
  assert.match(DEFAULT_NOTIFICATION_TEMPLATE, /\{\{renewal_links\}\}/);
  assert.equal(normalizeNotificationTemplate('Details: {{message}}'), 'Details: {{message}}');
});

sqliteTest('GET previews the dates without renewing; POST redirects and replay is idempotent', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const f = fixture({ name: '<script>alert(1)</script>' });
  const token = await f.issue();
  const url = `https://monitor.example.com/renew?token=${token}`;
  let response = await handleRenewalConfirmation(new Request(url), { DB: f.db });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(f.expiration(), '2026-10-20');
  assert.match(html, /2026-11-20/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /min-height:52px/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const submit = () => handleRenewalConfirmation(new Request('https://monitor.example.com/renew', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token })
  }), { DB: f.db });
  response = await submit();
  assert.equal(response.status, 303);
  assert.equal(f.expiration(), '2026-11-20');
  assert.equal((await submit()).status, 303);
  assert.equal(f.expiration(), '2026-11-20');
  response = await handleRenewalConfirmation(new Request(url), { DB: f.db });
  assert.match(await response.text(), /续费已确认/);
});

sqliteTest('concurrent submissions using the same or different reminder tokens advance only once', async () => {
  const f = fixture();
  const first = await f.issue();
  const second = await f.issue();
  const results = await Promise.all([first, first, second, second].map(token => confirmRenewal(f.db, token, f.settings, NOW)));
  assert.equal(f.expiration(), '2026-11-20');
  assert.ok(results.every(result => ['confirmed', 'changed'].includes(result.state)));
  assert.ok(['confirmed', 'changed'].includes((await confirmRenewal(f.db, second, f.settings, NOW)).state));
  assert.equal(f.expiration(), '2026-11-20');
});

sqliteTest('Worker serves the confirmation page on a private site with Turnstile and a custom theme', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const f = fixture({}, { is_public: 'false', turnstile_enabled: 'true', theme_url: 'https://invalid.example/theme' });
  const token = await f.issue();
  const response = await worker.fetch(new Request(`https://monitor.example.com/renew?token=${token}`), { DB: f.db, API_SECRET: 'test-secret' }, {});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /已完成续费，更新到期日期/);
  assert.equal(f.expiration(), '2026-10-20');
});

sqliteTest('early confirmation is refused until the configured window, using the notification timezone', async () => {
  const f = fixture({ expire_date: '2026-10-23' });
  const token = await f.issue();
  assert.equal((await confirmRenewal(f.db, token, f.settings, NOW)).state, 'early');
  assert.equal(f.expiration(), '2026-10-23');
  // Shanghai has already reached Oct 18 while UTC is still Oct 17.
  assert.equal((await confirmRenewal(f.db, token, f.settings, Date.parse('2026-10-17T16:00:00Z'))).state, 'confirmed');
  assert.equal(f.expiration(), '2026-11-23');
  const short = fixture({ expire_date: '2026-10-20' }, { expire_reminder: '2' });
  assert.equal((await confirmRenewal(short.db, await short.issue(), short.settings, NOW)).state, 'early');
});

sqliteTest('invalid, expired and disabled links cannot renew', async () => {
  const f = fixture();
  const token = await f.issue();
  for (const invalid of ['', 'bad', '0'.repeat(64)]) {
    assert.equal((await confirmRenewal(f.db, invalid, f.settings, NOW)).state, 'invalid');
  }
  assert.equal((await confirmRenewal(f.db, token, f.settings, NOW + 7 * DAY_MS)).state, 'expired');
  assert.equal((await confirmRenewal(f.db, token, { ...f.settings, expire_reminder: '0' }, NOW)).state, 'disabled');
  assert.equal((await confirmRenewal(f.db, token, { ...f.settings, notification_site_url: '' }, NOW)).state, 'disabled');
  assert.equal(f.expiration(), '2026-10-20');
  await cleanupRenewalConfirmations(f.db, NOW + 7 * DAY_MS);
  assert.equal((await inspectRenewalConfirmation(f.db, token, f.settings, NOW)).state, 'invalid');
  assert.ok(f.sqlite.prepare("SELECT value FROM settings WHERE key = 'site_options'").get());
});

sqliteTest('the confirmation window counts local calendar days across daylight saving changes', async () => {
  const f = fixture({ expire_date: '2026-03-13' }, { notification_timezone: 'America/New_York' });
  const beforeDst = Date.parse('2026-03-07T23:30:00-05:00');
  const token = await f.issue(beforeDst);
  assert.equal((await confirmRenewal(f.db, token, f.settings, beforeDst)).state, 'early');
  assert.equal(f.expiration(), '2026-03-13');
  const nextDay = Date.parse('2026-03-08T00:30:00-05:00');
  assert.equal((await confirmRenewal(f.db, token, f.settings, nextDay)).state, 'confirmed');
});

sqliteTest('expiry, billing and automatic renewal changes invalidate outstanding links', async () => {
  for (const [field, value] of [['expire_date', '2026-11-20'], ['billing_cycle', 'year'], ['price', '20.00'], ['auto_renewal', '1']]) {
    const f = fixture();
    const token = await f.issue();
    f.sqlite.prepare(`UPDATE servers SET ${field} = ?`).run(value);
    assert.equal((await confirmRenewal(f.db, token, f.settings, NOW)).state, 'changed');
    assert.equal(f.expiration(), field === 'expire_date' ? value : '2026-10-20');
  }
});

sqliteTest('SQL guards reject a server edit between inspection and the transactional update', async () => {
  const f = fixture();
  const token = await f.issue();
  const originalBatch = f.db.batch;
  f.db.batch = statements => {
    f.sqlite.prepare("UPDATE servers SET expire_date = '2026-12-20'").run();
    return originalBatch(statements);
  };
  assert.equal((await confirmRenewal(f.db, token, f.settings, NOW)).state, 'changed');
  assert.equal(f.expiration(), '2026-12-20');
});

sqliteTest('a failed token update rolls back the expiration change', async () => {
  const f = fixture();
  const token = await f.issue();
  f.sqlite.exec(`CREATE TRIGGER fail_token_update BEFORE UPDATE ON settings
    BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  await assert.rejects(confirmRenewal(f.db, token, f.settings, NOW), /simulated failure/);
  assert.equal(f.expiration(), '2026-10-20');
});

sqliteTest('a used token remains consumed even if an admin restores the old expiration', async () => {
  const f = fixture();
  const token = await f.issue();
  await confirmRenewal(f.db, token, f.settings, NOW);
  f.sqlite.prepare("UPDATE servers SET expire_date = '2026-10-20'").run();
  assert.equal((await confirmRenewal(f.db, token, f.settings, NOW)).state, 'confirmed');
  assert.equal(f.expiration(), '2026-10-20');
});

sqliteTest('expiration reminders include a working confirmation link, including on the expiration day', async t => {
  for (const expireDate of ['2026-10-20', '2026-10-17']) {
    const f = fixture({ expire_date: expireDate });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true };
    });
    assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
    assert.equal(requests.length, 1);
    const link = requests[0].text.match(/https:\/\/monitor\.example\.com\/renew\?token=[a-f0-9]{64}/)?.[0];
    assert.ok(link);
    const token = new URL(link).searchParams.get('token');
    assert.equal((await confirmRenewal(f.db, token, f.settings, NOW)).state, 'confirmed');
    assert.equal(f.expiration(), addBillingCycleToDate(expireDate, 'month'));
    t.mock.restoreAll();
  }
});

sqliteTest('automatic renewal keeps its behavior and does not issue manual confirmation tokens', async t => {
  const f = fixture({ auto_renewal: '1' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(f.expiration(), '2026-11-20');
  assert.equal(requests.length, 1);
  assert.match(requests[0].text, /自动续费成功/);
  assert.doesNotMatch(requests[0].text, /\/renew\?/);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key GLOB 'renewal_confirmation:*'").get().n, 0);
});

sqliteTest('without a site URL reminders still work without confirmation links', async t => {
  const f = fixture({}, { notification_site_url: '' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].text, /\/renew\?/);
  assert.equal(f.expiration(), '2026-10-20');
});

sqliteTest('renewal_links places named links in the template and keeps multiple servers grouped', async t => {
  const f = fixture({}, { notification_template: 'Details:\n{{message}}\nConfirm:\n{{ renewal_links }}\nCount: {{count}}' });
  f.addServer({ id: 'srv-2', name: '第二台服务器' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(requests.length, 1);
  const text = requests[0].text;
  const [details, links] = text.split('\nConfirm:\n');
  assert.match(details, /测试服务器/);
  assert.match(details, /第二台服务器/);
  assert.doesNotMatch(details, /https:|token=/);
  assert.match(links, /Count: 2$/);
  const namedLinks = [...links.matchAll(/([^\n]+): (https:\/\/monitor\.example\.com\/renew\?token=[a-f0-9]{64})/g)];
  assert.equal(namedLinks.length, 2);
  for (const [, name, link] of namedLinks) {
    const result = await inspectRenewalConfirmation(f.db, new URL(link).searchParams.get('token'), f.settings, NOW);
    assert.equal(result.name, name);
    assert.equal(result.state, 'ready');
  }
});

sqliteTest('renewal_url sends each server its own template and matching confirmation URL', async t => {
  const f = fixture({}, { notification_template: '{{client}}|{{count}}|{{message}}|Confirm: {{ renewal_url }}|END' });
  f.addServer({ id: 'srv-2', name: '第二台服务器' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(requests.length, 2);
  const names = new Set();
  for (const { text } of requests) {
    const [name, count, details, confirmation, end] = text.split('|');
    assert.equal(count, '1');
    assert.match(details, new RegExp(name));
    assert.doesNotMatch(details, /token=/);
    assert.equal(end, 'END');
    const link = confirmation.replace('Confirm: ', '');
    const result = await inspectRenewalConfirmation(f.db, new URL(link).searchParams.get('token'), f.settings, NOW);
    assert.equal(result.name, name);
    names.add(name);
  }
  assert.deepEqual([...names].sort(), ['测试服务器', '第二台服务器'].sort());
});

sqliteTest('templates without renewal variables send plain details and do not create tokens', async t => {
  const f = fixture({}, { notification_template: '{{message}}' });
  f.addServer({ id: 'srv-2', name: '第二台服务器' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].text, /测试服务器/);
  assert.match(requests[0].text, /第二台服务器/);
  assert.doesNotMatch(requests[0].text, /https:|token=/);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key GLOB 'renewal_confirmation:*'").get().n, 0);
});

sqliteTest('webhook-only renewal variables generate matching links and safely render JSON', async t => {
  const f = fixture({ name: 'Box "A"' }, {
    notification_template: '{{message}}', notification_webhook_enabled: 'true',
    notification_webhook_url: 'https://hooks.example.com/notify',
    notification_webhook_body: '{"name":"{{client}}","details":"{{message}}","url":"{{ renewal_url }}","links":"{{renewal_links}}","formatted":"{{notification}}"}',
    notification_webhook_headers: '{"X-Renewal-URL":"{{renewal_url}}"}'
  });
  f.addServer({ id: 'srv-2', name: '第二台服务器' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ body: JSON.parse(options.body), headers: options.headers });
    return { ok: true };
  });
  assert.equal(await checkExpiringServers(f.db, { now: NOW }), true);
  assert.equal(requests.length, 2);
  for (const { body, headers } of requests) {
    const result = await inspectRenewalConfirmation(f.db, new URL(body.url).searchParams.get('token'), f.settings, NOW);
    assert.equal(result.name, body.name);
    assert.equal(headers['X-Renewal-URL'], body.url);
    assert.equal(body.links, `${body.name}: ${body.url}`);
    assert.equal(body.formatted, body.details);
    assert.doesNotMatch(body.details, /token=/);
  }
});

sqliteTest('non-expiration notifications leave renewal variables empty without extra blank blocks', async t => {
  const f = fixture({}, { notification_template: '{{message}}\n\n{{renewal_url}}\n\n{{renewal_links}}\n\n{{time}}' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  });
  await sendNotification(f.settings, 'CPU high', { event: 'Resource alert', clients: [f.server.name] });
  assert.equal(requests.length, 1);
  assert.match(requests[0].text, /^CPU high\n\n\d/);
  assert.doesNotMatch(requests[0].text, /\n{3,}|token=|renewal_url|renewal_links/);
});
