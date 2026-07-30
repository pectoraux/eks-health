/**
 * Server-side platform access helper.
 *
 * Boots the kernel + identity platform once (idempotent) and exposes typed
 * accessors for route handlers. Singletons persist for the Node process
 * lifetime, so state accumulates across requests — what a console needs.
 */

import "server-only";
import {
  bootKernel,
  kernelInfo,
  kernelSnapshot,
  getEventBus,
  getFlags,
  getConfiguration,
  getScheduler,
  getObservability,
  getRegistry,
  getTenants,
  getSecurity,
  getGateway,
  getTime,
  getI18n,
  getStorage,
  getSearch,
  getNotifications,
  type KernelError,
} from "@/kernel";
import {
  bootIdentity,
  identityInfo,
  identitySnapshot,
  seedIdentityDemoData,
  getAccounts,
  getAuth,
  getSessions,
  getDevices,
  getOrganizations,
  getRoles,
  getAuthorization,
  getConsent,
  getPrivacy,
  getDataGateway,
  getAudit,
  getSecurityPolicies,
  getMonitoring,
  getCompliance,
  type IdentityError,
} from "@/identity";

let _booted = false;
export function ensurePlatform() {
  if (!_booted) {
    bootKernel();
    bootIdentity();
    seedIdentityDemoData();
    _booted = true;
  }
  return { kernel: kernelInfo(), identity: identityInfo() };
}

export function platformSnapshot() {
  ensurePlatform();
  return { kernel: kernelSnapshot(), identity: identitySnapshot() };
}

export {
  getEventBus,
  getFlags,
  getConfiguration,
  getScheduler,
  getObservability,
  getRegistry,
  getTenants,
  getSecurity,
  getGateway,
  getTime,
  getI18n,
  getStorage,
  getSearch,
  getNotifications,
  getAccounts,
  getAuth,
  getSessions,
  getDevices,
  getOrganizations,
  getRoles,
  getAuthorization,
  getConsent,
  getPrivacy,
  getDataGateway,
  getAudit,
  getSecurityPolicies,
  getMonitoring,
  getCompliance,
};

/** Wrap a handler so the platform is booted and errors become JSON. */
export function withPlatform<T>(
  fn: () => T | Promise<T>,
): Promise<Response> {
  return Promise.resolve()
    .then(() => {
      ensurePlatform();
      return fn();
    })
    .then((data) =>
      Response.json({
        ok: true,
        data,
        meta: { kernel: kernelInfo().version, identity: identityInfo().version, at: new Date().toISOString() },
      }),
    )
    .catch((err: unknown) => {
      if (err && typeof err === "object" && "toJSON" in err) {
        const e = err as IdentityError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" || e.category === "account_not_found" ? 404 :
          e.category === "invalid_credentials" || e.category === "mfa_required" || e.category === "mfa_failed" ||
          e.category === "session_expired" || e.category === "session_revoked" || e.category === "verification_required" ? 401 :
          e.category === "permission_denied" || e.category === "consent_required" || e.category === "consent_denied" ||
          e.category === "device_untrusted" || e.category === "policy_violation" ||
          e.category === "account_disabled" || e.category === "account_locked" ? 403 :
          e.category === "rate_limited" ? 429 :
          e.category === "conflict" ? 409 : 500;
        return Response.json(body, { status });
      }
      const ke = err as KernelError;
      if (ke?.code) {
        const body = { ok: false, error: ke.toJSON() };
        const status =
          ke.category === "validation" ? 400 :
          ke.category === "not_found" ? 404 :
          ke.category === "unauthorized" ? 401 :
          ke.category === "forbidden" ? 403 :
          ke.category === "rate_limited" ? 429 :
          ke.category === "conflict" ? 409 :
          ke.category === "unavailable" ? 503 : 500;
        return Response.json(body, { status });
      }
      return Response.json(
        { ok: false, error: { code: "eks.error.internal", message: err instanceof Error ? err.message : String(err) } },
        { status: 500 },
      );
    });
}
