import { confirmRenewal, inspectRenewalConfirmation } from '../services/renewalConfirmation.js';
import { loadSiteSettings, normalizeNotificationLanguage } from '../utils/settings.js';

const MESSAGES = {
  zh: {
    title: '确认服务器续费', brand: 'CF Server Monitor · 续费确认', server: '服务器', cycle: '计费周期',
    current: '原到期日期', next: '确认后到期日期', confirm: '已完成续费，更新到期日期',
    ready: '请先在服务商处完成付款，再点击下方按钮。确认后将从原到期日期顺延一个计费周期。',
    confirmed: '续费已确认，到期日期已更新。重复打开或提交此链接不会再次顺延。',
    invalid: '链接无效、已失效或已被清理。请使用最新到期通知中的链接。',
    expired: '链接已过期或服务器已超过可确认期限。请使用最新通知，或到管理后台核对到期日期。',
    changed: '服务器的到期日期、计费信息或自动续费设置已变更。此通知已失效，不会再次更新日期。',
    disabled: '续费确认已关闭，请到管理后台核对到期日期。',
    early: days => `尚未临近到期。仅在到期前 ${days} 天内可以确认，请届时使用最新通知中的链接。`,
    note: '链接有效期为 7 天，请妥善保管。此页面仅记录续费结果，不会扣款。',
    failure: '暂时无法处理，请稍后重新打开此链接。', retry: '返回确认页面',
    cycles: { month: '月付', quarter: '季付', half_year: '半年付', year: '年付', two_years: '两年付', three_years: '三年付', four_years: '四年付', five_years: '五年付' }
  },
  en: {
    title: 'Confirm server renewal', brand: 'CF Server Monitor · Renewal', server: 'Server', cycle: 'Billing cycle',
    current: 'Original expiration', next: 'Expiration after confirmation', confirm: 'I have paid — update expiration',
    ready: 'Pay your provider first, then confirm below to extend the original expiration by one billing cycle.',
    confirmed: 'Renewal confirmed. Opening or submitting this link again will not extend the date again.',
    invalid: 'This link is invalid or no longer available. Use the latest expiration reminder.',
    expired: 'This link or confirmation window has expired. Use the latest reminder or check the date in the admin panel.',
    changed: 'The expiration, billing details or automatic renewal setting has changed. This reminder cannot update the date again.',
    disabled: 'Renewal confirmation is disabled. Check the expiration in the admin panel.',
    early: days => `Confirmation is available within ${days} days before expiration. Use the latest reminder at that time.`,
    note: 'This link is valid for 7 days. Keep it private. This page records renewal and does not charge you.',
    failure: 'Unable to process this request. Please reopen this link shortly.', retry: 'Back to confirmation',
    cycles: { month: 'Monthly', quarter: 'Quarterly', half_year: 'Half-yearly', year: 'Yearly', two_years: 'Two years', three_years: 'Three years', four_years: 'Four years', five_years: 'Five years' }
  },
  es: {
    title: 'Confirmar renovación', brand: 'CF Server Monitor · Renovación', server: 'Servidor', cycle: 'Ciclo de facturación',
    current: 'Vencimiento original', next: 'Vencimiento tras confirmar', confirm: 'Ya he pagado: actualizar vencimiento',
    ready: 'Pague primero al proveedor y confirme para ampliar el vencimiento original un ciclo de facturación.',
    confirmed: 'Renovación confirmada. Abrir o enviar este enlace otra vez no ampliará la fecha de nuevo.',
    invalid: 'El enlace no es válido o ya no está disponible. Use el último recordatorio.',
    expired: 'El enlace o el plazo de confirmación ha caducado. Use el último recordatorio o revise la fecha en el panel.',
    changed: 'El vencimiento, la facturación o la renovación automática han cambiado. Este recordatorio ya no puede actualizar la fecha.',
    disabled: 'La confirmación está desactivada. Revise el vencimiento en el panel.',
    early: days => `Puede confirmar dentro de los ${days} días anteriores al vencimiento. Use el último recordatorio entonces.`,
    note: 'El enlace es válido durante 7 días. Manténgalo privado. Esta página registra la renovación sin realizar cobros.',
    failure: 'No se pudo procesar la solicitud. Vuelva a abrir este enlace más tarde.', retry: 'Volver a la confirmación',
    cycles: { month: 'Mensual', quarter: 'Trimestral', half_year: 'Semestral', year: 'Anual', two_years: 'Dos años', three_years: 'Tres años', four_years: 'Cuatro años', five_years: 'Cinco años' }
  }
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function renderPage(result, token, language, status = 200) {
  const t = MESSAGES[language];
  const message = result.state === 'early' ? t.early(result.window_days) : t[result.state];
  const ready = result.state === 'ready';
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>${t.title}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f5fa;color:#18243a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px 16px;padding-bottom:max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:480px;background:#fff;border:1px solid #dfe5ef;border-radius:20px;padding:28px;box-shadow:0 12px 40px #18243a0a;overflow-wrap:anywhere}
.brand{font-size:12px;color:#5b6880;letter-spacing:.04em}h1{font-size:24px;line-height:1.35;margin:16px 0}p{font-size:15px;line-height:1.7;margin:16px 0}
.status{padding:14px 16px;background:#eff4ff;border-radius:12px}.success{background:#edf9f1;color:#18633a}
dl{margin:24px 0;display:grid;gap:16px}dt{font-size:13px;color:#5b6880;margin-bottom:5px}dd{margin:0;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}.next{color:#2458d3}
button,.retry{display:block;width:100%;min-height:52px;padding:14px 16px;border:0;border-radius:12px;background:#2458d3;color:white;font:inherit;font-weight:600;line-height:1.5;cursor:pointer;text-align:center;text-decoration:none;touch-action:manipulation}
button:focus-visible,.retry:focus-visible{outline:3px solid #97b7ff;outline-offset:3px}.note{font-size:12px;color:#68758a;margin-bottom:0}
@media(max-width:380px){main{padding:22px 18px}h1{font-size:22px}}
@media(prefers-color-scheme:dark){:root{background:#111827;color:#e5eaf4}main{background:#1b2537;border-color:#334155}.brand,dt,.note{color:#a7b4cb}.status{background:#253652}.success{background:#183b30;color:#a3e6bd}.next{color:#93b4ff}}
</style></head><body><main><div class="brand">${t.brand}</div><h1>${t.title}</h1>
<p role="status" class="status ${result.state === 'confirmed' ? 'success' : ''}">${escapeHtml(message)}</p>
${result.name ? `<dl><div><dt>${t.server}</dt><dd>${escapeHtml(result.name)}</dd></div>
<div><dt>${t.cycle}</dt><dd>${escapeHtml(t.cycles[result.billing_cycle])}</dd></div>
<div><dt>${t.current}</dt><dd>${escapeHtml(result.expire_date)}</dd></div>
${ready || result.state === 'confirmed' ? `<div><dt>${t.next}</dt><dd class="next">${escapeHtml(result.next_expire_date)}</dd></div>` : ''}</dl>` : ''}
${ready ? `<form method="post" action="/renew"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${t.confirm}</button></form>` : ''}
${result.state === 'failure' ? `<a class="retry" href="/renew?token=${escapeHtml(encodeURIComponent(token))}">${t.retry}</a>` : ''}
<p class="note">${t.note}</p></main></body></html>`;
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  } });
}

export async function handleRenewalConfirmation(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }
  let language = 'zh';
  let token = new URL(request.url).searchParams.get('token') || '';
  try {
    const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
    language = normalizeNotificationLanguage(settings.notification_language);
    if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.startsWith('application/x-www-form-urlencoded')) return renderPage({ state: 'invalid' }, '', language, 400);
      const body = await request.text();
      if (body.length > 256) return renderPage({ state: 'invalid' }, '', language, 400);
      token = new URLSearchParams(body).get('token') || '';
      const result = await confirmRenewal(env.DB, token, settings);
      if (result.state === 'confirmed') {
        return new Response(null, { status: 303, headers: {
          Location: `/renew?token=${encodeURIComponent(token)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        } });
      }
      return renderPage(result, token, language, result.state === 'invalid' || result.state === 'expired' ? 410 : 409);
    }
    const result = await inspectRenewalConfirmation(env.DB, token, settings);
    return renderPage(result, token, language, result.state === 'invalid' || result.state === 'expired' ? 410 : 200);
  } catch {
    // Never log the bearer token or the request URL.
    return renderPage({ state: 'failure' }, token, language, 503);
  }
}
