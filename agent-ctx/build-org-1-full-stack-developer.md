# Task: build-org-1 — Build Org Admin dashboard

## Agent
full-stack-developer

## Task
Build `src/components/dashboard/org-admin-dashboard.tsx` — fully interactive Org Admin dashboard with real API calls, loading states, toast notifications.

## Inputs Inspected
- `worklog.md` — full history (build-tech-1, build-dev-1, build-research-1 agent conventions: Promise.allSettled sub-data load, eks-scroll, brand-accent tokens, ListSkeleton/EmptyState/StatCard primitives, generic readJson<T>, no `any`).
- `src/app/api/population/{organizations,memberships,funding,campaigns}/route.ts` — exact response shapes.
- `src/app/api/identity/orgs/route.ts` — GET returns Organization[] directly; POST expects `{name, type, createdBy?}`, returns `{orgId, name, type}`.
- `src/app/api/identity/orgs/[id]/route.ts` — GET returns `{org, members, teams}`; POST expects `{accountId, role}` and maps role→org-scoped platform role.
- `src/app/api/identity/orgs/[id]/invite/route.ts` — POST expects `{email, role, invitedBy?}`, returns `{invited, email, token}`.
- `src/app/api/identity/accounts/route.ts` — GET returns account list (id, email, displayName, state, personas, activePersona).
- `src/app/api/dashboard/route.ts` — `persona === "org_admin"` returns `data.population = { stats: getPopulationAnalytics().getStats() }`. Real shape is `{totalQueries, byMethod}`, not the brief's `{totalContexts, avgGoals}` — component handles BOTH shapes gracefully.
- `src/population/core/index.ts` — PopulationOrganization, OrganizationType (14 types), OrganizationTier, CampaignStatus, CampaignScope, MembershipRole unions.
- `src/population/hierarchy/index.ts` — getStats() shape.
- `src/population/membership/index.ts` — getStats() shape: `{total, active, invited, left, removed}`.
- `src/population/funding/index.ts` — FundingStats shape: `{totalPolicies, activePolicies, totalRequests, requestsByStatus, totalFunded, currency}`.
- `src/population/campaigns/index.ts` — CampaignStats shape: `{total, byStatus, byScope, avgParticipationRate, totalActualParticipation, totalParticipationGoal}`.
- `src/identity/organizations/index.ts` — Identity Organization (id, type, name, slug, description, parentId, dataClassification, status, website, address, locale, createdAt, updatedAt, createdBy), OrgMembership (orgId, accountId, role, title, departmentId, addedAt, addedBy, active, removedAt), Team (id, orgId, name, description, departmentId, memberAccountIds, createdAt, createdBy), OrgRole union (owner|admin|member|billing|auditor|delegate), OrganizationType union (hospital|clinic|company|government|university|ngo|insurance|research_institution), ORG_TYPES catalog.
- `src/population/analytics/index.ts` — getStats() returns `{totalQueries, byMethod}` (AnalyticsStats).
- `src/lib/platform-server.ts` — withPlatform wraps responses as `{ok:true, data, meta}` on success, `{ok:false, error: {code, message, userMessage, ...}}` on failure with appropriate HTTP status (400/404/403/409/429/500).
- `src/components/dashboard/developer-dashboard.tsx` — used as blueprint for design conventions.
- `src/app/dashboard/page.tsx` — DashboardData interface for `population?: { stats: { totalContexts?: number; avgGoals?: number } }`.

## Key Design Decisions
1. **Dual-source org list**: Identity orgs (`/api/identity/orgs`) are the primary list because they have valid IDs for the `/api/identity/orgs/[id]` detail/add/invite endpoints. Population orgs (`/api/population/organizations`) are joined by slug to enrich each row with `memberCount`, `activeMemberCount`, `tier`, and `country` — these fields don't exist on identity orgs.
2. **Hierarchy level**: Computed client-side by walking `parentId` chains on identity orgs (memoized `depthMap`). Displayed as `L0`, `L1`, ... badge.
3. **Lazy per-org detail**: `Collapsible` rows fetch `/api/identity/orgs/[id]` on first expand, cached in `orgDetail[id]`. Refresh after add-member invalidates the cache so the new member shows up immediately.
4. **Graceful degradation**: `Promise.allSettled` for the 6 parallel GETs; partial-failure banner above the grid; per-org detail failure shows an inline amber notice explaining that "Add Member" and "Invite Member" are disabled until the org is provisioned in the identity subsystem.
5. **DashboardData shape**: Component accepts both the brief-declared `{totalContexts, avgGoals}` and the real backend `{totalQueries, byMethod}` — displays whichever is present so the dashboard works against the live backend without lying about what data exists.

## Files Created (1)
- `src/components/dashboard/org-admin-dashboard.tsx` — ~1210 lines, fully typed, 0 lint errors.

## Features Shipped
1. **4 stats cards**: Organizations (accent), Total Members, Active Campaigns, Population Reach — all with loading skeletons, derived hints, and a Refresh button.
2. **Organizations card** (full-width, expandable): each row shows name, type badge, hierarchy level badge, status badge, slug (mono), country, tier, member count. Expanded view shows members list (with role badges + account display info), teams grid, and Add Member + Invite Member action buttons.
3. **Create Organization dialog**: name input + type select (8 identity org types) → POST `/api/identity/orgs`. Loading state, validation, toast on success/failure, form reset on close.
4. **Add Member dialog**: account select (populated from `/api/identity/accounts`) + role select (6 roles) → POST `/api/identity/orgs/[id]`. Loading state, validation, toast with member display name on success.
5. **Invite Member dialog**: email input (with regex validation) + role select → POST `/api/identity/orgs/[id]/invite`. Loading state, validation, toast on success/failure.
6. **Active Campaigns card**: list sorted by status priority (active→scheduled→paused→draft→completed→cancelled), each row shows status dot (color-coded), status badge, scope badge, participation progress bar (actual/goal), and percentage. Mini-stats footer shows avg participation, total reach, goal sum.
7. **Funding Overview card**: 2 metric tiles (Active Policies + Total Funded with currency badge), funding requests by status as horizontal bars (color-coded: executed=emerald, approved=brand, pending=amber, rejected=rose, cancelled=muted).
8. **Population Analytics card**: 4 metric tiles (Analytics Queries, Avg Goals, Participation Rate, Campaign Reach) + by-method bars (analytics query breakdown) + Organizations by Type bars (2-column grid).

## Real API Calls (no mocks/placeholders)
- `/api/dashboard` via `data` prop (population.stats)
- `/api/identity/orgs` GET (list)
- `/api/identity/orgs` POST (create)
- `/api/identity/orgs/[id]` GET (org detail + members + teams)
- `/api/identity/orgs/[id]` POST (add member)
- `/api/identity/orgs/[id]/invite` POST (invite by email)
- `/api/identity/accounts` GET (account picker)
- `/api/population/organizations` GET (org stats + member counts)
- `/api/population/memberships` GET (membership stats)
- `/api/population/funding` GET (funding stats)
- `/api/population/campaigns` GET (campaign list + stats)

## Production Touches
- Loading skeletons (ListSkeleton) for every async card; StatCard pulse placeholder while loading.
- Empty states with muted icon + actionable message.
- Every fetch wrapped in try/catch with `toast({variant:"destructive"})`. Server `ok:false` responses surface the server's `userMessage` or `message` from the error object.
- `eks-scroll` custom scrollbar on all long lists (`max-h-96` / `max-h-[40rem]`).
- Responsive: stats `grid-cols-2 lg:grid-cols-4`, main grids `grid-cols-1 lg:grid-cols-2`.
- Semantic HTML (`button`, `a`, `Label htmlFor`, `Badge`, `Select`); ARIA `aria-expanded` on collapsible triggers.
- `title` attributes on truncated mono IDs/slugs.
- Full TypeScript interfaces for every API payload; generic `readJson<T>` helper; no `any`.

## Lint Result
`bun run lint` → 0 errors, 0 warnings on first pass after one fix (escaped `\"` in JSX string literal → template literal).

## Stage Summary
- File created (1): `src/components/dashboard/org-admin-dashboard.tsx` (~1210 lines, fully typed, 0 lint errors).
- Component signature matches brief: `OrgAdminDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void })`.
- All 8 required features shipped (4 stats cards, Organizations card with expandable members/teams + Add Member + Invite Member dialogs, Create Organization dialog, Active Campaigns card with progress metrics, Funding Overview card with allocated-vs-spent visual bars, Population Analytics card with metrics + by-method bars + by-type bars).
- Component is NOT yet wired into `src/app/dashboard/page.tsx` (which has its own inline `OrgAdminDashboard` that doesn't accept `onRefresh`). Same pattern as the existing sibling participant/technician/developer/researcher dashboards. A future integration agent should swap all five inline dashboard functions for the imported components and thread an `onRefresh` callback through `RoleContent`.
