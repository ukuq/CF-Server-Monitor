export const LANGUAGE_COOKIE_NAME = 'cfsm_language';
export const SUPPORTED_LANGUAGES = ['zh', 'en', 'es'];

export function normalizeSupportedLanguage(value) {
  const match = String(value || '').trim().toLowerCase().replaceAll('_', '-')
    .match(/^(zh|cmn|yue|wuu|en|es)(?:-[a-z0-9]+)*$/);
  if (!match) return '';
  return ['cmn', 'yue', 'wuu'].includes(match[1]) ? 'zh' : match[1];
}

export function createLanguageCookie(language, secure = false) {
  const value = normalizeSupportedLanguage(language);
  return value ? `${LANGUAGE_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}` : '';
}

export function resolveRequestLanguage(request, fallback = 'zh') {
  const explicit = normalizeSupportedLanguage(new URL(request.url).searchParams.get('lang'));
  if (explicit) return explicit;

  const cookie = (request.headers.get('Cookie') || '').split(';')
    .map(part => part.trim()).find(part => part.startsWith(`${LANGUAGE_COOKIE_NAME}=`));
  if (cookie) {
    try {
      const saved = normalizeSupportedLanguage(decodeURIComponent(cookie.slice(LANGUAGE_COOKIE_NAME.length + 1)));
      if (saved) return saved;
    } catch { /* Ignore malformed preferences. */ }
  }

  const preferred = (request.headers.get('Accept-Language') || '').split(',').map(part => {
    const [tag, ...parameters] = part.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().toLowerCase().startsWith('q='));
    return { language: normalizeSupportedLanguage(tag), quality: quality ? Number(quality.split('=')[1]) : 1 };
  }).filter(item => item.language && item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality);
  return preferred[0]?.language || normalizeSupportedLanguage(fallback) || 'zh';
}
