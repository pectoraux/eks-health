/**
 * Eks-Health Platform Kernel — Public API Barrel
 *
 * Import everything from `@/kernel`:
 *   import { getEventBus, getFlags, KernelError } from "@/kernel";
 *
 * The kernel is the operating-system core. It owns no healthcare concepts.
 */

// Core primitives
export * from "./core";

// Subsystems
export * from "./events";
export * from "./config";
export * from "./flags";
export * from "./tenant";
export * from "./time";
// i18n re-exports Locale/asLocale too — re-export explicitly to avoid a
// duplicate-export collision with ./time in the barrel.
export type {
  TextDirection,
  MeasurementSystem,
  Currency,
  PluralRule,
  Language,
  TranslationPack,
  DateFormatOptions,
  NumberFormatOptions,
} from "./i18n";
export {
  asCurrency,
  BUILTIN_LANGUAGES,
  BUILTIN_TRANSLATIONS,
  I18nService,
  formatMessage,
  getI18n,
  setI18n,
} from "./i18n";
export * from "./storage";
export * from "./search";
export * from "./search-semantic";
export * from "./notification";
export * from "./scheduler";
export * from "./observability";
export * from "./security";
export * from "./ai";
export * from "./gateway";
export * from "./registry";

// Boot sequence
export { bootKernel, kernelInfo, kernelSnapshot } from "./boot";
