/**
 * DB-backed persistence layer.
 *
 * First slice of real persistence for Eks-Health. Backs the waitlist with
 * SQLite via Prisma so that sign-ups survive server restart. The rest of the
 * platform still runs on in-memory managers and will be migrated later.
 */

import "server-only";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export interface WaitlistRecord {
  id: string;
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason: string;
  referral?: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  approvedAt?: string | null;
  accountId?: string | null;
}

export async function dbAddToWaitlist(input: {
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason: string;
  referral?: string;
}): Promise<WaitlistRecord> {
  const row = await db.eksWaitlistEntry.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase().trim(),
      country: input.country,
      interestedRoles: input.interestedRoles.join(","),
      reason: input.reason,
      referral: input.referral ?? null,
      status: "pending",
    },
  });
  return rowToWaitlist(row);
}

export async function dbGetWaitlist(): Promise<WaitlistRecord[]> {
  const rows = await db.eksWaitlistEntry.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(rowToWaitlist);
}

export async function dbGetWaitlistEntry(id: string): Promise<WaitlistRecord | null> {
  const row = await db.eksWaitlistEntry.findUnique({ where: { id } });
  return row ? rowToWaitlist(row) : null;
}

export async function dbApproveWaitlistEntry(
  id: string,
  accountId: string,
): Promise<WaitlistRecord | null> {
  const row = await db.eksWaitlistEntry.update({
    where: { id },
    data: { status: "approved", approvedAt: new Date(), accountId },
  });
  return row ? rowToWaitlist(row) : null;
}

function rowToWaitlist(row: {
  id: string;
  name: string;
  email: string;
  country: string;
  interestedRoles: string;
  reason: string;
  referral: string | null;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  accountId?: string | null;
}): WaitlistRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    country: row.country,
    interestedRoles: row.interestedRoles ? row.interestedRoles.split(",").filter(Boolean) : [],
    reason: row.reason,
    referral: row.referral ?? undefined,
    status: row.status as WaitlistRecord["status"],
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    accountId: row.accountId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Accounts (DB-backed registration, mirrored into in-memory AccountManager)
// ---------------------------------------------------------------------------

export interface DbaAccount {
  id: string;
  email: string;
  displayName: string;
  state: string;
  personas: string[];
  activePersona: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  isDemo: boolean;
  isAdmin: boolean;
  locale: string | null;
  timezone: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export async function dbCreateAccount(input: {
  id: string;
  email: string;
  displayName: string;
  persona: string;
  passwordHash?: string;
  passwordSalt?: string;
  locale?: string;
  timezone?: string;
  isDemo?: boolean;
  isAdmin?: boolean;
}): Promise<DbaAccount> {
  const row = await db.eksAccount.create({
    data: {
      id: input.id,
      email: input.email.toLowerCase().trim(),
      displayName: input.displayName,
      state: "active",
      personas: input.persona,
      activePersona: input.persona,
      passwordHash: input.passwordHash ?? null,
      passwordSalt: input.passwordSalt ?? null,
      isDemo: input.isDemo ?? false,
      isAdmin: input.isAdmin ?? false,
      locale: input.locale ?? null,
      timezone: input.timezone ?? null,
    },
  });
  return rowToAccount(row);
}

export async function dbGetAccountByEmail(email: string): Promise<DbaAccount | null> {
  const row = await db.eksAccount.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  return row ? rowToAccount(row) : null;
}

export async function dbGetAccountById(id: string): Promise<DbaAccount | null> {
  const row = await db.eksAccount.findUnique({ where: { id } });
  return row ? rowToAccount(row) : null;
}

export async function dbListAccounts(): Promise<DbaAccount[]> {
  const rows = await db.eksAccount.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(rowToAccount);
}

export async function dbTouchSignIn(id: string): Promise<void> {
  await db.eksAccount.update({
    where: { id },
    data: { lastSignInAt: new Date() },
  });
}

function rowToAccount(row: {
  id: string;
  email: string;
  displayName: string;
  state: string;
  personas: string;
  activePersona: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  mfaEnabled: boolean;
  isDemo: boolean;
  isAdmin: boolean;
  locale: string | null;
  timezone: string | null;
  createdAt: Date;
  lastSignInAt: Date | null;
}): DbaAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    state: row.state,
    personas: row.personas ? row.personas.split(",").filter(Boolean) : [],
    activePersona: row.activePersona,
    passwordHash: row.passwordHash,
    passwordSalt: row.passwordSalt,
    isDemo: row.isDemo,
    isAdmin: row.isAdmin,
    locale: row.locale,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
    lastSignInAt: row.lastSignInAt ? row.lastSignInAt.toISOString() : null,
  };
}
