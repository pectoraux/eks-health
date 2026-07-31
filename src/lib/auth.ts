/**
 * Eks-Health Product Auth — Authentication Helper
 *
 * Production-ready authentication using the Identity Platform's
 * AccountManager + SessionManager. Cookie-based session persistence.
 * Supports: sign in, sign out, waitlist registration, role switching,
 * demo accounts, permanent admin.
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

/** Ensure the permanent admin account exists. */
export function ensureAdminAccount(): void {
  ensurePlatform();
  const accounts = getAccounts();
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

/** Ensure demo accounts exist. */
export function ensureDemoAccounts(): void {
  ensurePlatform();
  const accounts = getAccounts();
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

/** Waitlist entry (stored in memory until approved). */
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

const waitlist: WaitlistEntry[] = [];

export function addToWaitlist(input: {
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason: string;
  referral?: string;
}): WaitlistEntry {
  const entry: WaitlistEntry = {
    id: `wl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...input,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  waitlist.push(entry);
  return entry;
}

export function getWaitlist(): WaitlistEntry[] {
  return [...waitlist];
}

export function approveWaitlistEntry(id: string): WaitlistEntry | undefined {
  const entry = waitlist.find((w) => w.id === id);
  if (!entry) return undefined;
  // Create an actual account
  ensurePlatform();
  const accounts = getAccounts();
  let account = accounts.getByEmail(entry.email);
  if (!account) {
    account = accounts.register({
      email: entry.email,
      password: "Welcome2Eks!",
      displayName: entry.name,
      persona: entry.interestedRoles[0] as never ?? "participant",
    });
    const token = accounts.issueVerificationToken(account.id, entry.email, "email");
    accounts.verifyToken(token);
    for (const role of entry.interestedRoles.slice(1)) {
      accounts.addPersona(account.id, role as never);
    }
  }
  entry.status = "approved";
  entry.accountId = account.id;
  return entry;
}
