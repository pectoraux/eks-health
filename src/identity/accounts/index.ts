/**
 * Eks-Health Identity — Accounts
 *
 * User account lifecycle: registration, verification, persona management,
 * multi-role accounts, contact info, account states. Accounts are the
 * persistent identity; principals (sessions) are derived from them.
 *
 * Security: passwords are hashed (PBKDF2 via node:crypto), never stored
 * in plaintext. Account lockout after repeated failures. Verification
 * tokens are single-use and time-bound.
 */

import "server-only";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AccountId,
  type Persona,
  type ContactInfo,
  type PersonaDescriptor,
  IdentityError,
  IDENTITY_EVENTS,
  asAccountId,
  ALL_PERSONAS,
} from "../core";
import { getEventBus, buildEvent, getClock, generateId } from "@/kernel";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export type AccountState = "unverified" | "active" | "suspended" | "locked" | "deleted";

export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly displayName: string;
  readonly state: AccountState;
  readonly personas: Persona[];
  readonly activePersona: Persona;
  readonly contacts: ContactInfo[];
  readonly passwordHash?: string; // PBKDF2
  readonly passwordSalt?: string;
  readonly mfaEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSignInAt?: string;
  readonly failedSignInAttempts: number;
  readonly lockedUntil?: string;
  readonly tenantId?: string;
  readonly avatarUrl?: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly marketingConsent?: boolean;
}

export interface RegistrationInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly persona?: Persona;
  readonly locale?: string;
  readonly timezone?: string;
}

export interface PersonaSwitchResult {
  readonly account: Account;
  readonly previousPersona: Persona;
  readonly newPersona: Persona;
}

// ---------------------------------------------------------------------------
// Persona catalog
// ---------------------------------------------------------------------------

export const PERSONAS: readonly PersonaDescriptor[] = [
  {
    persona: "participant",
    label: "Participant",
    description: "An individual tracking their own preventive health.",
    defaultPermissions: ["self:read", "self:write", "measurement:self:read", "consent:manage"],
    sensitive: false,
  },
  {
    persona: "health_technician",
    label: "Health Technician",
    description: "Clinical staff who collect measurements on behalf of participants.",
    defaultPermissions: ["measurement:collect", "participant:limited:read"],
    sensitive: true,
  },
  {
    persona: "developer",
    label: "Developer",
    description: "Builds Programs and extensions on the platform.",
    defaultPermissions: ["developer:console", "extension:create", "marketplace:publish"],
    sensitive: false,
  },
  {
    persona: "researcher",
    label: "Researcher",
    description: "Requests access to de-identified data for approved studies.",
    defaultPermissions: ["research:request", "research:dataset:read"],
    sensitive: true,
  },
  {
    persona: "org_admin",
    label: "Organization Administrator",
    description: "Manages an organization, its members and policies.",
    defaultPermissions: ["org:manage", "org:members:manage", "org:policy:manage"],
    sensitive: true,
  },
  {
    persona: "platform_admin",
    label: "Platform Administrator",
    description: "Operates the platform itself. Highest privilege.",
    defaultPermissions: ["platform:*"],
    sensitive: true,
  },
  {
    persona: "marketplace_reviewer",
    label: "Marketplace Reviewer",
    description: "Reviews and approves Program listings.",
    defaultPermissions: ["marketplace:review", "marketplace:approve", "marketplace:reject"],
    sensitive: true,
  },
  {
    persona: "support_agent",
    label: "Support Agent",
    description: "Assists users with account and access issues.",
    defaultPermissions: ["support:ticket:read", "support:ticket:respond", "account:limited:read"],
    sensitive: true,
  },
];

export function personaDescriptor(p: Persona): PersonaDescriptor {
  return PERSONAS.find((x) => x.persona === p)!;
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2 — no plaintext, no reversible storage)
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = "sha256";

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, s, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return { hash, salt: s };
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Hash a verification token (email/phone) for single-use storage. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Verification tokens
// ---------------------------------------------------------------------------

export interface VerificationToken {
  readonly tokenHash: string;
  readonly subject: string; // email or phone
  readonly type: "email" | "phone" | "password_reset";
  readonly expiresAt: string;
  readonly consumed: boolean;
  readonly accountId: AccountId;
}

// ---------------------------------------------------------------------------
// Account manager
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export class AccountManager {
  private readonly accounts = new Map<AccountId, Account>();
  private readonly byEmail = new Map<string, AccountId>();
  private readonly tokens = new Map<string, VerificationToken>();

  register(input: RegistrationInput): Account {
    const email = input.email.toLowerCase().trim();
    if (!email.includes("@")) {
      throw new IdentityError({
        code: "eks.identity.account.invalid_email",
        category: "validation",
        message: "Invalid email address.",
        userMessage: "Please enter a valid email address.",
      });
    }
    if (input.password.length < 8) {
      throw new IdentityError({
        code: "eks.identity.account.weak_password",
        category: "validation",
        message: "Password must be at least 8 characters.",
        userMessage: "Password must be at least 8 characters.",
      });
    }
    if (this.byEmail.has(email)) {
      throw new IdentityError({
        code: "eks.identity.account.already_exists",
        category: "conflict",
        message: `Account already exists for ${email}.`,
        userMessage: "An account with this email already exists.",
      });
    }
    const { hash, salt } = hashPassword(input.password);
    const persona = input.persona ?? "participant";
    const now = getClock().iso();
    const account: Account = {
      id: asAccountId(generateId("acc_")),
      email,
      displayName: input.displayName,
      state: "unverified",
      personas: [persona],
      activePersona: persona,
      contacts: [{ type: "email", value: email, verified: false, primary: true }],
      passwordHash: hash,
      passwordSalt: salt,
      mfaEnabled: false,
      createdAt: now,
      updatedAt: now,
      failedSignInAttempts: 0,
      locale: input.locale,
      timezone: input.timezone,
    };
    this.accounts.set(account.id, account);
    this.byEmail.set(email, account.id);
    void this._persist(account.id);

    // Issue email verification token
    this.issueVerificationToken(account.id, email, "email");

    void getEventBus().publish(
      buildEvent(IDENTITY_EVENTS.accountRegistered, { accountId: account.id, email, persona }, {}, "domain"),
    );
    return account;
  }

  get(id: AccountId): Account | undefined {
    return this.accounts.get(id);
  }

  getByEmail(email: string): Account | undefined {
    const id = this.byEmail.get(email.toLowerCase().trim());
    return id ? this.accounts.get(id) : undefined;
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  /** Verify credentials WITHOUT issuing a session. Used by the auth flow. */
  verifyCredentials(email: string, password: string): Account {
    const account = this.getByEmail(email);
    if (!account) {
      throw new IdentityError({
        code: "eks.identity.account.not_found",
        category: "account_not_found",
        message: `No account for ${email}.`,
        userMessage: "No account found with this email.",
      });
    }
    if (account.state === "locked" && account.lockedUntil) {
      if (new Date(account.lockedUntil).getTime() > Date.now()) {
        throw new IdentityError({
          code: "eks.identity.account.locked",
          category: "account_locked",
          message: `Account locked until ${account.lockedUntil}.`,
          userMessage: "Account temporarily locked. Try again later.",
          retryable: true,
        });
      }
    }
    if (account.state === "suspended" || account.state === "deleted") {
      throw new IdentityError({
        code: "eks.identity.account.disabled",
        category: "account_disabled",
        message: `Account state is ${account.state}.`,
        userMessage: "This account has been disabled.",
      });
    }
    if (!account.passwordHash || !account.passwordSalt || !verifyPassword(password, account.passwordHash, account.passwordSalt)) {
      this.recordFailedAttempt(account.id);
      throw new IdentityError({
        code: "eks.identity.account.invalid_credentials",
        category: "invalid_credentials",
        message: "Invalid password.",
        userMessage: "Incorrect email or password.",
      });
    }
    // Reset failed attempts on success
    this.update(account.id, { failedSignInAttempts: 0, lockedUntil: undefined, lastSignInAt: getClock().iso() });
    return this.accounts.get(account.id)!;
  }

  private recordFailedAttempt(id: AccountId): void {
    const account = this.accounts.get(id);
    if (!account) return;
    const attempts = account.failedSignInAttempts + 1;
    const updates: { failedSignInAttempts: number; lockedUntil?: string; state?: AccountState } = { failedSignInAttempts: attempts };
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      updates.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
      updates.state = "locked";
      void getEventBus().publish(
        buildEvent(IDENTITY_EVENTS.accountLocked, { accountId: id, attempts, lockedUntil: updates.lockedUntil }, {}, "domain"),
      );
    }
    this.update(id, updates);
  }

  /** Issue a single-use verification token; returns the raw token (shown once). */
  issueVerificationToken(accountId: AccountId, subject: string, type: VerificationToken["type"]): string {
    const raw = randomBytes(6).toString("hex").toUpperCase(); // 12-char code
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    this.tokens.set(tokenHash, { tokenHash, subject, type, expiresAt, consumed: false, accountId });
    return raw;
  }

  /** Consume a verification token; returns the account if valid. */
  verifyToken(raw: string): Account {
    const tokenHash = hashToken(raw.toUpperCase());
    const token = this.tokens.get(tokenHash);
    if (!token) {
      throw new IdentityError({
        code: "eks.identity.verification.invalid",
        category: "verification_required",
        message: "Invalid verification token.",
        userMessage: "This verification code is invalid.",
      });
    }
    if (token.consumed) {
      throw new IdentityError({
        code: "eks.identity.verification.consumed",
        category: "verification_required",
        message: "Token already used.",
        userMessage: "This code has already been used.",
      });
    }
    if (new Date(token.expiresAt).getTime() < Date.now()) {
      throw new IdentityError({
        code: "eks.identity.verification.expired",
        category: "verification_required",
        message: "Token expired.",
        userMessage: "This code has expired. Request a new one.",
      });
    }
    this.tokens.set(tokenHash, { ...token, consumed: true });
    // Mark contact verified & activate account if it was unverified
    const account = this.accounts.get(token.accountId);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Account gone." });
    const contacts = account.contacts.map((c) =>
      c.value === token.subject ? { ...c, verified: true, verifiedAt: getClock().iso() } : c,
    );
    const state = account.state === "unverified" ? "active" : account.state;
    this.update(token.accountId, { contacts, state });
    void getEventBus().publish(
      buildEvent(IDENTITY_EVENTS.accountVerified, { accountId: account.id, subject: token.subject, type: token.type }, {}, "domain"),
    );
    return this.accounts.get(token.accountId)!;
  }

  addPersona(accountId: AccountId, persona: Persona): Account {
    const account = this.accounts.get(accountId);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Account not found." });
    if (account.personas.includes(persona)) return account;
    this.update(accountId, { personas: [...account.personas, persona] });
    void getEventBus().publish(
      buildEvent(IDENTITY_EVENTS.roleAssigned, { accountId, persona }, {}, "domain"),
    );
    return this.accounts.get(accountId)!;
  }

  switchPersona(accountId: AccountId, persona: Persona): PersonaSwitchResult {
    const account = this.accounts.get(accountId);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Account not found." });
    if (!account.personas.includes(persona)) {
      throw new IdentityError({
        code: "eks.identity.persona.not_held",
        category: "permission_denied",
        message: `Account does not hold persona ${persona}.`,
        userMessage: "You don't have this role.",
      });
    }
    const previous = account.activePersona;
    this.update(accountId, { activePersona: persona });
    void getEventBus().publish(
      buildEvent(IDENTITY_EVENTS.personaSwitched, { accountId, from: previous, to: persona }, {}, "domain"),
    );
    return { account: this.accounts.get(accountId)!, previousPersona: previous, newPersona: persona };
  }

  setMfaEnabled(accountId: AccountId, enabled: boolean): Account {
    this.update(accountId, { mfaEnabled: enabled });
    if (enabled) {
      void getEventBus().publish(buildEvent(IDENTITY_EVENTS.mfaEnabled, { accountId }, {}, "domain"));
    }
    return this.accounts.get(accountId)!;
  }

  changePassword(accountId: AccountId, currentPassword: string, newPassword: string): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Not found." });
    if (!account.passwordHash || !account.passwordSalt || !verifyPassword(currentPassword, account.passwordHash, account.passwordSalt)) {
      throw new IdentityError({ code: "eks.identity.account.invalid_credentials", category: "invalid_credentials", message: "Current password wrong.", userMessage: "Your current password is incorrect." });
    }
    if (newPassword.length < 8) {
      throw new IdentityError({ code: "eks.identity.account.weak_password", category: "validation", message: "Password too short.", userMessage: "New password must be at least 8 characters." });
    }
    const { hash, salt } = hashPassword(newPassword);
    this.update(accountId, { passwordHash: hash, passwordSalt: salt });
  }

  requestPasswordReset(email: string): string {
    const account = this.getByEmail(email);
    if (!account) return ""; // do not leak account existence
    return this.issueVerificationToken(account.id, account.email, "password_reset");
  }

  resetPassword(token: string, newPassword: string): Account {
    const account = this.verifyToken(token); // consumes the token
    if (newPassword.length < 8) {
      throw new IdentityError({ code: "eks.identity.account.weak_password", category: "validation", message: "Too short.", userMessage: "Password must be at least 8 characters." });
    }
    const { hash, salt } = hashPassword(newPassword);
    this.update(account.id, { passwordHash: hash, passwordSalt: salt });
    return this.accounts.get(account.id)!;
  }

  suspend(accountId: AccountId): Account {
    this.update(accountId, { state: "suspended" });
    return this.accounts.get(accountId)!;
  }

  private update(id: AccountId, updates: Partial<Account>): void {
    const existing = this.accounts.get(id);
    if (!existing) return;
    this.accounts.set(id, { ...existing, ...updates as Account, updatedAt: getClock().iso() });
    void this._persist(id);
  }

  /**
   * Write-behind persistence: upsert the current in-memory account to the
   * EksAccount table. Fire-and-forget — the in-memory store remains the
   * source of truth for the running process; the DB row is a snapshot for
   * restart recovery. Errors are swallowed (logged to console) so a DB
   * hiccup never breaks the in-memory flow.
   */
  private async _persist(id: AccountId): Promise<void> {
    const account = this.accounts.get(id);
    if (!account) return;
    try {
      await db.eksAccount.upsert({
        where: { id },
        create: {
          id: account.id,
          email: account.email,
          displayName: account.displayName,
          state: account.state,
          personas: account.personas.join(","),
          activePersona: account.activePersona,
          passwordHash: account.passwordHash ?? null,
          passwordSalt: account.passwordSalt ?? null,
          mfaEnabled: account.mfaEnabled,
          isDemo: account.email.endsWith("@eks.health"),
          isAdmin: account.email === "ekontetevi@gmail.com",
          locale: account.locale ?? null,
          timezone: account.timezone ?? null,
        },
        update: {
          displayName: account.displayName,
          state: account.state,
          personas: account.personas.join(","),
          activePersona: account.activePersona,
          passwordHash: account.passwordHash ?? null,
          passwordSalt: account.passwordSalt ?? null,
          mfaEnabled: account.mfaEnabled,
          locale: account.locale ?? null,
          timezone: account.timezone ?? null,
        },
      });
    } catch (err) {
      console.error("[accounts] DB write-behind failed for", account.id, err);
    }
  }

  /**
   * Hydrate the in-memory store from the EksAccount table. Called once on
   * platform boot before demo/admin seeding, so that accounts created in a
   * previous server lifetime survive restart. Rows that already exist
   * in-memory (e.g. just-seeded) are skipped.
   */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksAccount.findMany();
      let loaded = 0;
      for (const row of rows) {
        if (this.accounts.has(row.id)) continue;
        const account: Account = {
          id: asAccountId(row.id),
          email: row.email,
          displayName: row.displayName,
          state: row.state as AccountState,
          personas: row.personas ? (row.personas.split(",").filter(Boolean) as Persona[]) : ["participant"],
          activePersona: (row.activePersona || "participant") as Persona,
          contacts: [{ type: "email", value: row.email, verified: row.state === "active", primary: true }],
          passwordHash: row.passwordHash ?? undefined,
          passwordSalt: row.passwordSalt ?? undefined,
          mfaEnabled: row.mfaEnabled,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.createdAt.toISOString(),
          lastSignInAt: row.lastSignInAt ? row.lastSignInAt.toISOString() : undefined,
          failedSignInAttempts: 0,
          locale: row.locale ?? undefined,
          timezone: row.timezone ?? undefined,
        };
        this.accounts.set(account.id, account);
        this.byEmail.set(account.email, account.id);
        loaded++;
      }
      return loaded;
    } catch (err) {
      console.error("[accounts] DB hydration failed:", err);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: AccountManager | null = null;
export function getAccounts(): AccountManager {
  if (!_mgr) _mgr = new AccountManager();
  return _mgr;
}

export { ALL_PERSONAS };
