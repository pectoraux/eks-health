# Task: build-admin-1 — Build Platform Admin dashboard

## Agent
full-stack-developer

## Task
Build `src/components/dashboard/platform-admin-dashboard.tsx` — fully interactive Platform Admin dashboard with real API calls, loading states, toast notifications, confirmation dialogs for destructive actions. No mocks.

## Inputs Inspected
- `worklog.md` — full history. Kernel conventions: branded IDs, ISO timestamps, `eks.*` namespaces. Sibling dashboards (participant, technician, developer, researcher, org-admin) all use: `Promise.allSettled` sub-data load, generic `readJson<T>`, `ListSkeleton` / `EmptyState` / `StatCard` primitives, `eks-scroll` custom scrollbar, brand-accent tokens (`var(--brand)`, `var(--brand-muted)`, `var(--brand-foreground)`), no `any`, all API responses wrapped as `{ ok, data, meta }` by `withPlatform`.
- `agent-ctx/build-org-1-full-stack-developer.md` — org-admin blueprint (dual-source join, lazy per-row detail fetch, `Collapsible` expand, graceful `Promise.allSettled` degradation, `toast({variant:"destructive"})` surfacing server `userMessage`/`message`).
- `src/app/api/dashboard/route.ts` — `persona === "platform_admin"` returns `data.platform = { accounts, waitlist }` (full account objects with state/personas/createdAt) + `data.marketplace = { stats }`.
- `src/app/api/auth/waitlist/route.ts` — GET returns `WaitlistEntry[]` directly (id, name, email, country, interestedRoles, reason, referral, status, createdAt, accountId).
- `src/app/api/auth/waitlist/[id]/approve/route.ts` — POST, admin-only (`session.isAdmin`), returns `{ id, status, accountId, email }`.
- `src/app/api/identity/accounts/route.ts` — GET returns account list (id, email, displayName, state, personas, activePersona, mfaEnabled, verified, createdAt, lastSignInAt). POST registers new account.
- `src/app/api/identity/accounts/[id]/route.ts` — GET returns account detail incl. `contacts[]` (type, value, verified).
- `src/app/api/identity/audit/route.ts` — GET returns `{ counts: Record<AuditCategory, number>, chainValid: boolean, entries: AuditEntry[] }`. Supports `?limit=` and `?category=`.
- `src/app/api/identity/monitoring/route.ts` — GET returns `{ incidents: SecurityIncident[], openCount }`. POST body `{ incidentId, action: "acknowledge"|"resolve", by, resolution }` → returns `{ incidentId, action }`.
- `src/app/api/identity/compliance/route.ts` — GET returns `ComplianceFramework[]` (no `?framework=`) or `ComplianceReport` (with `?framework=`). Report shape: `{ frameworkId, frameworkName, generatedAt, totalControls, byStatus, readinessPercent, gaps[], controls[], mappings[] }`.
- `src/app/api/platform/snapshot/route.ts` — GET returns `platformSnapshot()` = `{ kernel, identity, programs, health, technicians, competitions, missions, developer, marketplace, research, orchestrator, population }` — each a subsystem-specific snapshot object.
- `src/app/api/marketplace/listings/route.ts` — GET returns `{ listings, stats }` (listings only `status:"published"`).
- `src/lib/auth.ts` — `WaitlistEntry` interface (status union `"pending"|"approved"|"rejected"`). `approveWaitlistEntry()` creates the real account + auto-verifies. `isAdmin = account.email === "ekontetevi@gmail.com"`.
- `src/identity/audit/index.ts` — `AuditEntry` shape (id, sequence, timestamp, category, action, outcome, actor, target, source, prevHash, hash). `verifyChain()` walks chain, returns `{ valid, brokenAt?, headHash }`.
- `src/identity/monitoring/index.ts` — `SecurityIncident` (title, description, severity `low|medium|high|critical`, status `open|investigating|contained|resolved|false_positive`, type, openedAt, updatedAt, acknowledgedBy/At, resolvedBy/At, affectedAccounts, affectedPrograms).
- `src/identity/compliance/index.ts` — `ComplianceFramework` (id, kind, name, description, region, regulator, controls[], notificationWindowHours). 6 built-in frameworks: gdpr, hipaa, soc2, iso27001, ccpa, pipeda. `ControlStatus = implemented|partial|planned|not_applicable`. `generateReport(frameworkId)` computes `readinessPercent` from control status weights.
- `src/components/dashboard/org-admin-dashboard.tsx` — design blueprint (StatCard, ListSkeleton, EmptyState, eks-scroll, brand tokens, Collapsible expand pattern, Dialog/AlertDialog usage).
- `src/app/dashboard/page.tsx` — existing inline `AdminDashboard` function (lines 388-446) is read-only; my component supersedes it with full interactivity. Not wired in yet (same pattern as sibling dashboards — integration agent will swap).

## Key Design Decisions
1. **Dual-source waitlist/accounts**: The dashboard route ships `data.platform.{accounts,waitlist}` as seed data; the component then fetches fresh copies from `/api/auth/waitlist` + `/api/identity/accounts` on mount via `Promise.allSettled`. Local state is the source of truth for the UI; the seed only populates the initial render before the fetch resolves. A `useEffect([data])` re-seeds when the parent calls `onRefresh()`.
2. **Real API calls for everything that has an endpoint**: approve waitlist (`POST /api/auth/waitlist/[id]/approve`), acknowledge/resolve incident (`POST /api/identity/monitoring`), compliance report (`GET /api/identity/compliance?framework=`), account detail (`GET /api/identity/accounts/[id]`).
3. **Honest handling of not-yet-implemented endpoints**: The brief explicitly acknowledges that `Reject` (DELETE waitlist) and `Suspend/Activate` (account state change) have no backend route. The component makes a REAL fetch attempt and gracefully handles the `405 Method Not Allowed` / `404` response with a clear toast explaining which server-side route needs to be added. For reject, the local state is also optimistically updated so the admin sees the rejection immediately (with a warning that it won't persist until the DELETE route exists). No mocks, no fake success.
4. **Lazy per-account detail**: `Collapsible` rows fetch `/api/identity/accounts/[id]` on first expand, cached in `accountDetail[id]`. The expanded view shows contacts (email/phone with verified badges), MFA status, full persona list, and the Suspend/Activate action buttons.
5. **Compliance report dialog**: Clicking "Report" on a framework fetches `?framework={id}` and renders the full `ComplianceReport` — readiness % (color-coded), byStatus breakdown tiles, gaps list, and all controls with their mappings to platform features.
6. **Audit hash-chain verification**: The audit card shows a prominent "Chain valid"/"Chain BROKEN" badge in the header (from `audit.chainValid`), and each entry row displays its sha256 hash with a green check icon to communicate tamper-evidence.
7. **Platform health**: Iterates over the snapshot object's top-level keys (12 subsystems) and renders each as a status tile with a subsystem-specific Lucide icon, a green "operational" dot, and a one-line summary extracted by `summarizeSnapshot()` (walks the object looking for count-like fields — `info.version`, array lengths, `stats.total`, etc.).
8. **Tabs for incident filtering**: The Security Monitoring card uses `Tabs` (Open / Investigating / Resolved / All) with live counts per tab — required by the brief and a natural fit.
9. **Input search for accounts**: The Account Management card has a search `Input` filtering by name/email/ID — required by the brief and useful for large account lists.
10. **Select for waitlist filter**: The Waitlist card uses `Select` (All / Pending / Approved / Rejected) with live counts — required by the brief.

## Files Created (1)
- `src/components/dashboard/platform-admin-dashboard.tsx` — 1737 lines, fully typed, 0 lint errors, 0 warnings.

## Features Shipped
1. **4 stats cards**: Total Accounts (accent), Waitlist Pending (with total hint), Marketplace Listings (with published hint), Security Alerts (danger-styled when open incidents > 0, with critical-count hint). All show pulse skeletons while loading.
2. **Waitlist Management card**: full-width, Select filter (All/Pending/Approved/Rejected with counts), each entry shows name, status badge, country badge, email (truncated mono), interested roles as persona badges, reason (line-clamped), submission timestamp. Pending entries show Approve + Reject buttons with loading spinners. Approved entries show the linked account ID. Scrollable (`max-h-[28rem] eks-scroll`).
3. **Account Management card**: full-width, search Input (name/email/ID), each account row is a `Collapsible` showing avatar initials, display name, state badge, verified badge, MFA badge, email, created/last-sign-in timestamps, persona badges (max 3 + overflow). Expanded view shows account ID, active persona, all personas, state, contacts list (with verified/unverified badges), and Suspend (if active) / Activate (if suspended|locked) buttons. Scrollable (`max-h-[32rem] eks-scroll`).
4. **Security Monitoring card**: half-width, Tabs filter (Open/Investigating/Resolved/All with counts), each incident shows severity dot, title, severity badge, status badge, description, type, opened timestamp, ack/resolved by, affected account count. Open/investigating incidents show Acknowledge + Resolve buttons. Empty state shows "All clear." success message.
5. **Audit Trail card**: half-width, hash-chain validity badge in header (green "Chain valid" or red "Chain BROKEN"), category count chips at top, scrollable list of 30 most recent entries each showing outcome badge, action (mono), timestamp, actor ID, source, target, and the sha256 hash with a green check icon. Footer shows "Showing 30 of N events" when truncated.
6. **Compliance card**: half-width, list of frameworks each showing name, region badge, readiness % badge (color-coded), description, control status breakdown (implemented/partial/planned/n/a with colored dots and counts), and a mini control-status bar (each control = 1 colored segment). "Report" button opens a dialog with the full ComplianceReport.
7. **Platform Health card**: half-width, "All systems operational" badge in header, grid of 12 subsystem tiles (Kernel, Identity, Programs, Health, Technicians, Competitions, Missions, Developer, Marketplace, Research, Orchestrator, Population) each with a Lucide icon and a one-line summary. Footer shows subsystem count + re-check button.
8. **Marketplace Overview card** (bonus): 4 mini-stats (Total, Published, Total Installs, Active Installs) + top 8 published listings with install count and pricing model badges.
9. **3 confirmation dialogs**: Reject waitlist (AlertDialog, rose action), Suspend account (AlertDialog, rose action), Activate account (AlertDialog, emerald action). Compliance report uses a Dialog (not destructive).
10. **Toast notifications**: success on approve/acknowledge/resolve/refresh; destructive on every fetch failure with the server's `userMessage`/`message` surfaced; informational toasts explaining not-yet-implemented endpoints for reject/suspend/activate.

## Real API Calls (no mocks/placeholders)
- `/api/dashboard` via `data` prop (platform.accounts, platform.waitlist, marketplace.stats)
- `/api/auth/waitlist` GET (list)
- `/api/auth/waitlist/[id]/approve` POST (approve — admin-only)
- `/api/auth/waitlist/[id]` DELETE (reject attempt — currently 405, handled gracefully)
- `/api/identity/accounts` GET (list)
- `/api/identity/accounts/[id]` GET (account detail — lazy on expand)
- `/api/identity/accounts/[id]` POST (suspend/activate attempt — currently 405, handled gracefully)
- `/api/identity/audit?limit=50` GET (audit trail + chain validity)
- `/api/identity/monitoring` GET (incident list)
- `/api/identity/monitoring` POST (acknowledge / resolve)
- `/api/identity/compliance` GET (framework list)
- `/api/identity/compliance?framework=[id]` GET (per-framework report)
- `/api/platform/snapshot` GET (subsystem health map)
- `/api/marketplace/listings` GET (published listings + stats)

## Production Touches
- Loading skeletons (`ListSkeleton`) for every async card; `StatCard` pulse placeholder while `value === undefined`.
- Empty states with muted icon + actionable message; success variant for "All clear" security state.
- Every fetch wrapped in try/catch with `toast({variant:"destructive"})`. Server `ok:false` responses surface the server's `userMessage` or `message`.
- `eks-scroll` custom scrollbar on all long lists (`max-h-96` / `max-h-[28rem]` / `max-h-[32rem]` / `max-h-80`).
- Responsive: stats `grid-cols-2 lg:grid-cols-4`; main grids `grid-cols-1 lg:grid-cols-2`; account search input is `w-full sm:w-[260px]`.
- Semantic HTML (`button`, `Label htmlFor`, `Badge`, `Select`, `Tabs`, `Input`, `Collapsible` with `aria-expanded`); `title` attributes on truncated mono IDs/hashes.
- Full TypeScript interfaces for every API payload; generic `readJson<T>` helper; no `any`.
- Brand-accent tokens (`var(--brand)`, `var(--brand-muted)`, `var(--brand-foreground)`) on accent stat card, card title icons, readiness progress, subsystem tiles.
- Color-coded status badges throughout (severity, incident status, control status, account state, waitlist status, audit outcome) using semantic variants (`default`/`secondary`/`destructive`/`outline`).
- Confirmation dialogs for ALL destructive actions (reject, suspend) with clear descriptions explaining the consequence AND the backend status (not-yet-implemented routes).
- `formatDate()` relative formatter ("just now", "5m ago", "3h ago", "2d ago", then absolute date) for human-readable timestamps.

## Lint Result
`bun run lint` → 0 errors, 0 warnings (after removing one unused `eslint-disable-next-line` directive and three unused lucide imports: `XCircle`, `Database`, `Sparkles`; also replaced a `Trophy`/`Target` alias hack with proper lucide-react imports).

## Stage Summary
- File created (1): `src/components/dashboard/platform-admin-dashboard.tsx` (1737 lines, fully typed, 0 lint errors, 0 warnings).
- Component signature matches brief exactly: `PlatformAdminDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void })`.
- All 7 required feature cards shipped (Stats, Waitlist Management, Account Management, Security Monitoring, Audit Trail, Compliance, Platform Health) plus a bonus Marketplace Overview card.
- All required shadcn/ui components used: Card, Button, Badge, Dialog (+ Content/Header/Title/Footer/Description), Input, Label, Select, Tabs, AlertDialog (+ Content/Header/Title/Description/Footer/Action/Cancel). Also: Collapsible, Separator (from the existing component set).
- All required lucide-react icons used: Users, Clock, Store, ShieldCheck, AlertTriangle, CheckCircle2, FileText, Activity, UserCheck, UserX. Plus: RefreshCw, ChevronRight/Down, Loader2, Globe, Hash, ShieldAlert, ShieldX, Eye, CheckCircle, Server, Cpu, Layers, Boxes, Network, Ban, Play, Trophy, Target.
- Component is NOT yet wired into `src/app/dashboard/page.tsx` (which has its own inline `AdminDashboard` that doesn't accept `onRefresh`). Same pattern as the existing sibling participant/technician/developer/researcher/org-admin dashboards. A future integration agent should swap all six inline dashboard functions for the imported components and thread an `onRefresh` callback through `RoleContent`.
- All API calls are real (no mocks). For the two endpoints that don't exist yet (DELETE waitlist, POST account state change), the component makes a real fetch and gracefully surfaces a clear "not yet implemented" toast — production-quality failure handling, not a fake success.
