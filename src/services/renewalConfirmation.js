import { clearServersListCache } from '../utils/cache.js';
import { getExpireReminderDays, normalizeNotificationSiteUrl, normalizeNotificationTimezone } from '../utils/settings.js';
import { addBillingCycleToDate, detectBillingCycle, isEnabledFlag, normalizeBillingCycle, parseDateOnly } from '../utils/serverBilling.js';

const KEY_PREFIX = 'renewal_confirmation:';
const DAY_MS = 86400000;
const TOKEN_TTL_MS = 7 * DAY_MS;

function dateInTimezone(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeNotificationTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function tokenKey(token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return KEY_PREFIX + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function cleanupRenewalConfirmations(db, now = Date.now()) {
  await db.prepare(`DELETE FROM settings WHERE key GLOB ? AND json_extract(value, '$.expires_at') <= ?`)
    .bind(`${KEY_PREFIX}*`, now).run();
}

export async function createRenewalConfirmationUrl(db, server, settings, now = Date.now()) {
  const siteUrl = normalizeNotificationSiteUrl(settings.notification_site_url);
  if (!siteUrl || isEnabledFlag(server.auto_renewal) || !parseDateOnly(server.expire_date)) return '';

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const billingCycle = normalizeBillingCycle(detectBillingCycle(server.price) || server.billing_cycle);
  const record = {
    server_id: server.id,
    expire_date: server.expire_date,
    billing_cycle: billingCycle,
    // Keep the actual stored values too: edits made after the reminder invalidate its link.
    stored_billing_cycle: server.billing_cycle ?? 'month',
    price: server.price ?? '',
    next_expire_date: addBillingCycleToDate(server.expire_date, billingCycle),
    expires_at: now + TOKEN_TTL_MS
  };
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .bind(await tokenKey(token), JSON.stringify(record)).run();
  const url = new URL('/renew', siteUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export async function inspectRenewalConfirmation(db, token, settings, now = Date.now()) {
  const key = await tokenKey(token);
  if (!key) return { state: 'invalid' };
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return { state: 'invalid' };
  let record;
  try { record = JSON.parse(row.value); } catch { return { state: 'invalid' }; }
  if (!Number.isFinite(record.expires_at) || record.expires_at <= now) return { state: 'expired' };
  const server = await db.prepare('SELECT * FROM servers WHERE id = ?').bind(record.server_id).first();
  if (!server) return { state: 'invalid' };
  const details = { name: server.name || server.id, expire_date: record.expire_date, next_expire_date: record.next_expire_date, billing_cycle: record.billing_cycle };
  if (record.confirmed_at) return { state: 'confirmed', ...details };
  if (server.expire_date !== record.expire_date || (server.billing_cycle ?? 'month') !== record.stored_billing_cycle ||
      (server.price ?? '') !== record.price || isEnabledFlag(server.auto_renewal)) {
    return { state: 'changed', ...details };
  }
  const windowDays = Math.min(getExpireReminderDays(settings.expire_reminder), 5);
  const today = dateInTimezone(now, settings.notification_timezone);
  // Offset calendar days after resolving the local date, including across DST.
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const windowEnd = new Date(todayMs + windowDays * DAY_MS).toISOString().slice(0, 10);
  const windowStart = new Date(todayMs - 7 * DAY_MS).toISOString().slice(0, 10);
  if (!windowDays || !normalizeNotificationSiteUrl(settings.notification_site_url)) return { state: 'disabled', ...details };
  if (record.expire_date > windowEnd) return { state: 'early', window_days: windowDays, ...details };
  if (record.expire_date < windowStart || record.next_expire_date <= today) return { state: 'expired', ...details };
  return { state: 'ready', ...details, key, record, raw: row.value, windowStart, windowEnd };
}

export async function confirmRenewal(db, token, settings, now = Date.now()) {
  const inspection = await inspectRenewalConfirmation(db, token, settings, now);
  if (inspection.state !== 'ready') return inspection;
  const { record, key, raw, windowStart, windowEnd } = inspection;
  // D1 batches are transactional. The date snapshot and token check are part of the
  // UPDATE, so concurrent clicks (including different reminders) advance only once.
  const [result] = await db.batch([
    db.prepare(`UPDATE servers SET expire_date = ?, billing_cycle = ?
      WHERE id = ? AND expire_date = ? AND COALESCE(billing_cycle, 'month') = ?
        AND COALESCE(price, '') = ? AND COALESCE(auto_renewal, '0') NOT IN ('1', 'true')
        AND expire_date >= ? AND expire_date <= ?
        AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?
          AND json_extract(value, '$.expires_at') > ?)`)
      .bind(record.next_expire_date, record.billing_cycle, record.server_id, record.expire_date,
        record.stored_billing_cycle, record.price, windowStart, windowEnd, key, raw, now),
    db.prepare(`UPDATE settings SET value = ? WHERE key = ? AND value = ?
      AND EXISTS (SELECT 1 FROM servers WHERE id = ? AND expire_date = ?)`)
      .bind(JSON.stringify({ ...record, confirmed_at: now }), key, raw, record.server_id, record.next_expire_date)
  ]);
  if (Number(result?.meta?.changes) > 0) clearServersListCache();
  return inspectRenewalConfirmation(db, token, settings, now);
}
