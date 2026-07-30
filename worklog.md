# Eks-Health Platform Kernel — Worklog

Project: Eks-Health Preventive Health Operating System
Milestone: 1 — Platform Kernel & Foundation

This file is the single shared worklog. Every agent appends a section below.

---
Task ID: 1
Agent: orchestrator
Task: Inspect project, initialize worklog, define kernel conventions

Work Log:
- Inspected Next.js 16 scaffold (App Router, TS, Tailwind 4, shadcn/ui New York, Prisma, z-ai-web-dev-sdk).
- Confirmed available UI components (full shadcn set), lucide-react, framer-motion, recharts, zustand, tanstack-query.
- Decided architecture: real kernel under `src/kernel/`, API under `src/app/api/kernel/`, console at `/`.
- Established kernel conventions (see below).

Kernel Conventions (all agents MUST follow):
- Language: TypeScript strict. ESM imports. Use `import type` for types.
- Every kernel subsystem lives in `src/kernel/<subsystem>/index.ts` and exports a barrel.
- Main barrel: `src/kernel/index.ts`.
- All public types use `interface` for object shapes, `type` for unions/aliases.
- Errors extend `KernelError` from `src/kernel/core/errors.ts`.
- Events extend `BaseEvent` from `src/kernel/core/event.ts`.
- Every subsystem exposes: types, a registry/manager class, and a singleton accessor `get<Name>()`.
- No external runtime deps beyond what's in package.json. No mock/placeholder code — real abstractions with in-memory/default adapters.
- All IDs are branded strings: `type TenantId = string & { __brand: 'TenantId' }`.
- All timestamps are ISO-8601 UTC strings or epoch ms numbers.
- Namespaces: `eks.kernel.*` for events, `eks.error.*` for codes, `eks.flag.*` for flags.

Stage Summary:
- Foundation ready. Next: build kernel core, then subsystems in parallel, then API + console.

---
Task ID: 3-a
Agent: general-purpose (kernel: tenant, time, i18n)
Task: Build tenant, time, i18n kernel subsystems

Work Log:
- Read prior worklog, core/index.ts, events/index.ts, flags/index.ts, config/index.ts to learn established patterns (branded ids, KernelError, Clock, BaseEvent, manager class + singleton get<Name>()).
- Built `src/kernel/tenant/index.ts`: extensible TenantType union (individual/company/government/insurance/research/university/ngo + string&{}), TenantTier, TenantIsolationLevel (shared/dedicated/airgapped), Tenant, TenantMembership, TenantQuota, TenantContext, TenantAuditEntry. TenantManager with provision/get/list/addMembership/revokeMembership/listMembers/setQuota/getQuota/checkQuota/recordUsage/suspend/reactivate/terminate/resolveTenantContext/getAudit. Emits eks.kernel.tenant.provisioned + .suspended on the event bus. DEFAULT_TIER_QUOTAS table per tier. Singleton getTenants()/setTenants() + tenantId()/userId() helpers + TENANT_EVENTS const.
- Built `src/kernel/time/index.ts`: re-exports Clock/getClock/setClock/resetClock from core. Branded Timestamp (epoch ms, always UTC) + Duration interface + duration() builder + DURATIONS const (SECOND/MINUTE/HOUR/DAY/WEEK). Timezone & Locale branded types. TimeService with now/nowIn/format/parse/toUTC/fromUTC/addDuration/diff/isDST/listTimezones/startOfDay/endOfDay. Curated list of 24 major IANA zones spanning Africa/Europe/Americas/Asia/Oceania + UTC, each with live UTC offset string computed via Intl.DateTimeFormat. DST detection compares current offset against Jan/Jul offsets of the same year. Singleton getTime()/setTime().
- Built `src/kernel/i18n/index.ts`: TextDirection, MeasurementSystem, branded Currency & Locale, PluralRule, Language, TranslationPack types. Pre-registered 6 launch languages (en, fr, es, ar-RTL, zh, sw) with native labels, default currencies (USD/EUR/EUR/EGP/CNY/KES) and locales (en-US/fr-FR/es-ES/ar-EG/zh-CN/sw-KE). Built-in translation pack with 9 keys (platform.name, platform.tagline, common.save/cancel/loading/error/search/settings, common.items_count) translated into all 6 languages. I18nService with registerLanguage/registerPack/setDefault/t/formatCurrency/formatNumber/formatDate/formatList/listLanguages/getDirection/isRTL/getMeasurementSystem. Custom ICU-style message formatter (formatMessage + walk/readBraced/applyBlock/parseBranches) supporting {name} interpolation and {count, plural, one{...} other{...}} pluralization via Intl.PluralRules. Singleton getI18n()/setI18n().
- Resolved one cross-module mismatch: core's LifecycleState has no "suspended" member, so tenant.suspend() maps to "maintenance" status (semantically equivalent: no traffic allowed) while preserving suspendReason/suspendedAt and the audit "suspended" action label.
- Type-checked all three files with `tsc --noEmit --strict` — clean (the only emitted diagnostics were pre-existing ones in events/index.ts generic dispatch, not in the new files).
- Ran a runtime smoke test (bun) verifying: tenant provisioning + audit + event emission, quota enforcement, suspend lifecycle; time now/parse/startOfDay/isDST (NY true in July, Accra false)/addDuration/diff/listTimezones(24); i18n 6 languages, pluralization across en/fr/ar, currency USD/EUR formatting, number de-DE formatting, list formatting, date formatting, RTL detection.

Stage Summary:
- Files created:
  - src/kernel/tenant/index.ts — multi-tenancy (types, TenantManager, getTenants())
  - src/kernel/time/index.ts — time platform (re-exports Clock, TimeService, getTime())
  - src/kernel/i18n/index.ts — localization (6 languages, ICU formatter, I18nService, getI18n())
- Key decisions:
  - "suspended" tenant state maps to LifecycleState "maintenance" (no enum churn in core).
  - Timestamp is a branded epoch-ms number; timezones only matter at the formatting/boundary layer — internals are always UTC.
  - DST detection uses offset comparison (Jan vs Jul) rather than tzdata, so it works with any V8/Node runtime that supports Intl.
  - ICU message formatter is a small recursive parser (no external lib) supporting nested braces and `#` count placeholders.
  - All three modules use the singleton + setter pattern (get<T>()/set<T>()) consistent with flags/config/events, enabling test-time substitution.
- No external dependencies added; no changes to package.json. Did NOT create src/kernel/index.ts (orchestrator owns the main barrel).
- Next: orchestrator should wire the new subsystems into src/kernel/index.ts and ensure the API + console layers consume them.

---
Task ID: 3-b
Agent: general-purpose (kernel: storage, search, notification)
Task: Build storage, search, notification kernel subsystems

Work Log:
- Read worklog.md, src/kernel/core/index.ts, src/kernel/events/index.ts, src/kernel/config/index.ts, src/kernel/flags/index.ts to internalize conventions (branded ids, KernelError hierarchy, getClock() timestamps, singleton + setter, real in-memory adapters, ESM imports with `import type`).
- Created src/kernel/storage/index.ts:
  * Branded BlobRef + MimeType alias + asBlobRef helper.
  * StorageProvider interface (put/get/delete/stat/list/signedUrl), StorageBucket, StorageObject, ObjectStat, UploadRequest, UploadResult, ListResult, StorageClass, StorageAcl.
  * BUCKETS catalog (9 categories: documents, medicalEvidence, images, videos, programAssets, avatars, extensionPackages, logs, exports).
  * BUCKET_POLICIES map enforcing per-category maxBytes + allowedMimeTypes + default storage class + default ACL.
  * InMemoryStorageProvider: real Map-backed store with TextEncoder byte conversion, FNV-1a etag, signed URL issuance.
  * StorageManager: registerProvider/setDefault/getDefault/registerBucket/listBuckets + put/get/delete/stat/list/signedUrl that resolve policies, enforce size+MIME rules, and inject bucket defaults. Auto-registers in-memory provider + 9 well-known buckets on construction.
  * getStorage()/setStorage()/resetStorage() singleton accessors.
- Created src/kernel/search/index.ts:
  * SearchProvider interface (index/search/delete/reindex), SearchIndex, SearchDocument, SearchFieldValue, SearchQuery, SearchFilter (eq/ne/in/gt/gte/lt/lte/exists/prefix), SearchSort, SearchHit, SearchResult, SearchHighlight, SearchAggregation (terms/range/stats).
  * INDICES catalog (7 default indices: users, programs, measurements, research, documentation, marketplace, extensions) + INDEX_DEFINITIONS declaring searchable/filterable/sortable fields per index.
  * InMemorySearchProvider: real tokenized inverted index (lowercase + whitespace/punctuation split, unicode-aware), BM25-ish scoring (K1=1.5, B=0.75), phrase matching via consecutive token check, field-filter validation, term/range/stats aggregations, <mark>-wrapped highlight snippets, OR semantics (doc must match at least one query token), reindex rebuilds from doc snapshot.
  * SearchManager: registerProvider/setDefault/registerIndex/listIndices + index/search/delete/reindex that validate against declared index fields. Auto-registers in-memory provider + 7 well-known indices.
  * getSearch()/setSearch()/resetSearch() singleton accessors.
- Created src/kernel/notification/index.ts:
  * NotificationChannel (email|sms|push|in_app|webhook), NotificationStatus (queued|sent|delivered|failed|bounced|filtered), NotificationProvider interface (send), NotificationTemplate, NotificationMessage, NotificationPreference, NotificationRecipient, NotificationDeliveryResult, NotificationLog.
  * InMemoryNotificationProvider: per-channel adapter capturing sent messages.
  * TEMPLATES + BUILTIN_TEMPLATES registry (4 built-ins: welcome_email, otp_sms, program_invite_push, system_alert_inapp) with channel-specific subject/body templates.
  * renderTemplateString: real `{param}` interpolation + non-greedy `{{#if param}}...{{/if}}` conditional blocks (truthy rule: non-empty string / non-zero number / true).
  * NotificationManager: registerProvider/setDefaultProvider/getDefaultProvider per channel, registerTemplate/renderTemplate/listTemplates, getUserPreferences/setUserPreferences with channel + category-override preference enforcement (disabled channel => status `filtered`, logged), send/sendBulk with template resolution + preference gating + setTimeout-based scheduling for future `scheduledFor`, getLog with full delivery lifecycle, cancelPending() for test cleanup. Auto-registers in-memory provider for all 5 channels + 4 built-in templates on construction.
  * getNotifications()/setNotifications()/resetNotifications() singleton accessors. Re-exports asUserId from core for convenience.
- Verified with `bunx tsc --noEmit`: zero errors in the three new files (remaining 7 errors are all pre-existing in examples/, skills/, and events/index.ts).
- Smoke-tested all three subsystems with bun: storage put/get/stat/list/signedUrl + policy violations (oversized avatar, wrong MIME) throw ValidationError; search BM25 scoring returns only matching docs, phrase search narrows further, filter+sort+aggregation+highlights all work, reindex rebuilds; notification preference filtering marks email as `filtered`, re-enable lets it through, template rendering handles `{param}` and `{{#if}}` correctly (debug=false drops block, debug=true keeps it), bulk send works, log captures 6 entries.

Stage Summary:
- Files created (3):
  * src/kernel/storage/index.ts  (~480 lines) — file/object storage abstraction with 9-bucket catalog + policy enforcement + in-memory provider.
  * src/kernel/search/index.ts   (~700 lines) — search abstraction with 7-index catalog + BM25 inverted-index provider + filters/sort/aggregations/highlights/phrase.
  * src/kernel/notification/index.ts (~630 lines) — notification abstraction with 5 channels + 4 built-in templates + preference enforcement + scheduling + bulk send + log.
- Key decisions:
  * All three follow the established core/events/config/flags pattern exactly: types + manager class + singleton accessor (with set/reset for tests), real in-memory default adapters (no mocks), ESM imports with `import type` for types, KernelError subclasses for validation/not-found failures.
  * Branded ids used: BlobRef in storage; UserId reused from core in notifications.
  * All timestamps via getClock().iso()/epochMs() (test-replayable).
  * Catalogs (BUCKETS, INDICES, TEMPLATES) are `as const` objects so derived union types are exact.
  * Did NOT create src/kernel/index.ts (orchestrator owns that, per worklog instructions).
  * Auto-registration on construction: each manager boots with its in-memory default provider and the full well-known catalog already wired, so the kernel is usable immediately on first get<Name>() call.
- Next actions: orchestrator should wire these into src/kernel/index.ts barrel and expose API routes / console panels. Storage provider extension points (S3/GCS adapters), search provider extension points (Elasticsearch/Meili adapters), and notification provider extension points (SES/Twilio/FCM/Slack adapters) can be added later without touching application code.

---
Task ID: 3-d
Agent: general-purpose (kernel: security, ai, gateway)
Task: Build security, ai, gateway kernel subsystems

Work Log:
- Read worklog.md, core/index.ts, events/index.ts, config/index.ts, flags/index.ts to absorb established kernel conventions (branded ids, KernelError, BaseEvent, manager + singleton accessor pattern, ESM, `import type` for types, no external deps).
- Created `src/kernel/security/index.ts` — security foundations:
  - 5-zone trust model (public | dmz | internal | restricted | secure) with SECURITY_BOUNDARIES constant + a real deterministic `defaultTrustZonePolicy` matrix (inward-only along the canonical chain, lateral allowed, secure->public denied).
  - `InMemoryEncryptionProvider` — REAL working AES-256-GCM using node:crypto (random 12-byte IV, 16-byte auth tag, AAD support, key-ring rotation preserving decryptability of old ciphertexts).
  - `SecretManager` — immutable append-only versions, name-bound AAD by default (defeats ciphertext-swap), get/getVersion/rotate/list/delete/grantAccess/revokeAccess; emits `eks.kernel.security.secret_rotated` on rotation.
  - `KeyManager` — descriptor-only metadata (raw material lives in EncryptionProvider); createKey/getKey/rotateKey/revokeKey/list; emits `eks.kernel.security.key_rotated`.
  - `ServiceIdentityRegistry` — register/get/list/byZone with SPIFFE-style identity + permissions.
  - CertificateDescriptor, NetworkSegment, cidrContains() helper, getSecurity() facade exposing .secrets/.keys/.identities/.encryption/.zones.
- Created `src/kernel/ai/index.ts` — AI readiness (architecture only):
  - `AIProvider` interface (complete/embed/stream), `AIModelDescriptor`, `PromptTemplate`, `ToolDescriptor`, `AgentDescriptor`, `AgentRun`, `Embedding`, `VectorStore`, `ModelRouter`, `AIInvocationLog`.
  - `InMemoryVectorStore` with REAL cosine-similarity top-k search.
  - `cosineSimilarity()` exported as a standalone real function.
  - `PromptRegistry` with REAL `{var}` interpolation; 3 templates pre-registered (summarize, classify_intent, extract_entities).
  - `ToolRegistry` with descriptor lookup + invoke contract (returns structured `no_handler` result rather than faking output); 3 tools pre-registered (search_web, read_file, call_api).
  - `AIProviderRegistry` — empty by default; comment notes z-ai-web-dev-sdk would be plugged in here.
  - `ModelRouter` — REAL filtering by modality/context-window/capability + sort by cost preference (cheapest/balanced/highest_quality).
  - `AgentRuntime.startRun` returns fully-formed AgentRun with status `pending_provider` (no fake AI output).
  - `AIObservability` records every prompt execution & tool invocation with tokens, latency, cost estimate.
  - getAI() facade with createAIFacade() factory.
- Created `src/kernel/gateway/index.ts` — API gateway contracts:
  - `GatewayRoute`, `GatewayProtocol` (rest|graphql|websocket|sse|grpc), `RouteVersion` (v1|v2|v3), `RateLimitPolicy`, `CompressionPolicy`, `CachePolicy`, `AuthHook`, `GatewayMiddleware`, `GatewayRequest`, `GatewayResponse`, `UpstreamService`.
  - `Gateway` class — registerRoute/registerMiddleware/registerUpstream/match(method, path) with REAL path-pattern compilation ({param} placeholders compiled to regex), listRoutes/listUpstreams.
  - `RateLimiter` — REAL token-bucket per key with continuous refill; check(key, cost) returns {allowed, remaining, resetAt, retryAfterMs}.
  - `Cache` — REAL TTL cache with lazy + interval sweep, get/set/invalidate/clear/size/dispose.
  - `VersionNegotiator` — REAL Accept-header parsing (vendor pattern, version= param, default-to-latest).
  - `CompressionNegotiator` — REAL q-value-aware Accept-Encoding parsing returning gzip|br|identity.
  - 8 standard middleware descriptors (request_id, cors, tracing, logging, auth, rate_limit, compression, caching) with explicit order priorities.
  - getGateway() pre-registers `/api/kernel/*` upstream as the first upstream service.
- Wrote and ran a 52-assertion smoke test against the real working logic (AES-GCM round-trip with AAD, rotation preserving old-version decryptability, cosine similarity, token-bucket refill after 250ms, TTL cache expiry, version/compression negotiation, route matching, trust-zone matrix). All 52 assertions pass under Bun.
- Cleaned up smoke-test scratch file.
- Confirmed `npx tsc --noEmit --strict` reports zero errors in any of the three new files (the only remaining errors are pre-existing in `events/index.ts` and affect every kernel subsystem equally, including the existing `flags/index.ts`).

Stage Summary:
- Files created:
  - `src/kernel/security/index.ts` (~750 lines) — trust zones, AES-256-GCM provider, secret manager, key manager, service identity registry, trust-zone policy matrix, CIDR helper, getSecurity() facade.
  - `src/kernel/ai/index.ts` (~855 lines) — provider contract, vector store with real cosine similarity, prompt registry with real interpolation, tool registry, model router with real filtering/sorting, agent runtime (pending_provider scaffolding, no fake output), observability ledger, getAI() facade with 3 pre-registered prompt templates + 3 pre-registered tool descriptors.
  - `src/kernel/gateway/index.ts` (~640 lines) — route table with regex path matching, real token-bucket rate limiter, real TTL cache, real Accept-header version negotiation, real q-value compression negotiation, 8 standard middleware descriptors, getGateway() facade with `/api/kernel/*` upstream pre-registered.
- Key decisions:
  - AES-GCM secret name is bound as associated-data by default to defeat ciphertext-swap attacks (overrideable via opts.associatedData).
  - Key material never leaves the EncryptionProvider; KeyManager stores descriptors only.
  - AI module emits no fake LLM output — `AgentRuntime.startRun` returns status `pending_provider` and downstream code (or a future z-ai-web-dev-sdk adapter) transitions the run to running/completed.
  - ToolRegistry returns a structured `no_handler` result when no handler is attached, rather than throwing or faking output.
  - Gateway middleware order is deterministic: request_id(1) -> cors(2) -> tracing(3) -> logging(4) -> auth(5) -> rate_limit(6) -> compression(7) -> caching(8); before-phase ascending, after-phase descending.
  - No `src/kernel/index.ts` barrel created (per task constraint); subsystems are imported directly from `src/kernel/<subsystem>/index.ts`.
- Next: API routes under `src/app/api/kernel/*` can now consume these subsystems; a future task will register the z-ai-web-dev-sdk adapter as a real AIProvider and wire AuthHooks into the gateway.

---
Task ID: 3-c
Agent: general-purpose (kernel: scheduler, observability)
Task: Build scheduler, observability kernel subsystems

Work Log:
- Read worklog.md and existing kernel modules to learn conventions.
- Created src/kernel/scheduler/index.ts: distributed scheduler with branded JobId, real 5-field UNIX cron parser, Scheduler class with registerHandler/schedule/scheduleOne/scheduleCron/scheduleFixedRate/cancel/retry/getJob/listJobs/acquireLock/releaseLock/getStats. Real setInterval tick dispatcher, priority queue, exponential backoff retry, dead-letter queue, in-memory distributed locking with TTL. Emits eks.kernel.scheduler.fired. 4 pre-registered built-in handlers. Singleton getScheduler().
- Created src/kernel/observability/index.ts: MetricsRegistry (counter/gauge/histogram/summary with p50/p95/p99), Logger (5 levels, 1000-record ring buffer), Tracer+SpanHandle (explicit traceId/spanId propagation, no AsyncLocalStorage), HealthRegistry, AlertManager (cooldown+dedup), Observability facade with snapshot(). Metrics->alerts auto-wired. 4 pre-registered health checks. Singleton getObservability().
- Temp smoke-test scaffolds removed by orchestrator.

Stage Summary:
- Files created: src/kernel/scheduler/index.ts, src/kernel/observability/index.ts.
- Key decisions: unified tick dispatcher for real priority queue; strict distributed-lock semantics; AsyncLocalStorage-free tracer; metrics->alerts auto-wired; health checks use top-level imports (no cycles).

---
Task ID: M2-0
Agent: orchestrator
Task: Begin Milestone 2 — Identity, Security & Privacy Platform

Work Log:
- Verified M1 kernel intact (0 TypeScript errors in src/kernel, 16 subsystems present).
- Confirmed M1 console + API routes were NOT built (previous tool outage).
- Plan for M2: build src/identity/* platform on top of kernel; build /api/kernel/* + /api/identity/* routes; build unified console at /.
- Architecture: src/identity/{core,accounts,auth,sessions,devices,organizations,roles,authorization,consent,privacy,data-gateway,audit,policies,monitoring,compliance}.

Stage Summary:
- M2 begun. Identity platform extends kernel security primitives (encryption, secrets, service identity, trust zones).

---
Task ID: m2-2
Agent: general-purpose (identity: organizations, roles)
Task: Build organizations + roles subsystems

Work Log:
- Read worklog.md, src/identity/core/index.ts, src/identity/accounts/index.ts, src/identity/sessions/index.ts, and src/kernel/index.ts to absorb the established identity-platform pattern (branded ids, IdentityError, manager class + singleton get<Name>(), ESM with `import "server-only"`, `import type` for types, getEventBus().publish(buildEvent(...)) for events, getClock().iso() for timestamps, generateId() for ids).
- Built `src/identity/organizations/index.ts` (~1100 lines):
  * Types: OrganizationType (8 variants: hospital|clinic|company|government|university|ngo|insurance|research_institution), DataClassification (public|internal|confidential|restricted|secret), OrgRole (owner|admin|member|billing|auditor|delegate), OrgStatus, DelegatedScopeKind, Organization, OrgMembership, OrgInvitation, Team, Department, OrgNode (hierarchy tree), DelegatedScope, OrgAuditEntry, CreateOrganizationInput, CreateTeamInput, CreateDepartmentInput, ListOrgsFilter.
  * ORG_TYPES constant: array of 8 OrgTypeDescriptor entries, each with type + label + description + defaultDataClassification (hospital/clinic/government/insurance=restricted, company/university/research_institution=confidential, ngo=internal).
  * ORG_EVENTS const: eks.identity.org.created / .member_added / .member_removed / .invite_issued / .invite_accepted / .team_created / .delegated.
  * OrganizationManager class:
    - create(input) with auto-slug, slug-uniqueness, parent validation, default dataClassification from ORG_TYPES.
    - get / getBySlug / list(filter?) with type/status/parentId/rootOnly/dataClassification filters.
    - addMember with single-owner enforcement and duplicate detection; removeMember with cascade removal from org teams; listMembers; listMembershipsForAccount.
    - invite(orgId, email, role, invitedBy) — REAL 32-byte base64url random token; SHA-256 hash stored (never the raw token); 7-day TTL; single-use; consumedAt/consumedBy tracked. acceptInvite(token, accountId) consumes + adds member; rejects expired/revoked/consumed. listInvites / revokeInvite.
    - createTeam / getTeam / listTeams / addTeamMember (enforces org membership) / removeTeamMember.
    - createDepartment / listDepartments (with parent-department support).
    - setParent(orgId, parentId) with REAL cycle detection: walks parent chain from candidate parent, rejects if orgId appears (direct or transitive); also enforces a MAX_HIERARCHY_DEPTH=16 cap. getHierarchy(orgId) returns recursive OrgNode tree with depth + visited-set defensive guard against pre-existing cycles.
    - delegate(orgId, delegateAccountId, scope, createdBy) — requires delegate to be admin/owner; promotes to "delegate" role; stores DelegatedScope with permissions + validUntil; revokeDelegation.
    - suspend(reason) / reactivate / terminate (terminal; cascades to invites + delegations).
    - getAudit(orgId) — every mutating operation appends an OrgAuditEntry (created/member_added/member_removed/invite_issued/invite_accepted/invite_revoked/team_created/department_created/set_parent/suspended/reactivated/terminated/delegated/delegation_revoked).
  - Real invite-token hashing via node:crypto createHash('sha256'); token never persisted in plaintext.
  - Real hierarchy: Map-backed childrenIndex maintained on setParent; getHierarchy walks recursively with cycle-safe visited set.
  - getOrganizations() / resetOrganizations() singleton.
- Built `src/identity/roles/index.ts` (~620 lines):
  * Types: Permission (string), PermissionCategory (identity|measurement|program|marketplace|org|platform|research|support|file|consent), RoleScope (account|org|team|program|global), PermissionDescriptor, RoleDefinition, RoleAssignment (with id/accountId/roleId/scope/scopeId/assignedAt/assignedBy/active/revokedAt/revokeReason/expiresAt), RoleAssignmentFilter, PermissionTarget, SimulationResult, RoleCatalogEntry.
  * PERMISSIONS const: 35 PermissionDescriptor entries across all 10 categories (e.g. identity:account:read|write|delete, identity:role:assign|revoke, identity:session:revoke, measurement:self:read|collect|participant:read|anonymized:read, program:install|uninstall|configure, marketplace:publish|review|approve|reject, org:manage|members:manage|teams:manage|billing:manage|audit:read|policy:manage, platform:*|config:manage|tenant:manage, research:request|dataset:read|cohort:manage, support:ticket:read|respond, file:read|write|delete, consent:manage|revoke) — each with category, label, description, sensitive flag.
  * ROLES const: 10 RoleCatalogEntry entries (platform_admin, org_admin, developer, researcher, health_technician, support_agent, marketplace_reviewer, billing_admin, auditor, participant) — each with id, label, description, scope, permissions[], sensitive, systemRole=true.
  * ROLE_EVENTS const: eks.identity.role.defined / .assigned / .revoked (also re-publishes legacy IDENTITY_EVENTS.roleAssigned / .roleRevoked for backward compat with accounts subsystem consumers).
  * Exported helpers: permissionMatches(granted, requested) — REAL wildcard expansion: "*" matches all; "namespace:*" matches every permission under "namespace:"; exact match otherwise. permissionsInclude(granted[], requested).
  * RoleManager class:
    - Auto-registers all 10 system roles from ROLES catalog in constructor.
    - defineRole(input) — validates name uniqueness, validates every permission exists in PERMISSIONS catalog OR is a wildcard; rejects unknown permissions. getRole / getRoleByName / listRoles.
    - assignRole(accountId, roleId, {scope, scopeId, assignedBy, expiresAt}) — validates scope/scopeId pairing (global has no scopeId; org/team/program require scopeId); returns existing duplicate assignment if present. revokeRole(assignmentId, revokedBy, reason). listRolesFor(accountId) / listAssignments(filter?).
    - registerTeamOrg(teamId, orgId) — wired by the Organizations subsystem to enable org->team permission inheritance; resolveTeamOrg(teamId).
    - REAL scope-aware permission evaluation: scopeMatches(assignment, target) — global matches everything; org matches same-org OR team-in-same-org (via teamOrg map); team matches same team; program matches same program; account matches account only. Expiry + active flag respected via isAssignmentLive.
    - getPermissions(accountId, target?) — union of all matching roles' permissions. hasPermission(accountId, permission, target?) — REAL evaluation using permissionsInclude over active roles.
    - simulate(accountId, roleId, target?) — returns SimulationResult with currentPermissions, simulatedPermissions, added, unchanged for permission-simulation UIs.
  - getRoles() / resetRoles() singleton.
- Verified with `npx tsc --noEmit --strict`: ZERO errors in src/identity/organizations/index.ts and src/identity/roles/index.ts (remaining errors are in other agents' files: src/identity/audit/index.ts, src/identity/authorization/index.ts, plus pre-existing examples/skills).
- Ran a 70-assertion end-to-end bun smoke test (scratch file, removed after): all 70 pass. Verified:
  * ORG_TYPES catalog (8 entries, classification defaults).
  * Org create + auto-slug + dataClassification defaults; hierarchy parent/child; circular-parent rejection (direct + transitive); getHierarchy tree shape + depths.
  * Membership: addMember, single-owner enforcement, listMembers, removeMember cascade.
  * Invitations: real token (>=30 chars), only hash stored, acceptInvite consumes + adds member, single-use enforcement, revokeInvite blocks acceptance.
  * Teams: createTeam, addTeamMember requires org membership, listTeams.
  * Departments: createDepartment.
  * Delegation: delegate() requires admin/owner, listDelegations.
  * Suspend/reactivate lifecycle; audit trail captures all actions.
  * ROLES catalog (10), PERMISSIONS catalog (35), auto-registration, getRoleByName.
  * permissionMatches wildcards: "*" matches all; "platform:*" matches "platform:account:read" but NOT "org:manage"; exact match works; different action rejected.
  * assignRole + hasPermission for platform_admin (global scope, wildcard expansion), org_admin (org scope with team inheritance via registerTeamOrg), participant (account scope, denied cross-scope).
  * getPermissions returns union; revokeRole removes permissions; simulate() computes added/unchanged delta correctly.
  * defineRole accepts custom roles; rejects unknown permissions in custom role definition.
- Cleaned up smoke-test scratch file + temporary node_modules/server-only stub.

Stage Summary:
- Files created (2):
  - src/identity/organizations/index.ts (~1100 lines) — full organizations subsystem: 8-type catalog with default dataClassification, hierarchy with cycle detection, single-use hashed invite tokens, teams, departments, delegated administration, suspend/reactivate/terminate lifecycle, per-org audit trail, 7 org events. Singleton getOrganizations().
  - src/identity/roles/index.ts (~620 lines) — RBAC catalog + assignment + real evaluation: 35-permission catalog across 10 categories, 10 predefined system roles, custom role definition with permission validation, scope-aware assignments (account/org/team/program/global), real wildcard permission matching ("*" and "namespace:*"), real org->team scope inheritance via registerTeamOrg, hasPermission/getPermissions/simulate, 3 role events (+ 2 legacy re-publishes). Singleton getRoles().
- Key decisions:
  - Invite tokens are 32-byte base64url random values; only SHA-256 hash is stored (matches the verification-token pattern from accounts/index.ts). Single-use + 7-day TTL.
  - Hierarchy cycle detection walks the parent chain from the candidate parent and rejects if the target orgId is found anywhere along the path; also enforces a 16-level depth cap. getHierarchy uses a visited-set to defensively stop descent if a cycle ever exists in stored data.
  - OrgRole "delegate" is assigned via delegate() — only admins/owners can receive delegation (delegate must already be an org admin/owner, then gets promoted to "delegate" role).
  - Permission wildcards: "*" = superuser; "namespace:*" = namespace-wide (matched via startsWith on the namespace prefix including the trailing colon). Exact string match otherwise.
  - Org->team inheritance is decoupled: RoleManager exposes registerTeamOrg(teamId, orgId) which the Organizations subsystem calls when creating teams; this avoids a hard import cycle between the two modules while still enabling real inheritance evaluation.
  - RoleManager publishes BOTH new ROLE_EVENTS (.defined/.assigned/.revoked) AND the legacy IDENTITY_EVENTS.roleAssigned/.roleRevoked so existing accounts-subsystem event consumers continue to fire.
  - simulate() returns currentPermissions + simulatedPermissions + added + unchanged (no "removed" since adding a role never removes permissions) — sufficient for a permission-simulation UI.
- Both files: `import "server-only"` at top, `import type` for all type-only imports, ESM, no external runtime deps beyond node:crypto (only organizations uses node:crypto for token hashing; roles uses none). Real working logic throughout — no mocks, no placeholders.
- Did NOT create src/identity/index.ts (orchestrator owns the main barrel).
- Next: orchestrator should wire src/identity/organizations/index.ts and src/identity/roles/index.ts into the src/identity/index.ts barrel and ensure API routes / console consume them. The Organizations subsystem should call getRoles().registerTeamOrg(teamId, orgId) in createTeam() to wire up team->org inheritance for permission evaluation.

---
Task ID: m2-3
Agent: general-purpose (identity: authorization, consent, privacy)
Task: Build authorization + consent + privacy engines

Work Log:
- Read worklog.md (M1 kernel + M2 core/accounts/auth/sessions/devices), src/identity/core/index.ts (branded ids: AccountId/ConsentId/ConsentReceiptId/GrantId/PolicyId/OrgId, IdentityError, IDENTITY_EVENTS, RiskAssessment, Persona), accounts/index.ts and sessions/index.ts for the established pattern (manager class + singleton, real logic, `import "server-only"`, emit events, `getClock().iso()`, `generateId()`, ESM with `import type`), and the kernel barrel for Brand/ResourceId/getEventBus/buildEvent.
- Built `src/identity/authorization/index.ts` — unified policy engine (RBAC + ABAC + PBAC + grants + delegations + simulation + audit):
  * Types: Permission, AuthorizationDecision (allow|deny|challenge), DeviceTrust, EvaluationContext (accountId, persona, orgId?, teamId?, programId?, purpose?, fields?, resource?, attributes?, ipAddress?, deviceTrust?, time), PolicyCondition (operator union: eq|ne|in|not_in|gt|lt|gte|lte|regex|purpose_in|has_consent|attr_eq), Policy (PolicyId, name, description, effect: allow|deny, conditions, priority, scope?), PermissionGrant (GrantId, accountId, permission, scope?, grantedBy, grantedAt, expiresAt?, purpose?, conditions?), Delegation (DelegationId brand + asDelegationId helper, delegatorAccountId, delegateAccountId, permissions[], scope?, createdAt, expiresAt?, reason?), AuthorizationResult (decision, reasons, matchedPolicies, grantsUsed, delegationsUsed, evaluatedAt), EvaluationLogEntry.
  * AuthorizationEngine class: registerPolicy/getPolicy/listPolicies (priority-sorted); grant/revokeGrant/listGrants; delegate/revokeDelegation/listDelegations(accountId, asDelegator?); evaluate(ctx, permission, opts?) returning AuthorizationResult; simulate(accountId, hypotheticalGrants, permission, ctx) — non-persistent what-if evaluation; audit(ctx, permission, result) — emits eks.identity.permission.evaluated + .granted/.denied + writes to internal ring-buffered audit log (cap 10k entries, never blocks on sink failure); listAuditEntries(filter?).
  * evaluate() flow: (1) compute derived ABAC attrs (hourOfDay, dayOfWeek, isWeekend, isOutsideBusinessHours from ctx.time; crossTenant from attributes.targetOrgId vs ctx.orgId; isSelfResource from attributes.resourceOwnerId vs ctx.accountId); (2) SENSITIVE_PERMISSIONS step-up short-circuit — challenge BEFORE policy eval so the absence of MFA doesn't leak whether the account would otherwise have access; (3) policy walk priority-desc, deny policies override; (4) RBAC via getRoles().hasPermission (fail-closed if roles subsystem unavailable); (5) PBAC grant lookup with scope/purpose/conditions/expiry checks; (6) delegation lookup with delegator-authority verification (delegated authority cannot exceed delegator's own); (7) default-deny.
  * Hierarchical scoping: scopeImplies() implements "org:X implies any team within X" semantics; team-scoped grants don't grant org-level access.
  * Conditional grants: conditions evaluated as ABAC via the same conditionMatches() engine.
  * Temporary grants: expiresAt checked at evaluation time (auto-expired, not auto-swept).
  * has_consent operator delegates to getConsent().checkAccess() (forward runtime import from ../consent — no cycle since consent doesn't import authorization).
  * POLICIES const: 6 built-ins — deny_deleted_accounts (pri 100), deny_cross_tenant (95), require_mfa_for_sensitive (90, deny with mfaVerified=false condition — the hard-deny backstop; the actual challenge enforcement is via the step-up short-circuit), deny_outside_business_hours_for_auditor (80), require_verified_email_for_publish (70), allow_self_read_always (50).
  * SENSITIVE_PERMISSIONS set: 8 perms (data:sensitive:read, data:sensitive:write, account:delete, org:members:manage, platform:config:write, marketplace:approve, consent:override, research:deidentified:export).
  * AUTH_EVENTS const: eks.identity.permission.granted / .denied / .evaluated / .grant.created / .grant.revoked / .delegation.created / .delegation.revoked.
  * Singleton getAuthorization()/setAuthorization()/resetAuthorization(). Constructor accepts an optional auditSink callback for SIEM forwarding.
- Built `src/identity/consent/index.ts` — first-class consent platform:
  * Types: ConsentStatus (pending|active|expired|withdrawn|revoked|superseded), ConsentScopeKind (purpose|field|program|org), ConsentScope, ConsentPurposeRequest (purpose, requestedFields[], optionalFields?, deniedFields?, description?), Consent (id, accountId, programId, purpose, requestedFields, optionalFields, deniedFields, approvedFields, userDeniedFields, status, version, createdAt, grantedAt?, expiresAt?, revokedAt?, revokeReason?, receiptId?, description?), ConsentChangeType, ConsentVersion (version, consentId, changeType, timestamp, actor, reason?, snapshot), ConsentReceipt (id, consentId, accountId, programId, purpose, approvedFields, deniedFields, grantedAt, expiresAt, actor, version, hash), EmergencyOverride (id, accountId, reason, authorizedBy, createdAt, expiresAt, active, revokedAt?).
  * ConsentManager class: requestConsent (validates purpose + fields; rejects DENIED_BY_DEFAULT in requestedFields — programs can only request them as optionalFields for user opt-in); grant (activates pending consent, validates approvedFields ⊆ requested ∪ optional, auto-marks missing required as user-denied, issues ConsentReceipt with SHA-256 hash, records version 1); revoke (withdraws, idempotent, retains history); renew (extends expiresAt, new version, new receipt); expire (scheduler sweep — transitions active+expired consents to "expired" status, emits event); getActiveConsents(accountId, programId?); checkAccess(accountId, programId, purpose, field?) — REAL intersection check + emergency-override short-circuit; getHistory(accountId) — all versions across all consents sorted by timestamp; getVersions(consentId); getReceipt(receiptId) — immutable; listReceipts(accountId?); emergencyOverride(accountId, reason, authorizedBy, durationMs?) — creates time-bound override, heavily audited via event; revokeOverride; listOverrides(accountId?); hasActiveOverride(accountId).
  * Versioning: every change (requested/granted/renewed/revoked/expired) appends a ConsentVersion with a full snapshot of the consent at that point. Old versions retained (superseded semantics).
  * Receipt integrity: SHA-256 over a deterministic JSON serialization (sorted arrays, declared key order) — tamper-evident.
  * DEFAULT_CONSENT_DURATION_MS = 90 days; DEFAULT_EMERGENCY_OVERRIDE_MS = 24 hours.
  * DENIED_BY_DEFAULT set: blood_pressure, pregnancy_history, mental_health, prescriptions, genetics, hiv_status, reproductive_health, substance_use (8 categories that programs cannot require — only opt-in via optionalFields).
  * CONSENT_EVENTS const: eks.identity.consent.requested / .granted / .revoked / .expired / .overridden (values for granted/revoked match IDENTITY_EVENTS.consentGranted/consentRevoked for cross-module consistency).
  * Singleton getConsent()/setConsent()/resetConsent().
- Built `src/identity/privacy/index.ts` — centralized privacy service:
  * Types: DataCategory (personal|sensitive|health|financial|biometric|genetic), RetentionAction (delete|anonymize|archive), RetentionPolicy (id, category, ttlSeconds, action, description?), ResidencyRule (region, allowedCategories, deniedCategories, description?), DeletionStatus/ExportStatus/CorrectionStatus unions, DeletionRequest (id, accountId, requestedBy, reason, status, createdAt, completedAt?, denialReason?, dataMinimized[]), ExportRequest (id, accountId, requestedAt, status, manifest?, completedAt?), CorrectionRequest (id, accountId, field, currentValue, newValue, reason, status, createdAt, decidedAt?, decidedBy?), AnonymizationResult<T> (record, anonymizedFields, anonymizedId), PseudonymMapping (pseudonym, originalField, reversible, createdAt), PrivacyImpactLog (id, timestamp, action, actor, subject?, details), TransparencyReport (accountId, generatedAt, dataCategoriesHeld, activeConsents, totalConsents, accessCount, exportCount, deletionCount, correctionCount, retentionApplied, overrides, sessions).
  * PrivacyEngine class: registerRetentionPolicy/listRetentionPolicies; registerRecord (for retention sweeps — real impl would scan databases); enforceRetention(now?) — sweeps records past TTL, applies configured action (delete/anonymize/archive), logs each action to impact log + emits retention_applied event, returns count processed; registerResidencyRule/listResidencyRules; checkResidency(region, category) — REAL rule lookup with default-deny for unknown regions (falls back to "GLOBAL" if registered); requestDeletion/processDeletion/denyDeletion/listDeletionRequests; requestExport/processExport — REAL manifest built from getAccounts() (sanitized: passwordHash/salt stripped) + getConsent().listConsents() + getSessions().listForAccount() (metadata only, no tokens) + deletion/export/correction history; requestCorrection/decideCorrection/listCorrectionRequests; anonymize(record, fields[]) — REAL irreversible field removal + SHA-256 anonymizedId; pseudonymize(record, fields[]) — REAL HMAC-SHA256 with engine-private 32-byte secret key (generated per instance via randomBytes), stable pseudonyms (same input → same output), mapping stored internally for reversal; reversePseudonym(field, pseudonym) — only the privacy service can reverse; listPseudonyms; logImpact(action, actor, subject, details) — writes to impact log + emits impact_logged event; listImpactLogs(accountId?, limit?); transparencyReport(accountId) — REAL summary aggregating across privacy + consent + sessions + accounts engines; minimize(requestedFields, allowedFields) — data minimization intersection.
  * DEFAULT_RETENTION_POLICIES const: 5 policies (session_logs 90d→delete, health_data 10y→anonymize, audit_trail 7y→archive, consents 100y→archive, deleted_accounts 30d grace→delete).
  * RESIDENCY_RULES const: 3 rules (EU denies biometric+genetic; US allows all; GH denies biometric+genetic+financial export).
  * CATEGORY_SENSITIVITY map: personal=low, financial/health/sensitive=high, biometric/genetic=critical.
  * PRIVACY_EVENTS const: eks.identity.privacy.deletion_requested / .export_requested / .correction_requested / .retention_applied / .impact_logged.
  * Singleton getPrivacy()/setPrivacy()/resetPrivacy().
- Type-checked: `npx tsc --noEmit --strict` reports ZERO errors in src/identity/consent/ and src/identity/privacy/. The only error in src/identity/authorization/ is the expected `Cannot find module '../roles'` (m2-2 is building roles in parallel — the import assumes the documented `getRoles().hasPermission(accountId, perm, scope?)` API). When m2-2 lands, the import resolves and the engine wires up. Pre-existing errors in src/identity/{audit,compliance,data-gateway,monitoring}/ (other parallel agents) and examples/skills/ are not in scope for this task.
- Smoke-tested all three modules with a 63-assertion test (temporary stub for ../roles + temporary server-only shim, both removed after verification). All 63 assertions pass under Bun/tsx: default-deny; self-read allow; deleted-account deny; sensitive-perm-without-MFA challenge; sensitive-perm-with-MFA-but-no-allow deny; explicit grant + MFA + matching purpose allow; expired grant ignored; conditional grant country check (deny/allow); simulation produces allow + does NOT persist hypothetical grants; audit log populated; delegation recorded in delegationsUsed (and revoked); DENIED_BY_DEFAULT-as-required rejection; consent request→grant→renew→revoke→history flow; checkAccess intersection logic; receipt SHA-256 hash; consent versioning (requested→granted→revoked = 3 versions); emergency override bypass; minimize intersection; residency EU/US/GH rules; anonymize field removal + id; pseudonymize stability + reversal; retention sweep; deletion workflow; export manifest (with passwordHash stripped); correction workflow; transparency report aggregations; impact log.

Stage Summary:
- Files created (3):
  * src/identity/authorization/index.ts (~950 lines) — unified policy engine: RBAC (via getRoles) + ABAC (PolicyCondition with 11 operators) + PBAC (purpose-bound grants) + hierarchical scoping + conditional/temporary/delegated grants + simulation + audit log + 6 built-in policies + SENSITIVE_PERMISSIONS step-up + AUTH_EVENTS.
  * src/identity/consent/index.ts (~600 lines) — first-class consent platform: request→grant→renew→revoke→expire lifecycle, field-level granularity, purpose-bound, versioned (every change snapshots a ConsentVersion), SHA-256-hashed immutable receipts, emergency overrides, DENIED_BY_DEFAULT opt-in enforcement, CONSENT_EVENTS.
  * src/identity/privacy/index.ts (~640 lines) — centralized privacy service: 5 retention policies + sweep, 3 residency rules, deletion/export/correction workflows, real HMAC-SHA256 pseudonymization (engine-private key, reversible only by privacy service), real SHA-256 anonymization, real transparency reports aggregating across accounts+consent+sessions, data minimization, privacy impact logging, PRIVACY_EVENTS.
- Key decisions:
  * Authorization "challenge" decision is produced by a SENSITIVE_PERMISSIONS step-up short-circuit BEFORE policy evaluation — this avoids information leakage (challenge either way → no inference about whether the account would otherwise have access). The `require_mfa_for_sensitive` policy is a hard-deny backstop with mfaVerified=false condition; in normal operation the step-up fires first.
  * Authorization imports `getRoles` from `../roles` (m2-2, parallel) at runtime for RBAC checks, and `getConsent` from `../consent` (this task) for the `has_consent` policy operator. No cycles: consent doesn't import authorization.
  * Consent `DENIED_BY_DEFAULT` enforcement: programs CANNOT list sensitive fields (genetics, mental_health, etc.) in requestedFields — they must go in optionalFields for explicit user opt-in. The engine rejects the request otherwise.
  * Consent receipts are immutable and tamper-evident (SHA-256 over a deterministic JSON serialization). Every grant and every renewal issues a new receipt; old receipts are retained.
  * Privacy pseudonymization uses HMAC-SHA256 with a 32-byte secret generated per PrivacyEngine instance (randomBytes). The mapping (original → pseudonym) is stored internally and reversible ONLY via `reversePseudonym()` — the secret never leaves the engine.
  * Privacy `processExport` builds a REAL manifest by calling getAccounts().get() (sanitized: passwordHash + passwordSalt stripped), getConsent().listConsents(), getSessions().listForAccount() (metadata only, no tokens), plus deletion/export/correction history. This is the actual data that would be packaged for a GDPR portability export.
  * Privacy `enforceRetention` sweeps registered records (real impl would scan databases) and applies the configured action (delete/anonymize/archive). Each action is logged to the impact log + emitted as retention_applied. "archive" preserves the record (archived elsewhere); "delete" and "anonymize" remove it from the active set.
  * All three modules follow the established pattern exactly: `import "server-only"` at top, ESM with `import type` for types, branded ids from ../core, real in-memory logic (no mocks), events via getEventBus().publish(buildEvent(...)), singleton + setter + resetter.
  * Did NOT create src/identity/index.ts (orchestrator owns the main identity barrel).
- Cross-module contract notes for other agents:
  * Authorization `EvaluationContext` does NOT have a `principal` field — pass `accountId` + `persona` separately. (data-gateway agent may need to update.)
  * Privacy `ExportRequest` / `DeletionRequest` / `CorrectionRequest` are interfaces, not Records — do not cast directly to `Record<string, unknown>`; use `as unknown as Record<string, unknown>` or destructure. (compliance agent may need to update.)
- Next actions: orchestrator should wire the three subsystems into src/identity/index.ts barrel and ensure data-gateway consumes getAuthorization().evaluate() + getConsent().checkAccess() + getPrivacy().minimize() on every data access. The roles subsystem (m2-2) must land for authorization RBAC checks to return non-default-deny results.

---
Task ID: m2-4
Agent: general-purpose (identity: data-gateway, audit, policies, monitoring, compliance)
Task: Build data-gateway + audit + policies + monitoring + compliance

Work Log:
- Read worklog.md, src/identity/core/index.ts (branded ids, IdentityError, IDENTITY_EVENTS, RiskAssessment, Persona, Principal), src/identity/accounts/index.ts and src/identity/sessions/index.ts (manager+singleton pattern, `import "server-only"`, `getEventBus().publish(buildEvent(...))`, `getClock().iso()`, `generateId()`), and src/kernel/index.ts barrel to absorb conventions.
- Inspected kernel core (Brand, CorrelationId, TraceId, Clock, generateId), events (buildEvent signature + PublishOptions shape), and the sibling modules m2-2/m2-3 produced in parallel (authorization EvaluationContext + AuthorizationResult, consent.checkAccess, privacy.requestExport/requestDeletion/requestCorrection/logImpact/minimize) so my integrations match their actual APIs.
- Created src/identity/audit/index.ts (~536 lines) — Audit Platform:
  * Branded AuditExportId; AuditCategory union (auth|permission|consent|data_access|policy|role|session|program|security|privacy); AuditOutcome (success|failure|denied); AuditEntry (timestamp, actor Principal, target, purpose, outcome, correlationId, traceId, source, device, ipMetadata, prevHash, hash, sequence); AuditQuery; AuditChain; AuditExport (signed bundle).
  * REAL SHA-256 hash chain: entryHash = sha256(prevHash + "|" + canonicalJson(entryWithoutHash)); first entry prevHash = "genesis"; deep-sort canonical JSON for stable hashes across runtimes.
  * AuditPlatform.record() appends to a Map (entries can NEVER be deleted or mutated) + maintains bySequence/byActor/byCategory indices + headHash + sequence counter. Emits eks.identity.audit.recorded.
  * verifyChain() walks the chain from genesis, recomputes every hash, returns {valid, brokenAt?, headHash}; emits chain_verified or chain_broken with the broken entry id + reason (prev_hash_mismatch | hash_mismatch).
  * export(filter) returns AuditExport with signature = sha256(all entry hashes concatenated); verifyExport() rechecks signature + every entry's self-hash.
  * query() filters by category/actor/accountId/target/action/outcome/source/correlationId/traceId/since/until with offset+limit, returns reverse-chronological.
  * countByCategory(), countByActor(), getChain(), recordPermissionDecision() helper.
  * AUDIT_EVENTS const; getAudit()/setAudit()/resetAudit() singletons.
- Created src/identity/policies/index.ts (~728 lines) — Security Policies:
  * PolicyRuleKind union (14 kinds: password_complexity, mfa_required, country_allowlist/blocklist, org_allowlist, ip_allowlist/blocklist, geo_fence, rate_limit, failed_login_threshold, session_lifetime, max_sessions, device_trust_required, trusted_network_required); typed PolicyRuleParams for each kind; PolicyRule (kind, params, enforced, message); PolicyScope (global|org|tenant); SecurityPolicy (id, scope, scopeId, rules, version, enabled).
  * PolicyContext (principal, accountId, country, ip, orgId, tenantId, deviceTrustLevel, failedLoginAttempts, sessionAgeSeconds, idleSeconds, sessionCount, persona, asn, isDatacenter, risk); PolicyEvaluationResult (allowed, violatedRules[], remediation[], evaluatedPolicies).
  * REAL password complexity: PASSWORD_RULES const (minLength 12, minClasses 3, forbidCommon, forbidEmailSubstring, historySize 5); checkPasswordAgainst() counts character classes (lower/upper/digit/symbol), rejects top common-passwords set, rejects email-username substring, computes 0-100 strength score → weak/fair/strong/very_strong.
  * REAL CIDR matching: cidrContains() parses IPv4 + IPv6 (with :: abbreviation), compares bit-by-bit up to the prefix length.
  * SecurityPolicyManager.setPolicy/getPolicy/listPolicies/applicablePolicies (merges global+org+tenant)/evaluate (checks ALL applicable rules)/checkPassword (uses most-specific password_complexity rule)/checkGeo (country+ip)/checkRateLimit (real per-key counter with minute/hour/day windows).
  * DEFAULT_GLOBAL_POLICY const auto-registered (12-char passwords, MFA for sensitive personas, 5 failed attempts, 30-day session, 10 max sessions, 600/min rate limit); POLICY_EVENTS const (eks.identity.policy.violated + .changed); getSecurityPolicies()/setSecurityPolicies()/resetSecurityPolicies() singletons; policyFingerprint() helper.
- Created src/identity/monitoring/index.ts (~891 lines) — Security Monitoring:
  * Branded AnomalyId, SecurityNotificationId; IncidentSeverity (low|medium|high|critical); IncidentStatus (open|investigating|contained|resolved|false_positive); AnomalyType (9 types: impossible_travel, credential_stuffing, abnormal_api_usage, permission_abuse, extension_abuse, data_exfiltration, new_device_high_risk, repeated_mfa_failure, unusual_data_volume); Anomaly; SecurityIncident; BehavioralBaseline; SecurityNotification.
  * REAL haversine: haversineKm(a, b) uses the great-circle formula with R=6371 km (verified: London-Paris ≈ 343 km, NYC-LA ≈ 3944 km).
  * REAL impossible-travel: stores last-known lat/lng + timestamp per account; on each successful auth, computes distance/time_delta_hours; if speed > ANOMALY_THRESHOLDS.impossible_travel_speed_kmh (900) AND distance >= 200 km, flags a critical anomaly.
  * REAL credential stuffing: counts distinct failing accounts per IP within a 5-min window; flags when >= 10 distinct accounts.
  * REAL MFA failure tracking: per-account counter with 15-min window; flags at >= 5 failures.
  * REAL data exfiltration: per-account hourly byte bucket; flags at >= 200 MB/hr; platform-wide flag at >= 500 MB/hr (deduped per program+hour).
  * REAL unusual data volume: 3x baseline deviation per account.
  * REAL permission abuse: per-(principal,permission) denial counter with 10-min window; flags at >= 5 denials.
  * detect() groups anomalies by (type, accountId|programId|principalId), picks worst severity, creates a SecurityIncident for medium+ OR any account-touching anomaly, links anomalies back to the incident, auto-notifies affected accounts.
  * createIncident/listIncidents/getIncident/updateIncident/acknowledgeIncident/resolveIncident/dismissIncident; notify() creates SecurityNotification + emits eks.identity.security.notification_sent; listNotifications/markNotificationRead.
  * riskScore(accountId) aggregates anomaly+incident severity weights over 24h → 0-100 score, level, factors[], recommendedAction (allow|challenge|deny|notify).
  * getBaselines/getBaseline/setBaseline; listAnomalies; getStats (totals + bySeverity + byType).
  * ANOMALY_THRESHOLDS const (10 thresholds incl. event ring-buffer cap 10k); MONITORING_EVENTS const; getMonitoring()/setMonitoring()/resetMonitoring() singletons; anomalyFingerprint() helper.
- Created src/identity/data-gateway/index.ts (~870 lines) — Data Access Gateway & Secure Views:
  * DataView union (7: participant_profile, measurement, competition, public_profile, anonymous_research, technician, program_admin); FieldAction (redact|mask|allow|deny); MaskType (email|phone|name|id|default); FieldPolicy (field, view, action, maskType?, transform?, reason?); DataViewDescriptor (id, name, description, requiredPermission, allowedPurposes, fields, maxFieldsPerRequest, cacheable, ttlSeconds); Transformation (name, description, apply()); DataAccessContext; DataAccessRequest (principal, programId, purpose, requestedFields, resourceId?, resourceKind?, context?, data?); DataAccessResponse (view, decision, reasons, fields, allowed, redacted, masked, denied, auditEntryId, rateLimited?, retryAfterMs?, cached?).
  * REAL field masking: redact() → "[REDACTED]"; mask(email) → "j***@example.com"; mask(phone) → "+1***4567"; mask(name) → "J*** D***"; mask(id) → "abcd***mnop"; mask(default) → "***".
  * 5 built-in transformations: hash (SHA-256), bucketize_age (10-year buckets), truncate, round, anonymize (stable pseudonymous hash).
  * VIEWS const — 7 view descriptors with full field-policy matrices: participant_profile (programs see masked name/email, redacted dob/address, denied passwordHash/mfaEnabled), measurement (values allow, deviceId masked, rawSignal denied), competition (leaderboard w/ masked names, denied participantId/email), public_profile (displayName+avatar+bio only), anonymous_research (anonymousId via anonymize transform, ageBucket via bucketize_age, direct identifiers denied), technician (clinical view), program_admin (aggregates only, individual data denied).
  * FIELD_MASKING catalog describing each mask type.
  * DataAccessGateway constructor auto-registers all 7 views + 5 transformations. registerView/registerTransformation/listViews/getView.
  * async access(request, view) — the core orchestration: (0) per-program rate-limit check; (1) authorization via getAuthorization().evaluate() with proper EvaluationContext (accountId, persona, programId, purpose, resource, ipAddress, fields, time); (2) purpose validity against view.allowedPurposes; (3) per-field consent via getConsent().checkAccess(accountId, programId, purpose, field); (4) field policy (deny → denied, redact → "[REDACTED]", mask → mask(value, maskType), allow → optional transform); (5) audit via getAudit().record() with category=data_access; (6) privacy impact log via getPrivacy().logImpact(action, actor, subject, details); (7) emit eks.identity.data.accessed with denied-fields list.
  * Every code path (allow/deny/challenge/rate-limited) produces an audit entry + emits the data.accessed event. Privacy log failures are caught so they never block data access.
  * checkRate(key, limit) — real per-key per-minute counter. DATA_GATEWAY_EVENTS const; getDataGateway()/setDataGateway()/resetDataGateway() singletons.
- Created src/identity/compliance/index.ts (~865 lines) — Compliance Readiness:
  * Branded FrameworkId, ControlId, DsrId, BreachId; ComplianceFrameworkKind (gdpr|hipaa|soc2|iso27001|ccpa|pipeda|local); ControlStatus (implemented|partial|planned|not_applicable); ComplianceControl (id, frameworkId, code, title, description, status, mapsTo?, evidence?, assessedAt?, assessedBy?); ComplianceMapping; ComplianceAssessment; ComplianceFramework (id, kind, name, description, region, regulator, controls, notificationWindowHours); DsrType (access|rectification|erasure|portability|restriction|objection); DsrStatus; DataSubjectRequest (id, accountId, type, status, receivedAt, dueBy, completedAt?, denialReason?, requestorId?, metadata?, result?); BreachSeverity; BreachNotification (id, frameworkId?, title, description, severity, discoveredAt, reportedAt?, reportedBy?, affectedAccounts, affectedRecords?, notificationDeadline, notificationsSent[], contained, containedAt?, metadata?); ComplianceReport (frameworkId, frameworkName, generatedAt, totalControls, byStatus, readinessPercent, gaps, mappings, controls).
  * FRAMEWORKS const — 7 frameworks (the 5 required + pipeda + local placeholder): GDPR (14 controls, Art.6/7/9/12/15/16/17/18/20/21/25/33/34/35 — right_to_erasure maps to privacy.requestDeletion, right_to_access maps to privacy.requestExport, etc.; 72h breach window), HIPAA (10 controls — 164.312 access control/audit/integrity/auth/transmission security + 164.308 risk analysis/management/sanction; 60-day individual notification window), SOC2 (9 controls — CC6.1/CC6.6/CC7.2/CC7.3/CC7.4/A1.2/C1.1/P5.1/P6.1), ISO27001 (11 controls — A.5.1/A.5.10/A.6.1/A.6.3/A.5.9/A.5.15/A.8.24/A.8.16/A.5.24/A.5.34/A.5.30), CCPA (6 controls — 1798.100/105/120/125/130/135), PIPEDA (6 principles), local (empty). Total: 56 controls, all with feature mappings.
  * ComplianceManager: registerFramework/listFrameworks/getFramework/getFrameworkByKind/getControl/assessControl (records evidence+assessor+timestamp, emits eks.identity.compliance.control_assessed)/mapControlToFeature (declarative control→feature linkage)/getAssessment/getMapping/generateReport (per-control status+mappings+evidence, overall readiness % = Σ status weights / total, where implemented=1, partial=0.5, planned=0, not_applicable=1; emits eks.identity.compliance.report_generated).
  * createDataSubjectRequest(accountId, type, opts) — REAL delegation to privacy engine: access/portability → getPrivacy().requestExport(accountId); erasure → getPrivacy().requestDeletion(accountId, requestedBy, reason); rectification → getPrivacy().requestCorrection(accountId, field, currentValue, newValue, reason); restriction/objection → recorded pending manual review. 30-day due-by default (GDPR Art.12(3)). Emits eks.identity.compliance.dsr_created. Privacy failures don't lose the DSR record.
  * completeDataSubjectRequest/listDataSubjectRequests.
  * recordBreach(input) — computes notificationDeadline from framework.notificationWindowHours (GDPR=72h verified); recordBreachNotificationSent (regulator/data_subjects/dpo via email/letter/portal/phone); containBreach; listBreaches; getBreach.
  * applicableFrameworks(country, sector) — REAL declarative rules: EU countries + GB → GDPR; US+health → HIPAA; US → CCPA; CA → PIPEDA; audit/saas/enterprise → SOC2+ISO27001. No business-logic coupling — purely declarative.
  * aggregateReadiness(frameworkIds[]) — cross-framework overall %.
  * COMPLIANCE_EVENTS const; getCompliance()/setCompliance()/resetCompliance() singletons; controlFingerprint() helper.
- Resolved cross-module API drift discovered when running the project's tsc against the siblings m2-2/m2-3 produced in parallel: (1) PublishOptions doesn't have traceId → moved traceId into the event payload instead; (2) EvaluationContext requires accountId+persona+time, not principal → restructured the data-gateway authz call to build the proper context (and deny early if the principal lacks accountId/activePersona); (3) getPrivacy().logImpact takes (action, actor, subject, details) not a single object → adapted the call; (4) getPrivacy().requestExport takes 1 arg, requestDeletion takes 3, requestCorrection takes 5 → restructured createDataSubjectRequest to accept an opts bag with requestedBy/reason/field/currentValue/newValue and dispatch correctly; (5) Array.prototype.reduce<T> requires an initial value when using the generic form → added list[0] as the seed.
- Confirmed `npx tsc --noEmit` (full project, with siblings present) reports ZERO errors in any of the five new files. The only identity-scoped error is in m2-2's `authorization/index.ts` importing `../roles` (m2-2's own territory).
- Wrote and ran a 322-assertion smoke test (scratch file, since deleted) exercising the REAL logic end-to-end: SHA-256 hash chain (genesis linking, hash recomputation via computeEntryHash, verifyChain, export signature via verifyExport), password complexity (weak/strong/email-substring), CIDR matching (IPv4 + IPv6 + 0.0.0.0/0 + /128), haversine (London-Paris ≈ 343 km, NYC-LA ≈ 3944 km, same-point=0), impossible travel (London→NYC in 30 min flagged at 11,000+ km/h), credential stuffing (12 distinct failing accounts from one IP flagged), MFA failure (5 fails flagged), data exfiltration (1 GB flagged), incident lifecycle (create→acknowledge→resolve), risk scoring (0-100 + factors), notifications (create + mark-read), field masking (email/phone/name/id/default), view catalog (7 views), compliance catalog (7 frameworks, 56 controls, 30+ feature mappings, GDPR 72h breach window verified). All 322 assertions pass under Bun. Smoke test file, the temporary roles stub (for transitive authorization → roles resolution), and the temporary node_modules/server-only shim were all removed after verification.

Stage Summary:
- Files created (5):
  * src/identity/audit/index.ts (~536 lines) — append-only SHA-256 hash-chained audit log with verifyChain, signed exports, query, counts, recordPermissionDecision helper. getAudit() singleton.
  * src/identity/policies/index.ts (~728 lines) — 14-rule security policy engine with REAL password complexity, REAL CIDR matching (IPv4+IPv6), geo-fencing, rate limiting, scope merging (global+org+tenant). DEFAULT_GLOBAL_POLICY auto-registered. getSecurityPolicies() singleton.
  * src/identity/monitoring/index.ts (~891 lines) — REAL haversine impossible-travel, credential stuffing, MFA failure, data exfiltration, permission abuse, unusual-volume detectors; incident lifecycle; risk scoring; behavioral baselines; notifications. getMonitoring() singleton.
  * src/identity/data-gateway/index.ts (~870 lines) — Programs-never-touch-DB gateway: 7 secure views, 5 transformations, real field masking (email/phone/name/id), orchestration of authorization → consent → field policy → audit → privacy log → rate limit. getDataGateway() singleton.
  * src/identity/compliance/index.ts (~865 lines) — 7 declarative compliance frameworks (GDPR/HIPAA/SOC2/ISO27001/CCPA/PIPEDA/local), 56 controls with feature mappings, report generation with readiness %, DSR routing to privacy engine (access→requestExport, erasure→requestDeletion, rectification→requestCorrection), breach notification tracking with framework-specific deadlines, applicableFrameworks(country, sector). getCompliance() singleton.
- Key decisions:
  * Audit hash chain binds prevHash into each entry's hash (sha256(prevHash + "|" + canonicalJson(entryWithoutHash))) — modifying any historical entry invalidates every subsequent hash; verifyChain() walks from genesis and reports the first mismatch. Entries are stored in a Map and indexed by sequence/actor/category for fast queries — NEVER mutated or deleted.
  * Password complexity uses real character-class counting + a built-in common-password set + email-substring rejection + a 0-100 strength heuristic (length bonus, class bonus, common-password penalty).
  * CIDR matching is a real bit-by-bit prefix comparison supporting both IPv4 and IPv6 (with :: abbreviation expansion).
  * Impossible travel uses the real haversine great-circle formula and a 900 km/h speed threshold (commercial jet cruising speed) — anything faster is physically impossible.
  * Data gateway applies field policies AFTER consent checks: consent is the legal basis, field policy is the technical minimization. Privacy log failures are caught so they never block legitimate data access (the audit entry already captures the access for compliance).
  * Compliance is purely declarative: framework catalogs + control → platform-feature mappings. No business logic is hardcoded — `applicableFrameworks(country, sector)` is a pure rule table, `generateReport()` sums status weights, DSRs delegate to the privacy engine.
  * All five modules follow the established pattern: `import "server-only"`, `import type` for types, branded ids, manager class + get<Name>()/set<Name>()/reset<Name>() singleton accessors, real working logic (no mocks), no external deps beyond node:crypto, events published via getEventBus().publish(buildEvent(...)).
  * All five modules use top-level imports for sibling modules (authorization, consent, privacy, audit) — no cycles since the siblings don't import these five. Cross-module API drift was discovered and resolved by adapting to the siblings' actual signatures.
- No external dependencies added; no changes to package.json. Did NOT create src/identity/index.ts (orchestrator owns that barrel).
- Next actions: orchestrator should wire these five subsystems into src/identity/index.ts, expose API routes (/api/identity/audit, /api/identity/policies, /api/identity/monitoring, /api/identity/data-gateway, /api/identity/compliance), and build console panels. The data-gateway's access() method is the chokepoint all program data reads should route through. The compliance manager's generateReport() should drive the compliance dashboard. The monitoring riskScore() should feed the auth step-up decision.

---
Task ID: M2-FINAL
Agent: orchestrator
Task: Complete Milestone 2 — API routes, console, verification

Work Log:
- Built 16 API routes under /api/identity/* (accounts CRUD+verify+persona, auth sign-in+mfa+signout, sessions list+revoke, orgs CRUD+members+invite, roles list+assign+simulate, consent request+grant+check, audit list, monitoring incidents, compliance reports, authorize evaluate) + /api/platform/snapshot aggregator.
- Built unified Platform Console at / route: sidebar nav (13 sections), 13 section components (overview, kernel, architecture, accounts, auth, sessions, orgs, roles, authorization, consent, audit, monitoring, compliance), theme provider (dark default, emerald accent), sticky footer.
- Fixed all TypeScript errors (0 in src/kernel, src/identity, src/app, src/components, src/hooks, src/lib).
- Fixed all ESLint errors (replaced require() with top-level node:crypto imports).
- Agent Browser end-to-end verification PASSED:
  * Page loads, all 13 sidebar sections render.
  * Accounts section: 5 demo accounts shown, persona catalog with permissions.
  * Authentication: sign-in form, providers listed.
  * Sign-in flow WORKS: POST /api/identity/auth 200 → authenticated principal with sessionId, accessToken, refreshToken, riskScore=15, strength=single.
  * Sessions: stats + policy (15min/7d/30d/1h/10max) + recent sessions list.
  * Consent: denied-by-default fields, PBAC request flow.
  * Audit: hash-chained immutable trail, tamper-evident.
  * Compliance: 7 frameworks (GDPR/HIPAA/SOC2/ISO27001/CCPA/PIPEDA/local), 56 controls, readiness bars.
  * No console errors.
- VLM screenshot review: "well-designed, professional dashboard interface with no glaring layout errors."

Stage Summary:
- Milestone 2 COMPLETE. Identity platform (15 subsystems) + kernel (16 subsystems) + API routes + console all verified working end-to-end in the browser.
- Total: 31 platform subsystems, 0 TypeScript errors, 0 lint errors, sign-in flow verified with real PBKDF2 + session issuance.
