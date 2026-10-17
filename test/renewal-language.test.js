import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { createLanguageCookie, resolveRequestLanguage } from '../src/utils/language.js';

test('renewal language follows explicit choice, site preference, browser preferences and notification fallback', () => {
  const resolve = (query = '', headers = {}, fallback = 'zh') =>
    resolveRequestLanguage(new Request(`https://monitor.example.com/renew${query}`, { headers }), fallback);
  assert.equal(resolve('?lang=es', { Cookie: 'cfsm_language=en', 'Accept-Language': 'zh-CN' }), 'es');
  assert.equal(resolve('', { Cookie: 'other=value; cfsm_language=en', 'Accept-Language': 'zh-CN' }), 'en');
  assert.equal(resolve('', { 'Accept-Language': 'fr-FR, en-US;q=0.6, es-419;q=0.9, zh;q=0' }), 'es');
  assert.equal(resolve('', { 'Accept-Language': 'en;q=0.9, zh-CN;q=0.5' }), 'en');
  assert.equal(resolve('', { 'Accept-Language': 'yue-Hant-HK, en;q=0.8' }), 'zh');
  assert.equal(resolve('', { 'Accept-Language': 'fr, es;q=invalid, en;q=2' }, 'es'), 'es');
  assert.equal(resolve('?lang=invalid', { Cookie: 'cfsm_language=%broken', 'Accept-Language': 'en' }), 'en');
  assert.equal(resolve('?lang=%22%3E%3Cscript%3E', { Cookie: 'cfsm_language=unsupported' }), 'zh');
  assert.equal(resolve('', {}, 'en'), 'en');
  assert.equal(resolve('', {}, 'auto'), 'zh');
  assert.equal(createLanguageCookie('invalid'), '');
});

test('frontend language changes and configured defaults reach standalone pages through the preference cookie', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const saved = new Map();
  const document = { cookie: '' };
  const globals = {
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
    document,
    window: { location: { protocol: 'https:' }, dispatchEvent() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    if (key !== 'document') Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    const { setLanguage, getLanguage, applyDefaultLanguage, translations } = await vite.ssrLoadModule('/src/frontend/utils/i18n.js');
    Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
    const pageLanguage = () => resolveRequestLanguage(new Request('https://monitor.example.com/renew', {
      headers: { Cookie: document.cookie.split(';')[0], 'Accept-Language': 'zh-CN' }
    }));
    for (const lang of ['en', 'es', 'zh']) {
      setLanguage(lang);
      assert.equal(getLanguage(), lang);
      assert.equal(pageLanguage(), lang);
      assert.match(document.cookie, /Path=\/; Max-Age=31536000; SameSite=Lax; Secure/);
      for (const key of ['autoRenewalTip', 'notificationSiteUrl', 'notificationSiteUrlTip', 'notificationTemplateVariablesTip', 'renewalConfirmationTip', 'invalidNotificationSiteUrl']) {
        assert.ok(translations[lang][key], `Missing ${lang}.${key}`);
      }
    }
    saved.clear();
    applyDefaultLanguage('es');
    assert.equal(pageLanguage(), 'es');
    setLanguage('en');
    applyDefaultLanguage('zh');
    assert.equal(pageLanguage(), 'en');
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await vite.close();
  }
});
