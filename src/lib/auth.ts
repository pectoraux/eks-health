/**
 * Eks-Health Product Auth — Authentication Helper
 *
 * Cookie-based session persistence on top of the Identity Platform's
 * AccountManager + SessionManager. The waitlist is DB-backed (Prisma/SQLite)
 * so sign-ups survive server restart. Demo and admin accounts are seeded
 * in-memory on first use.
 */

import "server-only";
import { cookies } from "next/headers";
import {
  getAccounts,
  getSessions,
  asAccountId,
  asSessionId,
  type Account,
} from "@/identity";
import { ensurePlatform } from "@/lib/platform-server";
import {
  dbAddToWaitlist,
  dbGetWaitlist,
  dbGetWaitlistEntry,
  dbApproveWaitlistEntry,
} from "@/lib/db-store";

export interface AuthSession {
  accountId: string;
  email: string;
  displayName: string;
  activePersona: string;
  personas: string[];
  sessionId: string;
  accessToken: string;
  roles: string[];
  isDemo: boolean;
  isAdmin: boolean;
}

const SESSION_COOKIE = "eks_session";
const ACCESS_COOKIE = "eks_access";

/** Get the current session from cookies. */
export async function getSession(): Promise<AuthSession | null> {
  ensurePlatform();
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!accessToken) return null;
  try {
    const session = getSessions().validate(accessToken);
    const account = getAccounts().get(session.accountId);
    if (!account) return null;
    return {
      accountId: account.id,
      email: account.email,
      displayName: account.displayName,
      activePersona: session.persona,
      personas: account.personas,
      sessionId: session.id,
      accessToken: session.accessToken,
      roles: account.personas,
      isDemo: account.email.endsWith("@eks.health"),
      isAdmin: account.email === "ekontetevi@gmail.com",
    };
  } catch {
    return null;
  }
}

/** Require a session — throws if not authenticated. */
export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    throw new Error("Unauthorized");
  }
  return session;
}

/** Set session cookies. */
export async function setSessionCookies(
  accessToken: string,
  _refreshToken: string,
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60, // 7 days
    path: "/",
  });
  cookieStore.set(SESSION_COOKIE, "active", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });
}

/** Clear session cookies. */
export async function clearSessionCookies(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ACCESS_COOKIE);
  cookieStore.delete(SESSION_COOKIE);
}

/** Hydrate accounts from DB, then ensure the permanent admin account exists. */
export async function ensureAdminAccount(): Promise<void> {
  ensurePlatform();
  const accounts = getAccounts();
  await accounts.hydrateFromDb();
  await getSessions().hydrateFromDb();
  const adminEmail = "ekontetevi@gmail.com";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "Payswap123456";

  let admin = accounts.getByEmail(adminEmail);
  if (!admin) {
    try {
      admin = accounts.register({
        email: adminEmail,
        password: adminPassword,
        displayName: "Platform Administrator",
        persona: "platform_admin",
      });
      // Auto-verify
      const token = accounts.issueVerificationToken(admin.id, adminEmail, "email");
      accounts.verifyToken(token);
      // Add all personas
      accounts.addPersona(admin.id, "health_technician");
      accounts.addPersona(admin.id, "developer");
      accounts.addPersona(admin.id, "researcher");
      accounts.addPersona(admin.id, "org_admin");
      accounts.addPersona(admin.id, "marketplace_reviewer");
      accounts.addPersona(admin.id, "support_agent");
      accounts.setMfaEnabled(admin.id, false);
    } catch {
      // Already exists
    }
  }
}

/** Hydrate accounts from DB, then ensure demo accounts exist. */
export async function ensureDemoAccounts(): Promise<void> {
  ensurePlatform();
  const accounts = getAccounts();
  await accounts.hydrateFromDb();
  await getSessions().hydrateFromDb();
  const demoAccounts = [
    { email: "ama@eks.health", name: "Ama Serwaa", persona: "participant" as const },
    { email: "clinic@eks.health", name: "Dr. Adwoa Boateng", persona: "health_technician" as const },
    { email: "kwame@eks.health", name: "Kwame Mensah", persona: "developer" as const },
    { email: "research@eks.health", name: "Prof. Yaw Asante", persona: "researcher" as const },
    { email: "admin@eks.health", name: "Org Administrator", persona: "org_admin" as const },
  ];

  for (const d of demoAccounts) {
    let account = accounts.getByEmail(d.email);
    if (!account) {
      try {
        account = accounts.register({
          email: d.email,
          password: "DemoPass123!",
          displayName: d.name,
          persona: d.persona,
          locale: "en-GH",
          timezone: "Africa/Accra",
        });
        // Auto-verify
        const token = accounts.issueVerificationToken(account.id, d.email, "email");
        accounts.verifyToken(token);
      } catch {
        // Already exists
      }
    }
  }
}

/** Waitlist entry (DB-backed). */
export interface WaitlistEntry {
  id: string;
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason: string;
  referral?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  accountId?: string;
}

export async function addToWaitlist(input: {
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason: string;
  referral?: string;
}): Promise<WaitlistEntry> {
  return dbAddToWaitlist(input);
}

export async function getWaitlist(): Promise<WaitlistEntry[]> {
  return dbGetWaitlist();
}

export async function approveWaitlistEntry(id: string): Promise<WaitlistEntry | undefined> {
  const entry = await dbGetWaitlistEntry(id);
  if (!entry) return undefined;
  // Create an actual in-memory account (demo/admin seeding path).
  ensurePlatform();
  const accounts = getAccounts();
  let account = accounts.getByEmail(entry.email);
  if (!account) {
    account = accounts.register({
      email: entry.email,
      password: "Welcome2Eks!",
      displayName: entry.name,
      persona: (entry.interestedRoles[0] as never) ?? "participant",
    });
    const token = accounts.issueVerificationToken(account.id, entry.email, "email");
    accounts.verifyToken(token);
    for (const role of entry.interestedRoles.slice(1)) {
      accounts.addPersona(account.id, role as never);
    }
  }
  const updated = await dbApproveWaitlistEntry(id, account.id);
  return updated ?? undefined;
}
