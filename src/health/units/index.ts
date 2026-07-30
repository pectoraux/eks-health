/**
 * Eks-Health Universal Health Data Platform — Measurement Units
 *
 * A global unit system supporting metric, imperial, medical, and custom
 * units with conversions, precision, localization, and historical unit
 * changes. Programs may define custom units when necessary.
 */

import "server-only";
import { type UnitId, HealthError, asUnitId } from "../core";
import { generateId } from "@/kernel";

// ---------------------------------------------------------------------------
// Unit definition
// ---------------------------------------------------------------------------

export interface UnitDefinition {
  readonly id: UnitId;
  readonly symbol: string; // e.g. "kg", "mmHg", "bpm"
  readonly name: string; // e.g. "kilogram"
  readonly category: UnitCategory;
  readonly system: UnitSystem; // metric | imperial | medical | custom
  readonly precision: number; // decimal places
  readonly toBaseFactor?: number; // multiply by this to get base unit
  readonly baseUnitId?: UnitId; // the base unit this converts to
  readonly localeLabels?: Record<string, string>; // BCP-47 -> localized label
  readonly deprecated?: boolean;
  readonly deprecatedAt?: string;
  readonly replacedBy?: UnitId;
}

export type UnitCategory =
  | "mass"
  | "length"
  | "temperature"
  | "pressure"
  | "heart_rate"
  | "volume"
  | "time"
  | "percentage"
  | "concentration"
  | "energy"
  | "power"
  | "speed"
  | "count"
  | "angle"
  | "area"
  | "frequency"
  | "custom";

export type UnitSystem = "metric" | "imperial" | "medical" | "custom";

// ---------------------------------------------------------------------------
// Built-in unit catalog (the platform provides common units; Programs add more)
// ---------------------------------------------------------------------------

export const BUILTIN_UNITS: readonly UnitDefinition[] = [
  // Mass
  u("kg", "kg", "kilogram", "mass", "metric", 2, 1, undefined),
  u("g", "g", "gram", "mass", "metric", 0, 0.001, "kg"),
  u("lb", "lb", "pound", "mass", "imperial", 2, 0.45359237, "kg"),
  u("oz", "oz", "ounce", "mass", "imperial", 1, 0.028349523125, "kg"),
  // Length
  u("m", "m", "meter", "length", "metric", 2, 1, undefined),
  u("cm", "cm", "centimeter", "length", "metric", 1, 0.01, "m"),
  u("mm", "mm", "millimeter", "length", "metric", 0, 0.001, "m"),
  u("ft", "ft", "foot", "length", "imperial", 1, 0.3048, "m"),
  u("in", "in", "inch", "length", "imperial", 1, 0.0254, "m"),
  // Temperature
  u("c", "°C", "celsius", "temperature", "metric", 1, undefined, undefined),
  u("f", "°F", "fahrenheit", "temperature", "imperial", 1, undefined, undefined),
  u("k", "K", "kelvin", "temperature", "metric", 1, undefined, undefined),
  // Pressure
  u("mmhg", "mmHg", "millimeters of mercury", "pressure", "medical", 0, 1, undefined),
  u("kpa", "kPa", "kilopascal", "pressure", "metric", 1, 7.50062, "mmhg"),
  u("psi", "psi", "pounds per square inch", "pressure", "imperial", 1, 51.7149, "mmhg"),
  // Heart rate
  u("bpm", "bpm", "beats per minute", "heart_rate", "medical", 0, 1, undefined),
  // Volume
  u("l", "L", "liter", "volume", "metric", 2, 1, undefined),
  u("ml", "mL", "milliliter", "volume", "metric", 0, 0.001, "l"),
  u("fl_oz", "fl oz", "fluid ounce", "volume", "imperial", 1, 0.0295735295625, "l"),
  u("cup", "cup", "cup", "volume", "imperial", 0, 0.2365882365, "l"),
  // Time
  u("s", "s", "second", "time", "metric", 0, 1, undefined),
  u("min", "min", "minute", "time", "metric", 0, 60, "s"),
  u("h", "h", "hour", "time", "metric", 1, 3600, "s"),
  u("d", "d", "day", "time", "metric", 0, 86400, "s"),
  // Percentage
  u("pct", "%", "percent", "percentage", "metric", 1, 1, undefined),
  // Concentration
  u("mg_dl", "mg/dL", "milligrams per deciliter", "concentration", "medical", 0, 1, undefined),
  u("mmol_l", "mmol/L", "millimoles per liter", "concentration", "medical", 1, undefined, undefined),
  u("ug_ml", "µg/mL", "micrograms per milliliter", "concentration", "medical", 2, 1, undefined),
  // Energy
  u("kcal", "kcal", "kilocalorie", "energy", "metric", 0, 1, undefined),
  u("kj", "kJ", "kilojoule", "energy", "metric", 0, 0.239006, "kcal"),
  // Count
  u("count", "#", "count", "count", "metric", 0, 1, undefined),
  u("steps", "steps", "steps", "count", "metric", 0, 1, undefined),
  // Frequency
  u("hz", "Hz", "hertz", "frequency", "metric", 1, 1, undefined),
];

function u(
  id: string, symbol: string, name: string, category: UnitCategory, system: UnitSystem,
  precision: number, toBaseFactor: number | undefined, baseUnitId: string | undefined,
): UnitDefinition {
  return {
    id: asUnitId(id),
    symbol,
    name,
    category,
    system,
    precision,
    toBaseFactor,
    baseUnitId: baseUnitId ? asUnitId(baseUnitId) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Unit registry
// ---------------------------------------------------------------------------

export class UnitRegistry {
  private readonly units = new Map<UnitId, UnitDefinition>();

  constructor() {
    for (const u of BUILTIN_UNITS) {
      this.units.set(u.id, u);
    }
  }

  register(unit: Omit<UnitDefinition, "id"> & { id?: string }): UnitDefinition {
    const id = unit.id ? asUnitId(unit.id) : asUnitId(generateId("unit_"));
    const full: UnitDefinition = { ...unit, id } as UnitDefinition;
    if (this.units.has(id)) {
      throw new HealthError({ code: "eks.health.unit.duplicate", category: "state_conflict", message: `Unit ${id} already exists.` });
    }
    this.units.set(id, full);
    return full;
  }

  get(id: UnitId): UnitDefinition | undefined {
    return this.units.get(id);
  }

  getBySymbol(symbol: string): UnitDefinition | undefined {
    return [...this.units.values()].find((u) => u.symbol === symbol);
  }

  list(filter?: { category?: UnitCategory; system?: UnitSystem }): UnitDefinition[] {
    let list = [...this.units.values()];
    if (filter?.category) list = list.filter((u) => u.category === filter.category);
    if (filter?.system) list = list.filter((u) => u.system === filter.system);
    return list;
  }

  listCategories(): UnitCategory[] {
    return [...new Set([...this.units.values()].map((u) => u.category))];
  }

  /** Convert a value from one unit to another (same category). */
  convert(value: number, fromId: UnitId, toId: UnitId): number {
    if (fromId === toId) return value;
    const from = this.units.get(fromId);
    const to = this.units.get(toId);
    if (!from) throw new HealthError({ code: "eks.health.unit.unknown_from", category: "unit_mismatch", message: `Unknown unit: ${fromId}` });
    if (!to) throw new HealthError({ code: "eks.health.unit.unknown_to", category: "unit_mismatch", message: `Unknown unit: ${toId}` });
    if (from.category !== to.category) {
      throw new HealthError({ code: "eks.health.unit.category_mismatch", category: "unit_mismatch", message: `Cannot convert ${from.category} to ${to.category}.`, userMessage: "Units are not compatible." });
    }
    // Temperature needs special handling (non-linear)
    if (from.category === "temperature") {
      return convertTemperature(value, from.id, to.id);
    }
    // Linear: convert to base, then from base
    const fromFactor = from.toBaseFactor ?? 1;
    const toFactor = to.toBaseFactor ?? 1;
    if (fromFactor === 0 || toFactor === 0) {
      throw new HealthError({ code: "eks.health.unit.no_conversion", category: "unit_mismatch", message: `No conversion path ${fromId} -> ${toId}.` });
    }
    const baseValue = value * fromFactor;
    const result = baseValue / toFactor;
    return round(result, to.precision);
  }

  /** Format a value with its unit, localized. */
  format(value: number, unitId: UnitId, locale = "en-US"): string {
    const unit = this.units.get(unitId);
    if (!unit) return String(value);
    const formatted = value.toLocaleString(locale, { maximumFractionDigits: unit.precision });
    return `${formatted} ${unit.symbol}`;
  }

  /** Round a value to the unit's precision. */
  round(value: number, unitId: UnitId): number {
    const unit = this.units.get(unitId);
    if (!unit) return value;
    return round(value, unit.precision);
  }

  /** Check if two units are compatible (same category). */
  areCompatible(fromId: UnitId, toId: UnitId): boolean {
    const from = this.units.get(fromId);
    const to = this.units.get(toId);
    return !!from && !!to && from.category === to.category;
  }
}

// ---------------------------------------------------------------------------
// Temperature conversion (non-linear)
// ---------------------------------------------------------------------------

function convertTemperature(value: number, from: UnitId, to: UnitId): number {
  // Convert to Celsius first
  let celsius: number;
  if (from === "c") celsius = value;
  else if (from === "f") celsius = (value - 32) * 5 / 9;
  else if (from === "k") celsius = value - 273.15;
  else throw new HealthError({ code: "eks.health.unit.temp_unknown", category: "unit_mismatch", message: `Unknown temperature unit: ${from}` });

  // Convert from Celsius to target
  let result: number;
  if (to === "c") result = celsius;
  else if (to === "f") result = celsius * 9 / 5 + 32;
  else if (to === "k") result = celsius + 273.15;
  else throw new HealthError({ code: "eks.health.unit.temp_unknown", category: "unit_mismatch", message: `Unknown temperature unit: ${to}` });

  return round(result, 1);
}

function round(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: UnitRegistry | null = null;
export function getUnits(): UnitRegistry {
  if (!_registry) _registry = new UnitRegistry();
  return _registry;
}
