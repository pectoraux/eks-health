/** Eks-Health Population Platform — Boot Sequence */
import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity, asAccountId } from "@/identity";
import { bootPrograms } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { bootMissions } from "@/missions";
import { bootDeveloper } from "@/developer";
import { bootMarketplace } from "@/marketplace";
import { bootResearch } from "@/research";
import { bootOrchestrator } from "@/orchestrator";
import { getHierarchy } from "./hierarchy";
import { getMemberships } from "./membership";
import { getPrivacyFirewall } from "./privacy-firewall";
import { getFunding } from "./funding";
import { getCampaigns } from "./campaigns";
import { getPolicies } from "./policies";
import { getPopulationAnalytics } from "./analytics";
import { getOrgTwin } from "./org-twin";
import { getOrgCatalog } from "./org-marketplace";
import { getCoordinator } from "./coordination";
import { getOrgAI } from "./org-ai";
import { POPULATION_EVENTS, asPopulationOrgId, type PopulationOrgId } from "./core";

export interface PopulationInfo { readonly name: string; readonly version: string; readonly bootedAt: string; readonly subsystems: string[]; }
let _booted = false; let _info: PopulationInfo | null = null;

export function bootPopulation(): PopulationInfo {
  if (_booted && _info) return _info;
  bootKernel(); bootIdentity(); bootPrograms(); bootHealth(); bootTechnicians(); bootCompetitions(); bootMissions(); bootDeveloper(); bootMarketplace(); bootResearch(); bootOrchestrator();
  getHierarchy(); getMemberships(); getPrivacyFirewall(); getFunding(); getCampaigns(); getPolicies(); getPopulationAnalytics(); getOrgTwin(); getOrgCatalog(); getCoordinator(); getOrgAI();
  _booted = true;
  _info = { name: "Eks-Health Population Platform", version: "12.0.0-m12", bootedAt: getClock().iso(), subsystems: ["core","hierarchy","membership","privacy-firewall","funding","campaigns","policies","analytics","org-twin","org-marketplace","coordination","org-ai"] };
  void getEventBus().publish(buildEvent(POPULATION_EVENTS.orgCreated, { version: _info.version }, {}, "system"));
  return _info;
}
export function populationInfo(): PopulationInfo { if (!_info) _info = { name: "Eks-Health Population Platform", version: "12.0.0-m12", bootedAt: getClock().iso(), subsystems: [] }; return _info; }

export function populationSnapshot() {
  if (!_booted) bootPopulation();
  const hierarchy = getHierarchy();
  const memberships = getMemberships();
  const privacy = getPrivacyFirewall();
  const funding = getFunding();
  const campaigns = getCampaigns();
  const policies = getPolicies();
  const analytics = getPopulationAnalytics();
  const orgTwin = getOrgTwin();
  const orgCatalog = getOrgCatalog();
  const coordinator = getCoordinator();
  const orgAI = getOrgAI();
  return {
    info: populationInfo(),
    organizations: hierarchy.list().map((o) => ({ id: o.id, name: o.name, slug: o.slug, type: o.type, tier: o.tier, country: o.country, memberCount: o.memberCount, activeMemberCount: o.activeMemberCount, status: o.status, parentId: o.parentId })),
    orgStats: hierarchy.getStats(),
    membership: memberships.getStats(),
    privacy: privacy.getStats(),
    funding: funding.getStats(),
    campaigns: { list: campaigns.list().map((c) => ({ id: c.id, name: c.name, status: c.status, scope: c.scope, participationGoal: c.participationGoal, actualParticipation: c.actualParticipation })), stats: campaigns.getStats() },
    policies: policies.getStats(),
    analytics: { stats: analytics.getStats() },
    orgTwin: orgTwin.getStats(),
    orgCatalog: orgCatalog.getStats(),
    coordination: coordinator.getStats(),
    orgAI: orgAI.getStats(),
  };
}

let _seeded = false;
export function seedPopulationDemoData(): { orgIds: PopulationOrgId[] } {
  if (_seeded) return { orgIds: [] }; if (!_booted) bootPopulation();
  const hierarchy = getHierarchy();
  const memberships = getMemberships();
  const privacy = getPrivacyFirewall();
  const orgIds: PopulationOrgId[] = [];
  const demoOrgs = [
    { name: "Ministry of Health Ghana", slug: "moh-ghana", type: "government" as const, tier: "government" as const, country: "GH", region: "Greater Accra" },
    { name: "Eks-Health Corp", slug: "eks-corp", type: "employer" as const, tier: "enterprise" as const, country: "GH", region: "Greater Accra" },
    { name: "University of Ghana", slug: "ug-edu", type: "university" as const, tier: "premium" as const, country: "GH", region: "Greater Accra" },
    { name: "Accra Wellness NGO", slug: "accra-wellness-ngo", type: "ngo" as const, tier: "standard" as const, country: "GH", region: "Greater Accra" },
  ];
  for (const d of demoOrgs) {
    try {
      const org = hierarchy.create({ name: d.name, slug: d.slug, type: d.type, tier: d.tier, country: d.country, region: d.region, description: `${d.name} — Eks-Health population organization` });
      orgIds.push(org.id);
      // Add demo member
      memberships.invite({ orgId: org.id, accountId: asAccountId("acc_demo_1"), role: "member", invitedBy: asAccountId("acc_demo_1") });
      memberships.accept(memberships.findByOrgAndAccount(org.id, asAccountId("acc_demo_1"))!.id);
      hierarchy.incrementMemberCount(org.id, true);
      // Grant aggregate_performance visibility
      privacy.grant({ participantId: asAccountId("acc_demo_1"), orgId: org.id, grantType: "aggregate_performance", purpose: "Organization wellness analytics", scope: ["aggregate_improvement", "mission_completion_rate"], expiryDays: 365 });
    } catch { /* already exists */ }
  }
  _seeded = true;
  return { orgIds };
}
