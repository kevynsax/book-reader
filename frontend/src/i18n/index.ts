import { translations } from './translations';

export type Lang = 'en' | 'pt' | 'es';

function detectLang(): Lang {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const c of candidates) {
    const code = (c || '').toLowerCase().split('-')[0];
    if (code === 'pt') return 'pt';
    if (code === 'es') return 'es';
    if (code === 'en') return 'en';
  }
  return 'en';
}

export const lang: Lang = detectLang();

document.documentElement.lang = lang;

type Vars = Record<string, string | number>;

// English source string doubles as the translation key. Missing keys fall back
// to the English source, so untranslated strings still render. Interpolation
// uses {name} placeholders.
export function t(source: string, vars?: Vars): string {
  let out = lang === 'en' ? source : translations[lang]?.[source] ?? source;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}
