/**
 * Eks-Health Technician Network — Boot Sequence
 *
 * Idempotently initializes the technician platform, seeds demo
 * technicians, certifications, appointments, and sessions, and emits
 * the platform started technician event.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity, asAccountId, asOrgId } from "@/identity";
import { bootPrograms, asProgramId } from "@/programs";
import { bootHealth } from "@/health";
import { getTechnicians } from "./profiles";
import { getCertifications } from "./certifications";
import { getAccreditation } from "./accreditation";
import { getEligibility } from "./eligibility";
import { getSessions } from "./sessions";
import { getAppointments } from "./appointments";
import { getDiscovery } from "./discovery";
import { getReputation } from "./reputation";
import { getDisputes } from "./disputes";
import { getDevices } from "./devices";
import { getChainOfCustody } from "./chain-of-custody";
import { getFraudDetection } from "./fraud";
import { getPayments } from "./payments";
import { TECHNICIAN_EVENTS, asTechnicianId, type TechnicianId } from "./core";

export interface TechniciansInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: TechniciansInfo | null = null;

export function bootTechnicians(): TechniciansInfo {
  if (_booted && _info) return _info;
  bootKernel();
  bootIdentity();
  bootPrograms();
  bootHealth();

  getTechnicians();
  getCertifications();
  getAccreditation();
  getEligibility();
  getSessions();
  getAppointments();
  getDiscovery();
  getReputation();
  getDisputes();
  getDevices();
  getChainOfCustody();
  getFraudDetection();
  getPayments();

  _booted = true;
  _info = {
    name: "Eks-Health Technician Network",
    version: "5.0.0-m5",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "profiles", "certifications", "accreditation", "eligibility",
      "sessions", "appointments", "discovery", "reputation", "disputes",
      "devices", "chain-of-custody", "fraud", "payments",
    ],
  };
  void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.technicianRegistered, { version: _info.version }, {}, "system"));
  return _info;
}

export function techniciansInfo(): TechniciansInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Technician Network",
      version: "5.0.0-m5",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

/** Compact diagnostic snapshot for the console. */
export function techniciansSnapshot() {
  ensureBooted();
  const techs = getTechnicians();
  const certs = getCertifications();
  const accred = getAccreditation();
  const sessions = getSessions();
  const appts = getAppointments();
  const reputation = getReputation();
  const disputes = getDisputes();
  const devices = getDevices();
  const fraud = getFraudDetection();
  const payments = getPayments();

  return {
    info: techniciansInfo(),
    technicians: techs.list().map((t) => ({
      id: t.id, accountId: t.accountId, category: t.category, displayName: t.displayName,
      languages: t.languages, regionsServed: t.regionsServed, skills: t.skills,
      supportedPrograms: t.supportedPrograms, rating: t.rating, reviewCount: t.reviewCount,
      totalSessions: t.totalSessions, verifiedSessions: t.verifiedSessions,
      disputedSessions: t.disputedSessions, status: t.status, createdAt: t.createdAt,
    })),
    technicianStats: techs.getStats(),
    certifications: {
      types: certs.listTypes().map((t) => ({ id: t.id, slug: t.slug, name: t.name, category: t.category, level: t.level, requiresRenewal: t.requiresRenewal })),
      stats: certs.getStats(),
    },
    accreditation: {
      authorities: accred.listAuthorities().map((a) => ({ id: a.id, name: a.name, type: a.type, jurisdiction: a.jurisdiction, verified: a.verified, trustLevel: a.trustLevel })),
      stats: accred.getStats(),
    },
    sessions: {
      recent: sessions.list({}).slice(0, 20).map((s) => ({
        id: s.id, participantId: s.participantId, technicianId: s.technicianId,
        programId: s.programId, status: s.status, scheduledAt: s.scheduledAt,
        measurementCount: s.recordedMeasurements.length, evidenceCount: s.evidenceIds.length,
      })),
      stats: sessions.getStats?.() ?? { total: sessions.list().length },
    },
    appointments: {
      recent: appts.list({}).slice(0, 20).map((a) => ({
        id: a.id, participantId: a.participantId, technicianId: a.technicianId,
        programId: a.programId, status: a.status, scheduledAt: a.scheduledAt,
        durationMinutes: a.durationMinutes, sessionType: a.sessionType,
      })),
    },
    reputation: {
      profiles: techs.list().map((t) => {
        const rep = reputation.get(t.id);
        return rep ? { technicianId: t.id, overallScore: rep.overallScore, trend: rep.trend, reviewCount: rep.reviewCount } : null;
      }).filter(Boolean),
    },
    disputes: {
      stats: disputes.getStats(),
      recent: disputes.list({}).slice(0, 10).map((d) => ({
        id: d.id, status: d.status, reason: d.reason, openedAt: d.openedAt, technicianId: d.technicianId,
      })),
    },
    devices: {
      recent: devices.list().slice(0, 20).map((d) => ({
        id: d.id, serialNumber: d.serialNumber, model: d.model, type: d.type,
        trustLevel: d.trustLevel, status: d.status, certified: d.certified,
      })),
    },
    fraud: {
      stats: fraud.getStats(),
      recentAlerts: fraud.listAlerts({}).slice(0, 10).map((a) => ({
        id: a.id, type: a.type, severity: a.severity, status: a.status, detectedAt: a.detectedAt,
      })),
    },
    payments: {
      providers: payments.listProviders().map((p) => ({ id: p.id, configured: p.isConfigured() })),
      recentIntents: payments.listIntents({}).slice(0, 10).map((i) => ({
        id: i.id, provider: i.provider, amount: i.amount, currency: i.currency, status: i.status, reference: i.reference,
      })),
    },
  };
}

function ensureBooted() {
  if (!_booted) bootTechnicians();
}

// ---------------------------------------------------------------------------
// Demo data seeding
// ---------------------------------------------------------------------------

let _seeded = false;

export function seedTechnicianDemoData(): { technicianIds: TechnicianId[] } {
  if (_seeded) return { technicianIds: [] };
  ensureBooted();

  const techs = getTechnicians();
  const certs = getCertifications();
  const accred = getAccreditation();
  const devices = getDevices();
  const programId = asProgramId("prg_cardio_care");
  const technicianIds: TechnicianId[] = [];

  // Register an accreditation authority
  let authorityId: string;
  try {
    const auth = accred.registerAuthority({
      name: "Ghana Ministry of Health",
      type: "government",
      description: "National health authority of Ghana",
      jurisdiction: "GH",
      trustLevel: "authoritative",
      verified: true,
      contactEmail: "certs@moh.gov.gh",
    });
    accred.trustAuthority(auth.id, programId);
    authorityId = auth.id;
  } catch {
    authorityId = "auth_demo_1";
  }

  // Define certification types
  const certTypeSlugs = [
    { slug: "licensed_nurse", name: "Licensed Nurse", category: "clinical", level: "advanced", skills: ["blood_pressure", "phlebotomy", "vitals"] },
    { slug: "blood_pressure_training", name: "Blood Pressure Measurement Training", category: "clinical", level: "basic", skills: ["blood_pressure"] },
    { slug: "ecg_technician", name: "ECG Technician", category: "cardiovascular", level: "intermediate", skills: ["ecg", "heart_rate"] },
    { slug: "phlebotomist", name: "Certified Phlebotomist", category: "laboratory", level: "intermediate", skills: ["phlebotomy", "blood_sugar"] },
  ];
  const certTypeIds: Record<string, string> = {};
  for (const ct of certTypeSlugs) {
    try {
      const type = certs.defineType({
        slug: ct.slug, name: ct.name, description: `${ct.name} certification`, category: ct.category,
        level: ct.level as never, issuingAuthorityType: "government", requiresRenewal: true, validityDays: 730,
        requiresContinuingEducation: true, ceHoursRequired: 20, cePeriodDays: 365,
        skills: ct.skills, acceptedInRegions: ["GH", "NG", "KE"], createdBy: "platform",
      });
      certTypeIds[ct.slug] = type.id;
    } catch {
      // already exists
    }
  }

  // Register demo technicians
  const demoTechs = [
    { name: "Dr. Abena Owusu", category: "individual", accountId: "acc_demo_2", skills: ["blood_pressure", "ecg", "vitals"], regions: ["GH"], languages: ["en", "tw"] },
    { name: "Nurse Kwesi Asare", category: "individual", accountId: "acc_demo_3", skills: ["blood_pressure", "phlebotomy", "vitals"], regions: ["GH"], languages: ["en", "ga"] },
    { name: "Akosua Mensah", category: "mobile", accountId: "acc_demo_4", skills: ["blood_pressure", "blood_sugar"], regions: ["GH"], languages: ["en", "tw"] },
  ];

  for (const dt of demoTechs) {
    try {
      const tech = techs.register({
        accountId: asAccountId(dt.accountId),
        category: dt.category as never,
        displayName: dt.name,
        bio: `Certified health technician serving ${dt.regions.join(", ")}.`,
        languages: dt.languages,
        regionsServed: dt.regions,
        skills: dt.skills,
        equipment: ["blood_pressure_monitor", "glucometer"],
        timezone: "Africa/Accra",
        supportedPrograms: [programId],
      });
      // Grant certifications
      for (const [slug, typeId] of Object.entries(certTypeIds)) {
        if (dt.skills.some((s) => certTypeSlugs.find((c) => c.slug === slug)?.skills.includes(s))) {
          try {
            certs.grant({
              typeId: typeId as never,
              technicianId: tech.id,
              issuedBy: asAccountId("acc_demo_1"),
              issuingAuthorityId: authorityId as never,
              issuingAuthorityName: "Ghana Ministry of Health",
            });
          } catch { /* already granted */ }
        }
      }
      // Register a device
      try {
        devices.register({
          serialNumber: `DEV-${tech.id.slice(-6).toUpperCase()}`,
          model: "Omron HEM-7156T",
          manufacturer: "Omron",
          firmwareVersion: "1.2.0",
          type: "blood_pressure_monitor",
          ownerId: tech.accountId,
          capabilities: ["blood_pressure"],
        });
      } catch { /* already exists */ }
      technicianIds.push(tech.id);
    } catch {
      // already exists
    }
  }

  // Seed demo session data and ratings for technicians
  for (const techId of technicianIds) {
    // Record some sessions
    for (let i = 0; i < 15; i++) {
      techs.recordSession(techId, true, false);
    }
    // Give them a rating
    techs.updateRating(techId, 4.5 + Math.random() * 0.5, 10 + Math.floor(Math.random() * 20));
    // Seed reputation
    try {
      const rep = getReputation();
      const repProfile = rep.getOrCreate(techId);
      // Record some feedback
      rep.recordFeedback({
        id: `fb_${techId.slice(-6)}`,
        technicianId: techId,
        fromParticipantId: asAccountId("acc_demo_1"),
        rating: 5,
        comment: "Excellent service, very professional.",
        factors: { accuracy: 95, consistency: 90, participant_feedback: 92, verification_quality: 88, dispute_rate: 5, completion_rate: 95, response_time: 85 },
        submittedAt: getClock().iso(),
      });
    } catch { /* ignore */ }
  }

  _seeded = true;
  return { technicianIds };
}
