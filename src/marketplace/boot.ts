/** Eks-Health Health Marketplace — Boot Sequence */
import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity } from "@/identity";
import { bootPrograms } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { bootMissions } from "@/missions";
import { bootDeveloper } from "@/developer";
import { getDiscovery } from "./discovery";
import { getMatching } from "./matching";
import { getOutcomes } from "./outcomes";
import { getEvidence } from "./evidence";
import { getProfiles } from "./profiles";
import { getComparison } from "./comparison";
import { getCollections } from "./collections";
import { getMonetization } from "./monetization";
import { getRevenue } from "./revenue";
import { getReviews } from "./reviews";
import { getMarketplaceAnalytics } from "./analytics";
import { MARKETPLACE_EVENTS } from "./core";
import { asProgramId } from "@/programs";

export interface MarketplaceInfo { readonly name: string; readonly version: string; readonly bootedAt: string; readonly subsystems: string[]; }
let _booted = false; let _info: MarketplaceInfo | null = null;

export function bootMarketplace(): MarketplaceInfo {
  if (_booted && _info) return _info;
  bootKernel(); bootIdentity(); bootPrograms(); bootHealth(); bootTechnicians(); bootCompetitions(); bootMissions(); bootDeveloper();
  getDiscovery(); getMatching(); getOutcomes(); getEvidence(); getProfiles(); getComparison(); getCollections(); getMonetization(); getRevenue(); getReviews(); getMarketplaceAnalytics();
  _booted = true;
  _info = { name: "Eks-Health Health Marketplace", version: "9.0.0-m9", bootedAt: getClock().iso(), subsystems: ["core","discovery","matching","outcomes","evidence","profiles","comparison","collections","monetization","revenue","reviews","analytics"] };
  void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.listingPublished, { version: _info.version }, {}, "system"));
  return _info;
}
export function marketplaceInfo(): MarketplaceInfo { if (!_info) _info = { name: "Eks-Health Health Marketplace", version: "9.0.0-m9", bootedAt: getClock().iso(), subsystems: [] }; return _info; }

export function marketplaceSnapshot() {
  if (!_booted) bootMarketplace();
  const profiles = getProfiles();
  const discovery = getDiscovery();
  const outcomes = getOutcomes();
  const evidence = getEvidence();
  const reviews = getReviews();
  const collections = getCollections();
  const monetization = getMonetization();
  const revenue = getRevenue();
  const analytics = getMarketplaceAnalytics();
  const matching = getMatching();
  return {
    info: marketplaceInfo(),
    listings: profiles.list().map((l) => ({
      id: l.id, name: l.solution.name, tagline: l.solution.tagline, category: l.solution.category,
      bodySystems: l.solution.bodySystems, healthGoals: l.solution.healthGoals,
      status: l.status, developerName: l.developerName, pricing: l.pricing,
      supportedCountries: l.supportedCountries, supportedLanguages: l.supportedLanguages,
      estimatedEffortHoursPerWeek: l.estimatedEffortHoursPerWeek,
      installCount: l.installCount, activeInstallCount: l.activeInstallCount,
      publishedAt: l.publishedAt, version: l.version,
    })),
    listingStats: profiles.getStats(),
    discovery: discovery.getStats(),
    outcomes: { stats: outcomes.getStats(), top: outcomes.getTopOutcomes(5) },
    evidence: evidence.getStats(),
    reviews: reviews.getStats(),
    collections: { list: collections.list().map((c) => ({ id: c.id, name: c.name, description: c.description, category: c.category, listingCount: c.listingIds.length })), stats: collections.getStats() },
    monetization: monetization.getStats(),
    revenue: revenue.getStats(),
    analytics: analytics.getMarketplaceStats(),
    matching: matching.getStats(),
  };
}

let _seeded = false;
export function seedMarketplaceDemoData(): void {
  if (_seeded) return; if (!_booted) bootMarketplace();
  const profiles = getProfiles();
  const programId = asProgramId("prg_cardio_care");
  const demoListings = [
    { name: "Cardio Care", tagline: "Preventive cardiovascular health program", category: "cardiovascular" as never, bodySystems: ["cardiovascular"] as never, goals: ["reduce blood pressure", "improve heart health"], symptoms: ["high blood pressure"], lifestyle: ["more energy"], pricing: { type: "freemium" as never, freeTierFeatures: ["basic tracking"], premiumTierFeatures: ["AI coaching", "personalized plans"] }, effort: 3 },
    { name: "Sleep Optimizer", tagline: "AI-powered sleep improvement", category: "sleep_optimization" as never, bodySystems: ["nervous"] as never, goals: ["better sleep", "reduce fatigue"], symptoms: ["poor sleep", "insomnia"], lifestyle: ["more energy"], pricing: { type: "subscription" as never, price: 9.99, currency: "USD", subscriptionPeriod: "monthly" as const }, effort: 1 },
    { name: "FitStreak", tagline: "Gamified fitness with competitions", category: "fitness" as never, bodySystems: ["cardiovascular", "musculoskeletal"] as never, goals: ["lose weight", "get fit", "more steps"], symptoms: [], lifestyle: ["more energy", "stress reduction"], pricing: { type: "free" as const }, effort: 5 },
    { name: "Mindful Daily", tagline: "Daily mental wellness practices", category: "mental_wellness" as never, bodySystems: ["mental"] as never, goals: ["reduce stress", "better mental health"], symptoms: ["anxiety", "stress"], lifestyle: ["stress reduction"], pricing: { type: "freemium" as never, freeTierFeatures: ["daily meditation"], premiumTierFeatures: ["AI therapist"] }, effort: 2 },
    { name: "Nutrition Coach", tagline: "Personalized nutrition with AI", category: "nutrition" as never, bodySystems: ["metabolic", "digestive"] as never, goals: ["eat better", "lose weight"], symptoms: [], lifestyle: ["more energy"], pricing: { type: "subscription" as never, price: 14.99, currency: "USD", subscriptionPeriod: "monthly" as const }, effort: 4 },
  ];
  for (const d of demoListings) {
    try {
      profiles.publish({
        programId, name: d.name, tagline: d.tagline, description: d.tagline,
        category: d.category, bodySystems: d.bodySystems as never,
        healthGoals: d.goals, symptoms: d.symptoms, lifestyleGoals: d.lifestyle,
        developerId: "dev_demo_1", developerName: "Demo Developer",
        supportedCountries: ["GH", "NG", "KE", "ZA", "*"], supportedLanguages: ["en", "fr", "sw"],
        measurementRequirements: ["blood_pressure"], technicianRequirements: ["health_technician"],
        estimatedEffortHoursPerWeek: d.effort, pricing: d.pricing as never,
        supportedDevices: ["blood_pressure_monitor", "smartwatch"], privacyPractices: ["measurements encrypted", "consent-gated access"],
        version: "1.0.0",
      });
    } catch { /* already exists */ }
  }
  _seeded = true;
}
