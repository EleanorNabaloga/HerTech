import translationData from './translations.json';

export type Language = 'EN' | 'LUG' | 'SW' | 'AR' | 'FR';

/*
 * lib/translations.json maps each English phrase to its four translations.
 * Keys may contain {placeholders}; translations must keep the same ones.
 * `npm run i18n:check` fails if any phrase used in the app is missing.
 */
const TRANSLATIONS: Record<
  string,
  Record<Exclude<Language, 'EN'>, string>
> = translationData;

// Each language is listed in its own name so speakers can find it.
export const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'EN', label: 'English' },
  { value: 'LUG', label: 'Luganda' },
  { value: 'SW', label: 'Kiswahili' },
  { value: 'AR', label: 'العربية' },
  { value: 'FR', label: 'Français' },
];

export type TranslationVars = Record<string, string | number>;

const warnedMissing = new Set<string>();

function fill(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * Translate an English phrase. Phrases may contain {placeholders} that are
 * filled from `vars`, e.g. translate('LUG', 'Hello {name}', { name: 'Grace' }).
 * Every phrase must exist in lib/translations.ts; run `npm run i18n:check`.
 */
export function translate(
  language: Language,
  english: string,
  vars?: TranslationVars,
): string {
  if (language === 'EN') return fill(english, vars);

  const entry = TRANSLATIONS[english];
  if (!entry) {
    if (process.env.NODE_ENV !== 'production' && !warnedMissing.has(english)) {
      warnedMissing.add(english);
      console.warn(`[i18n] Missing translation: "${english}"`);
    }
    return fill(english, vars);
  }

  return fill(entry[language], vars);
}

export function hasTranslation(english: string): boolean {
  return english in TRANSLATIONS;
}

/** Locale used for dates and numbers in each language. */
export function localeFor(language: Language): string {
  switch (language) {
    case 'LUG':
      return 'lg-UG';
    case 'SW':
      return 'sw';
    case 'AR':
      // Arabic text, but Western digits so amounts read the same everywhere.
      return 'ar-u-nu-latn';
    case 'FR':
      return 'fr';
    default:
      return 'en-GB';
  }
}

export function isRightToLeft(language: Language): boolean {
  return language === 'AR';
}

/** Keep <html lang/dir> in step with the chosen language. */
export function applyDocumentLanguage(language: Language): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.lang = localeFor(language).split('-')[0];
  html.dir = isRightToLeft(language) ? 'rtl' : 'ltr';
}
