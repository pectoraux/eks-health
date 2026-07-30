import { withPlatform, getHealthUnits, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const units = getHealthUnits();
    return {
      units: units.list().map((u) => ({ id: u.id, symbol: u.symbol, name: u.name, category: u.category, system: u.system, precision: u.precision })),
      categories: units.listCategories(),
      systems: ["metric", "imperial", "medical", "custom"],
    };
  });
}
