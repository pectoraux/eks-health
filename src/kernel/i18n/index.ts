/**
 * Eks-Health Kernel — Internationalization (i18n) Subsystem
 *
 * Every user-facing string in the platform flows through this module. It is
 * intentionally runtime-only and dependency-free — production translation
 * packs can be loaded at boot or fetched asynchronously and registered.
 *
 * Capabilities:
 *  - Pre-registered languages: English, French, Spanish, Arabic (RTL),
 *    Chinese, Swahili — covering the platform's launch markets.
 *  - ICU-style message syntax: `{name}` interpolation and
 *    `{count, plural, one{...} other{...}}` pluralization, evaluated with
 *    the native Intl.PluralRules engine.
 *  - Currency, number, date and list formatting via Intl.* (no external deps).
 *  - RTL detection for Arabic (and any future RTL language).
 *  - Open registry: additional languages and translation packs can be
 *    registered at runtime via registerLanguage().
 */

import type { Brand } from "../core";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type TextDirection = "ltr" | "rtl";
export type MeasurementSystem = "metric" | "imperial";

/** ISO 4217 currency code, e.g. "USD", "EUR", "KES". */
export type Currency = Brand<string, "Currency">;

export function asCurrency(s: string): Currency {
  return s as Currency;
}

/** BCP-47 locale tag, e.g. "en-US", "fr-FR", "ar-EG". */
export type Locale = Brand<string, "Locale">;

export function asLocale(s: string): Locale {
  return s as Locale;
}

/** ICU plural categories as produced by Intl.PluralRules. */
export type PluralRule = "zero" | "one" | "two" | "few" | "many" | "other";

export interface Language {
  readonly code: string; // short code, e.g. "en"
  readonly label: string; // English label, e.g. "English"
  readonly nativeLabel: string; // native label, e.g. "English" / "Français"
  readonly direction: TextDirection;
  readonly measurementSystem: MeasurementSystem;
  readonly defaultCurrency: Currency;
  readonly defaultLocale: Locale; // canonical BCP-47 for this language
}

export interface TranslationPack {
  readonly language: string; // short code, e.g. "en"
  readonly translations: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Built-in language registry (6 launch languages)
// ---------------------------------------------------------------------------

export const BUILTIN_LANGUAGES: readonly Language[] = [
  {
    code: "en",
    label: "English",
    nativeLabel: "English",
    direction: "ltr",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("USD"),
    defaultLocale: asLocale("en-US"),
  },
  {
    code: "fr",
    label: "French",
    nativeLabel: "Français",
    direction: "ltr",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("EUR"),
    defaultLocale: asLocale("fr-FR"),
  },
  {
    code: "es",
    label: "Spanish",
    nativeLabel: "Español",
    direction: "ltr",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("EUR"),
    defaultLocale: asLocale("es-ES"),
  },
  {
    code: "ar",
    label: "Arabic",
    nativeLabel: "العربية",
    direction: "rtl",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("EGP"),
    defaultLocale: asLocale("ar-EG"),
  },
  {
    code: "zh",
    label: "Chinese",
    nativeLabel: "中文",
    direction: "ltr",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("CNY"),
    defaultLocale: asLocale("zh-CN"),
  },
  {
    code: "sw",
    label: "Swahili",
    nativeLabel: "Kiswahili",
    direction: "ltr",
    measurementSystem: "metric",
    defaultCurrency: asCurrency("KES"),
    defaultLocale: asLocale("sw-KE"),
  },
];

/** Languages whose script is rendered right-to-left. */
const RTL_LANGUAGE_PREFIXES = ["ar", "he", "fa", "ur", "iw", "ji"];

// ---------------------------------------------------------------------------
// Built-in translation pack (8 sample keys × 6 languages)
// ---------------------------------------------------------------------------

export const BUILTIN_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    "platform.name": "Eks-Health",
    "platform.tagline": "Preventive health, for everyone.",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.loading": "Loading…",
    "common.error": "Something went wrong.",
    "common.search": "Search",
    "common.settings": "Settings",
    "common.items_count": "{count, plural, one{# item} other{# items}}",
  },
  fr: {
    "platform.name": "Eks-Health",
    "platform.tagline": "Santé préventive, pour tous.",
    "common.save": "Enregistrer",
    "common.cancel": "Annuler",
    "common.loading": "Chargement…",
    "common.error": "Une erreur s'est produite.",
    "common.search": "Rechercher",
    "common.settings": "Paramètres",
    "common.items_count": "{count, plural, one{# article} other{# articles}}",
  },
  es: {
    "platform.name": "Eks-Health",
    "platform.tagline": "Salud preventiva, para todos.",
    "common.save": "Guardar",
    "common.cancel": "Cancelar",
    "common.loading": "Cargando…",
    "common.error": "Algo salió mal.",
    "common.search": "Buscar",
    "common.settings": "Configuración",
    "common.items_count": "{count, plural, one{# artículo} other{# artículos}}",
  },
  ar: {
    "platform.name": "إكس-هيلث",
    "platform.tagline": "صحة وقائية للجميع.",
    "common.save": "حفظ",
    "common.cancel": "إلغاء",
    "common.loading": "جارٍ التحميل…",
    "common.error": "حدث خطأ ما.",
    "common.search": "بحث",
    "common.settings": "الإعدادات",
    "common.items_count": "{count, plural, one{# عنصر} other{# عناصر}}",
  },
  zh: {
    "platform.name": "Eks-Health",
    "platform.tagline": "预防性健康，惠及每一个人。",
    "common.save": "保存",
    "common.cancel": "取消",
    "common.loading": "加载中…",
    "common.error": "出了点问题。",
    "common.search": "搜索",
    "common.settings": "设置",
    "common.items_count": "{count, plural, other{# 项}}",
  },
  sw: {
    "platform.name": "Eks-Health",
    "platform.tagline": "Afya kinga, kwa kila mtu.",
    "common.save": "Hifadhi",
    "common.cancel": "Ghairi",
    "common.loading": "Inapakia…",
    "common.error": "Hitilafu imetokea.",
    "common.search": "Tafuta",
    "common.settings": "Mipangilio",
    "common.items_count": "{count, plural, one{# kipengee} other{# vipengee}}",
  },
};

// ---------------------------------------------------------------------------
// Formatting option types
// ---------------------------------------------------------------------------

export interface DateFormatOptions {
  readonly dateStyle?: "full" | "long" | "medium" | "short";
  readonly timeStyle?: "full" | "long" | "medium" | "short";
  readonly timeZone?: string;
}

export interface NumberFormatOptions {
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
  readonly notation?: "standard" | "scientific" | "engineering" | "compact";
}

// ---------------------------------------------------------------------------
// I18n Service
// ---------------------------------------------------------------------------

export class I18nService {
  private readonly languages = new Map<string, Language>();
  private readonly packs = new Map<string, TranslationPack>();
  private defaultLocale: Locale = asLocale("en-US");

  constructor() {
    // Pre-register the six launch languages and their built-in packs.
    for (const lang of BUILTIN_LANGUAGES) {
      this.languages.set(lang.code, lang);
    }
    for (const [code, translations] of Object.entries(BUILTIN_TRANSLATIONS)) {
      this.packs.set(code, { language: code, translations });
    }
  }

  /** Register an additional language (and optionally its translation pack). */
  registerLanguage(lang: Language, pack?: TranslationPack): void {
    this.languages.set(lang.code, lang);
    if (pack) this.packs.set(lang.code, pack);
  }

  /** Register / merge a translation pack for a language. */
  registerPack(pack: TranslationPack): void {
    const existing = this.packs.get(pack.language);
    if (existing) {
      this.packs.set(pack.language, {
        language: pack.language,
        translations: { ...existing.translations, ...pack.translations },
      });
    } else {
      this.packs.set(pack.language, pack);
    }
  }

  /** Set the platform-wide default locale. */
  setDefault(locale: Locale): void {
    this.defaultLocale = locale;
  }

  getDefault(): Locale {
    return this.defaultLocale;
  }

  listLanguages(): Language[] {
    return [...this.languages.values()];
  }

  getLanguage(code: string): Language | undefined {
    return this.languages.get(code);
  }

  /** Resolve a BCP-47 locale to its registered language (by 2-letter prefix). */
  resolveLanguage(locale: Locale): Language | undefined {
    const code = locale.split("-")[0]?.toLowerCase();
    return code ? this.languages.get(code) : undefined;
  }

  /**
   * Translate a key for the given locale. Supports:
   *   - `{name}` interpolation from `params`
   *   - `{count, plural, one{...} other{...}}` ICU pluralization
   * If the key is missing, returns the key itself (graceful degradation).
   */
  t(key: string, locale: Locale = this.defaultLocale, params?: Record<string, unknown>): string {
    const template = this.lookup(key, locale);
    if (!template) return key;
    if (!params) return template;
    return formatMessage(template, params, locale);
  }

  /** Format a currency amount using Intl.NumberFormat. */
  formatCurrency(amount: number, currency: Currency | string, locale: Locale = this.defaultLocale): string {
    const code = typeof currency === "string" ? currency : (currency as string);
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
    }).format(amount);
  }

  /** Format a number using Intl.NumberFormat. */
  formatNumber(n: number, locale: Locale = this.defaultLocale, opts: NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: opts.minimumFractionDigits,
      maximumFractionDigits: opts.maximumFractionDigits,
      notation: opts.notation,
    }).format(n);
  }

  /** Format an epoch-ms timestamp using Intl.DateTimeFormat. */
  formatDate(ts: number, locale: Locale = this.defaultLocale, opts: DateFormatOptions = {}): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: opts.dateStyle,
      timeStyle: opts.timeStyle,
      timeZone: opts.timeZone,
    }).format(new Date(ts));
  }

  /** Format a list of strings using Intl.ListFormat (and/or style). */
  formatList(items: readonly string[], locale: Locale = this.defaultLocale, style: "long" | "short" | "narrow" = "long"): string {
    return new Intl.ListFormat(locale, { style, type: "conjunction" }).format(items);
  }

  /** Text direction for a locale — looks up the registered language first. */
  getDirection(locale: Locale = this.defaultLocale): TextDirection {
    const lang = this.resolveLanguage(locale);
    if (lang) return lang.direction;
    const prefix = locale.split("-")[0]?.toLowerCase() ?? "";
    return RTL_LANGUAGE_PREFIXES.includes(prefix) ? "rtl" : "ltr";
  }

  /** Whether a locale renders right-to-left. */
  isRTL(locale: Locale = this.defaultLocale): boolean {
    return this.getDirection(locale) === "rtl";
  }

  /** Measurement system for a locale (defaults to metric). */
  getMeasurementSystem(locale: Locale = this.defaultLocale): MeasurementSystem {
    const lang = this.resolveLanguage(locale);
    return lang?.measurementSystem ?? "metric";
  }

  // --- private ------------------------------------------------------------

  private lookup(key: string, locale: Locale): string | undefined {
    const code = locale.split("-")[0]?.toLowerCase();
    if (!code) return undefined;
    // Try exact locale pack, then language-only pack.
    const exact = this.packs.get(locale.toLowerCase());
    if (exact?.translations[key]) return exact.translations[key];
    const pack = this.packs.get(code);
    return pack?.translations[key];
  }
}

// ---------------------------------------------------------------------------
// ICU-style message formatter (interpolation + pluralization)
// ---------------------------------------------------------------------------

/**
 * Evaluate an ICU-style message:
 *   "Hello {name}, you have {count, plural, one{# message} other{# messages}}."
 *
 * Branches may themselves contain `{name}` interpolations and `#` placeholders
 * (the latter is replaced with the plural count).
 */
export function formatMessage(
  template: string,
  params: Record<string, unknown>,
  locale: Locale | string = "en-US",
): string {
  return walk(template, params, typeof locale === "string" ? locale : (locale as string));
}

function walk(template: string, params: Record<string, unknown>, locale: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{") {
      const [contents, end] = readBraced(template, i);
      out += applyBlock(contents, params, locale);
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Read a `{ ... }` block starting at `start` (which must be `{`). Returns [inner, end index]. */
function readBraced(s: string, start: number): [string, number] {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return [s.slice(start + 1, i), i];
    }
    i++;
  }
  throw new SyntaxError(`Unbalanced braces in ICU template: ${s}`);
}

/** Apply a single `{...}` block: either interpolation or plural/select. */
function applyBlock(
  contents: string,
  params: Record<string, unknown>,
  locale: string,
): string {
  const firstComma = contents.indexOf(",");
  if (firstComma === -1) {
    // Simple interpolation: {name}
    const key = contents.trim();
    const v = params[key];
    return v === undefined ? `{${key}}` : String(v);
  }
  // Typed block: {name, type, branches...}
  const name = contents.slice(0, firstComma).trim();
  const rest = contents.slice(firstComma + 1).trim();
  const secondComma = rest.indexOf(",");
  const type = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
  const branchesStr = secondComma === -1 ? "" : rest.slice(secondComma + 1).trim();

  if (type === "plural") {
    const value = Number(params[name] ?? 0);
    const branches = parseBranches(branchesStr);
    const rule = new Intl.PluralRules(locale).select(value) as PluralRule;
    const branch = branches.get(rule) ?? branches.get("other") ?? "";
    // Replace `#` with the count, then recurse so inner interpolations work.
    return walk(branch.replace(/#/g, String(value)), params, locale);
  }

  // Unsupported block type — emit verbatim so the bug is visible.
  return `{${contents}}`;
}

/** Parse "one{...} other{...}" into a Map. */
function parseBranches(s: string): Map<PluralRule, string> {
  const out = new Map<PluralRule, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let key = "";
    while (i < s.length && /[a-zA-Z]/.test(s[i])) {
      key += s[i];
      i++;
    }
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== "{") break;
    const [contents, end] = readBraced(s, i);
    out.set(key as PluralRule, contents);
    i = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _svc: I18nService | null = null;
export function getI18n(): I18nService {
  if (!_svc) _svc = new I18nService();
  return _svc;
}
export function setI18n(svc: I18nService): void {
  _svc = svc;
}
