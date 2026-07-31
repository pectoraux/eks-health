/**
 * Eks-Health Identity — Sessions
 *
 * Session platform: short-lived access tokens, refresh-token rotation,
 * expiration, revocation, concurrent sessions, per-device logout, idle &
 * absolute timeouts, organization session policies, risk-based re-auth.
 *
 * Tokens are opaque random strings (not JWT) by default — the session
 * store is the source of truth, enabling instant revocation. A JWT adapter
 * can be plugged in for stateless deployments.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import {
  type AccountId,
  type SessionId,
  type Persona,
  IdentityError,
  IDENTITY_EVENTS,
  asSessionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { Device } from "../devices";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionState = "active" | "expired" | "revoked" | "reauth_required";

export interface Session {
  readonly id: SessionId;
  readonly accountId: AccountId;
  readonly persona: Persona;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly createdAt: string;
  readonly expiresAt: string; // access token expiry
  readonly refreshExpiresAt: string;
  readonly absoluteExpiresAt: string; // hard session cap
  readonly lastActiveAt: string;
  readonly state: SessionState;
  readonly device?: { id: string; label: string };
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly riskScore: number;
  readonly orgId?: string;
  readonly mfaVerified: boolean;
}

export interface SessionContext {
  readonly accountId: AccountId;
  readonly persona: Persona;
  readonly device?: Device;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly riskScore?: number;
  readonly orgId?: string;
  readonly mfaVerified?: boolean;
}

export interface SessionPolicy {
  readonly accessTtlSeconds: number; // access token lifetime
  readonly refreshTtlSeconds: number; // refresh token lifetime
  readonly absoluteTtlSeconds: number; // hard session cap
  readonly idleTimeoutSeconds: number; // re-auth after inactivity
  readonly maxConcurrentSessions: number;
  readonly requireMfaForSensitive: boolean;
  readonly reauthThresholdRisk: number; // risk score above which re-auth is forced
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  accessTtlSeconds: 15 * 60, // 15 minutes
  refreshTtlSeconds: 7 * 24 * 60 * 60, // 7 days
  absoluteTtlSeconds: 30 * 24 * 60 * 60, // 30 days
  idleTimeoutSeconds: 60 * 60, // 1 hour
  maxConcurrentSessions: 10,
  requireMfaForSensitive: true,
  reauthThresholdRisk: 60,
};

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly byAccount = new Map<AccountId, SessionId[]>();
  private readonly accessTokenIndex = new Map<string, SessionId>();
  private readonly refreshTokenIndex = new Map<string, SessionId>();
  private policies = new Map<string, SessionPolicy>(); // orgId -> policy

  constructor() {
    this.policies.set("__default", DEFAULT_SESSION_POLICY);
  }

  setOrgPolicy(orgId: string, policy: SessionPolicy): void {
    this.policies.set(orgId, policy);
  }

  getPolicy(orgId?: string): SessionPolicy {
    if (orgId) {
      const p = this.policies.get(orgId);
      if (p) return p;
    }
    return this.policies.get("__default")!;
  }

  create(ctx: SessionContext): Session {
    const policy = this.getPolicy(ctx.orgId);
    const now = Date.now();
    const session: Session = {
      id: asSessionId(generateId("ses_")),
      accountId: ctx.accountId,
      persona: ctx.persona,
      accessToken: randomToken(),
      refreshToken: randomToken(),
      createdAt: getClock().iso(),
      expiresAt: new Date(now + policy.accessTtlSeconds * 1000).toISOString(),
      refreshExpiresAt: new Date(now + policy.refreshTtlSeconds * 1000).toISOString(),
      absoluteExpiresAt: new Date(now + policy.absoluteTtlSeconds * 1000).toISOString(),
      lastActiveAt: getClock().iso(),
      state: "active",
      device: ctx.device ? { id: ctx.device.id, label: ctx.device.label } : undefined,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      riskScore: ctx.riskScore ?? 0,
      orgId: ctx.orgId,
      mfaVerified: ctx.mfaVerified ?? false,
    };
    this.sessions.set(session.id, session);
    this.accessTokenIndex.set(session.accessToken, session.id);
    this.refreshTokenIndex.set(session.refreshToken, session.id);
    void this._persist(session.id);
    const list = this.byAccount.get(ctx.accountId) ?? [];
    // Enforce max concurrent sessions: revoke oldest beyond limit
    const active = list.map((id) => this.sessions.get(id)!).filter((s) => s && s.state === "active");
    if (active.length >= policy.maxConcurrentSessions) {
      const oldest = active.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) this.revoke(oldest.id, "max_concurrent_exceeded");
    }
    this.byAccount.set(ctx.accountId, [...list.filter((id) => this.sessions.has(id)), session.id]);
    return session;
  }

  /** Validate an access token. Returns the session if valid; refreshes expiry. */
  validate(accessToken: string): Session {
    const id = this.accessTokenIndex.get(accessToken);
    if (!id) {
      throw new IdentityError({ code: "eks.identity.session.invalid", category: "session_expired", message: "Unknown access token.", userMessage: "Session invalid. Please sign in again." });
    }
    const session = this.sessions.get(id);
    if (!session) {
      throw new IdentityError({ code: "eks.identity.session.not_found", category: "session_expired", message: "Session gone.", userMessage: "Session expired." });
    }
    if (session.state === "revoked") {
      throw new IdentityError({ code: "eks.identity.session.revoked", category: "session_revoked", message: "Session revoked.", userMessage: "Your session was revoked." });
    }
    const now = Date.now();
    if (now > new Date(session.absoluteExpiresAt).getTime()) {
      this.markState(id, "expired");
      throw new IdentityError({ code: "eks.identity.session.absolute_expired", category: "session_expired", message: "Absolute timeout.", userMessage: "Session timed out. Please sign in again." });
    }
    const policy = this.getPolicy(session.orgId);
    const idleMs = now - new Date(session.lastActiveAt).getTime();
    if (idleMs > policy.idleTimeoutSeconds * 1000) {
      this.markState(id, "expired");
      throw new IdentityError({ code: "eks.identity.session.idle_timeout", category: "session_expired", message: "Idle timeout.", userMessage: "You were signed out for inactivity." });
    }
    if (now > new Date(session.expiresAt).getTime()) {
      // access token expired but refresh may still be valid
      this.markState(id, "expired");
      throw new IdentityError({ code: "eks.identity.session.expired", category: "session_expired", message: "Access token expired.", userMessage: "Session expired. Please refresh or sign in." });
    }
    // Bump last-active
    this.sessions.set(id, { ...session, lastActiveAt: getClock().iso() });
    void this._persist(id);
    // Risk-based re-auth
    if (session.riskScore >= policy.reauthThresholdRisk) {
      this.markState(id, "reauth_required");
      throw new IdentityError({ code: "eks.identity.session.reauth_required", category: "verification_required", message: "Risk-based re-auth required.", userMessage: "For your security, please verify it's you." });
    }
    return this.sessions.get(id)!;
  }

  /** Rotate refresh token; returns a new session (access + refresh). */
  refresh(refreshToken: string): Session {
    const id = this.refreshTokenIndex.get(refreshToken);
    if (!id) throw new IdentityError({ code: "eks.identity.session.invalid_refresh", category: "session_expired", message: "Unknown refresh token.", userMessage: "Session expired. Please sign in again." });
    const session = this.sessions.get(id);
    if (!session) throw new IdentityError({ code: "eks.identity.session.not_found", category: "session_expired", message: "Session gone." });
    if (session.state !== "active") throw new IdentityError({ code: "eks.identity.session.revoked", category: "session_revoked", message: `Session ${session.state}.`, userMessage: "Session no longer active." });
    if (Date.now() > new Date(session.refreshExpiresAt).getTime()) {
      this.markState(id, "expired");
      throw new IdentityError({ code: "eks.identity.session.refresh_expired", category: "session_expired", message: "Refresh token expired.", userMessage: "Please sign in again." });
    }
    // Rotation: invalidate old refresh token, issue new pair
    this.refreshTokenIndex.delete(refreshToken);
    const newAccess = randomToken();
    const newRefresh = randomToken();
    const policy = this.getPolicy(session.orgId);
    const now = Date.now();
    const updated: Session = {
      ...session,
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresAt: new Date(now + policy.accessTtlSeconds * 1000).toISOString(),
      refreshExpiresAt: new Date(now + policy.refreshTtlSeconds * 1000).toISOString(),
      lastActiveAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    this.accessTokenIndex.delete(session.accessToken);
    this.accessTokenIndex.set(newAccess, id);
    this.refreshTokenIndex.set(newRefresh, id);
    void this._persist(id);
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.sessionRefreshed, { sessionId: id, accountId: session.accountId }, {}, "domain"));
    return updated;
  }

  revoke(id: SessionId, reason = "user_request"): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.accessTokenIndex.delete(session.accessToken);
    this.refreshTokenIndex.delete(session.refreshToken);
    this.markState(id, "revoked");
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.signedOut, { sessionId: id, accountId: session.accountId, reason }, {}, "domain"));
  }

  /** Revoke all sessions for an account (e.g. on password change). */
  revokeAllForAccount(accountId: AccountId, except?: SessionId): number {
    const ids = this.byAccount.get(accountId) ?? [];
    let n = 0;
    for (const id of ids) {
      if (except && id === except) continue;
      const s = this.sessions.get(id);
      if (s && s.state === "active") {
        this.revoke(id, "revoke_all");
        n++;
      }
    }
    return n;
  }

  /** Revoke all sessions on a specific device. */
  revokeForDevice(deviceId: string): number {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.device?.id === deviceId && s.state === "active") {
        this.revoke(id, "device_logout");
        n++;
      }
    }
    return n;
  }

  listForAccount(accountId: AccountId): Session[] {
    return (this.byAccount.get(accountId) ?? [])
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => !!s);
  }

  get(id: SessionId): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Switch the active persona of an existing session. */
  switchPersona(id: SessionId, persona: Persona): Session {
    const session = this.sessions.get(id);
    if (!session) throw new IdentityError({ code: "eks.identity.session.not_found", category: "session_expired", message: "Session gone." });
    const updated = { ...session, persona };
    this.sessions.set(id, updated);
    void this._persist(id);
    return updated;
  }

  private markState(id: SessionId, state: SessionState): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, state });
    void this._persist(id);
  }

  /** Sweep expired sessions (called by the scheduler). */
  sweep(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.state === "active" && now > new Date(s.absoluteExpiresAt).getTime()) {
        this.markState(id, "expired");
        n++;
      }
    }
    return n;
  }

  getStats(): { total: number; active: number; revoked: number; expired: number } {
    let active = 0, revoked = 0, expired = 0;
    for (const s of this.sessions.values()) {
      if (s.state === "active") active++;
      else if (s.state === "revoked") revoked++;
      else if (s.state === "expired") expired++;
    }
    return { total: this.sessions.size, active, revoked, expired };
  }

  /**
   * Write-behind persistence: upsert the current in-memory session to the
   * EksSession table. Fire-and-forget; the in-memory store remains the
   * source of truth for the running process.
   */
  private async _persist(id: SessionId): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      await db.eksSession.upsert({
        where: { id },
        create: {
          id: s.id,
          accountId: s.accountId,
          persona: s.persona,
          accessToken: s.accessToken,
          refreshToken: s.refreshToken,
          createdAt: new Date(s.createdAt),
          expiresAt: new Date(s.expiresAt),
          refreshExpiresAt: new Date(s.refreshExpiresAt),
          absoluteExpiresAt: new Date(s.absoluteExpiresAt),
          lastActiveAt: new Date(s.lastActiveAt),
          state: s.state,
          ipAddress: s.ipAddress ?? null,
          userAgent: s.userAgent ?? null,
          riskScore: s.riskScore,
          mfaVerified: s.mfaVerified,
        },
        update: {
          persona: s.persona,
          accessToken: s.accessToken,
          refreshToken: s.refreshToken,
          expiresAt: new Date(s.expiresAt),
          lastActiveAt: new Date(s.lastActiveAt),
          state: s.state,
          riskScore: s.riskScore,
          mfaVerified: s.mfaVerified,
        },
      });
    } catch (err) {
      console.error("[sessions] DB write-behind failed for", s.id, err);
    }
  }

  /**
   * Hydrate the in-memory store from the EksSession table. Loads only
   * active sessions whose absolute expiry hasn't passed. Called once on
   * boot so users stay signed in across server restarts.
   */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksSession.findMany();
      const now = Date.now();
      let loaded = 0;
      for (const row of rows) {
        if (this.sessions.has(row.id)) continue;
        if (row.state !== "active") continue;
        if (now > row.absoluteExpiresAt.getTime()) continue;
        const session: Session = {
          id: asSessionId(row.id),
          accountId: row.accountId as AccountId,
          persona: row.persona as Persona,
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          refreshExpiresAt: row.refreshExpiresAt.toISOString(),
          absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
          lastActiveAt: row.lastActiveAt.toISOString(),
          state: row.state as SessionState,
          ipAddress: row.ipAddress ?? undefined,
          userAgent: row.userAgent ?? undefined,
          riskScore: row.riskScore,
          orgId: undefined,
          mfaVerified: row.mfaVerified,
        };
        this.sessions.set(session.id, session);
        this.accessTokenIndex.set(session.accessToken, session.id);
        this.refreshTokenIndex.set(session.refreshToken, session.id);
        const list = this.byAccount.get(session.accountId) ?? [];
        list.push(session.id);
        this.byAccount.set(session.accountId, list);
        loaded++;
      }
      return loaded;
    } catch (err) {
      console.error("[sessions] DB hydration failed:", err);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: SessionManager | null = null;
export function getSessions(): SessionManager {
  if (!_mgr) _mgr = new SessionManager();
  return _mgr;
}
