# Task: build-dev-1 — Developer dashboard

**Agent:** full-stack-developer
**Started:** synchronous session
**Target file:** `src/components/dashboard/developer-dashboard.tsx`

## Context I read first
- `/home/z/my-project/worklog.md` (full history — confirmed prior agents built the platform kernel, all 10 DB-backed subsystems, and a sibling `technician-dashboard.tsx` with the same prop signature `{ data, onRefresh }`).
- `/home/z/my-project/agent-ctx/build-tech-1-full-stack-developer.md` — used as a blueprint for the design pattern (Promise.allSettled sub-data load, `eks-scroll` scrollbar, `bg-[var(--brand)]` accent tokens, `useToast`, loading skeletons, graceful degradation).
- `/home/z/my-project/src/components/dashboard/technician-dashboard.tsx` + `participant-dashboard.tsx` — copied the StatCard / ListSkeleton / EmptyState primitives, the `readJson<T>` generic helper, and the `max-h-* overflow-y-auto eks-scroll` long-list pattern.
- `/home/z/my-project/src/app/dashboard/page.tsx` — confirmed the local `DashboardData` interface for the developer role: `data.developer.profiles[]` (id, name, email, verified, metrics: { programsCount, publishedCount, totalInstalls, avgRating }) and `data.marketplace.stats` (total, published, totalInstalls, activeInstalls). Confirmed that `case "developer": return <DeveloperDashboard data={data} />` does not yet pass `onRefresh` — left untouched per the build-tech-1 convention.
- All 10 developer / programs / marketplace API routes under `src/app/api/programs/{list,[id],[id]/transition,[id]/certify,certification,sdk/scaffold,capabilities}`, `src/app/api/developer/{api-explorer,samples,simulator}`, `src/app/api/marketplace/listings` — to learn the exact request/response shapes (all wrapped as `{ ok, data, meta }` via `withPlatform`).
- `src/lib/platform-server.ts` — confirmed `withPlatform` wraps all responses as `{ ok, data, meta }` and errors as `{ ok: false, error: { code, message, ... } }` with semantic HTTP status codes.
- `src/programs/core/index.ts` — confirmed the `ProgramState` union (16 states from "draft" → "uninstalled") so `StateBadge` color-mapping is exhaustive.
- `/home/z/my-project/src/app/api/programs/sdk/scaffold/route.ts` — discovered the POST endpoint requires `template`, `slug`, AND `name` (not just `template` + `name` as the task brief suggested). The component auto-derives a slug from the project name and sends all three.

## What I built

A single self-contained `"use client"` component `DeveloperDashboard({ data, onRefresh })` plus several internal sub-components. All API calls are real `fetch()` calls; no mocks or hardcoded data.

### Layout (top → bottom)
1. **Top stat row (4 cards) + Refresh action**: Programs (`primaryProfile.metrics.programsCount` with fallback to live programs list length), Published (metrics.publishedCount with fallback to live `state === "published"` count), Total Installs (metrics.totalInstalls with fallback to `mpStats.totalInstalls`), Marketplace (`mpStats.total` with fallback to listings.length, accent-styled). Refresh button triggers both `onRefresh()` and reloads sub-data.
2. **Profile + Marketplace Performance grid (2 cols on lg)**:
   - `DeveloperProfileCard` — name, email (mono), id (mono, truncated), verified badge (ShieldCheck icon, emerald). 2×2 metric grid: Programs / Published / Total Installs / Avg Rating.
   - `MarketplacePerformanceCard` — fetches `/api/marketplace/listings`, shows aggregate Total/Active Installs tiles, then top-6 listings by install count with an inline bar chart (`width: %` of max installs) + rating badge + developer name + version. Footer link to `/marketplace`.
3. **`MyProgramsCard` (full width)** — fetches `/api/programs/list`, sorts by `createdAt` desc. Each row shows kind, category, version count, rating, slug (mono), and a state badge (color-coded: published/certified/active = default, draft/in_review/etc = secondary, rejected/disabled/archived = destructive). Per-row actions:
   - **Publish** button — only rendered when `state === "draft"` — POSTs to `/api/programs/[id]/transition` with `{ to: "published" }`. Optimistically updates the local state on success; calls `onRefresh()` to re-pull dashboard aggregates.
   - **Certify** button — always rendered (works on any state since the server route handles `in_review` transition internally) — POSTs to `/api/programs/[id]/certify`. On success opens `CertifyResultDialog` with pass/fail/warn tiles + per-rule checks list.
   - **View Details** link — `<Link href="/programs/[slug]">` using the program slug (not id), opens the existing program detail page.
4. **SDK Scaffold + API Explorer grid (2 cols on lg)**:
   - `SdkScaffoldCard` — fetches `/api/programs/sdk/scaffold` GET for templates. Form: template Select, project name Input, auto-derived slug (read-only, slugified from name). Submit POSTs `{ template, slug, name }`. On success opens `ScaffoldResultDialog` with the generated file tree (path + 200-char content preview).
   - `ApiExplorerCard` — fetches `/api/developer/api-explorer`. Lists endpoints with a color-coded HTTP method badge (GET=emerald, POST=blue, PUT/PATCH=amber, DELETE=rose) + monospace path + auth-required ShieldCheck icon.
5. **Simulator + Samples grid (2 cols on lg)**:
   - `SimulatorCard` — fetches `/api/developer/simulator` GET. Lists scenarios with entity/event counts. Per-row **Run** button POSTs `{ scenarioId }` to `/api/developer/simulator`. On success opens `SimulationResultDialog` with events-fired / duration / error-count tiles + collapsible state-snapshot JSON.
   - `SamplesCard` — bonus read-only card. Fetches `/api/developer/samples`. Lists sample programs with difficulty badge (beginner/intermediate/advanced color-coded), category, estimated setup minutes, up to 4 feature badges.

### Result dialogs (3)
- `CertifyResultDialog` — 3-tile summary (Passed/Failed/Warned, color-coded) + scrollable per-rule check list with result icons (CheckCircle2 / XCircle / AlertTriangle) and category badge.
- `ScaffoldResultDialog` — file count + scrollable file list (path in mono, 200-char content preview).
- `SimulationResultDialog` — 3-tile summary (Events Fired / Duration / Errors) + collapsible state-snapshot JSON in a `<details>` element.

### Production-quality touches
- **Loading skeletons** (`ListSkeleton`) for every async card; `StatCard` shows an animated pulse placeholder while sub-data loads.
- **Empty states** with muted icon + actionable message for zero-data cards (e.g., "Scaffold one from the SDK card to get started.").
- **Graceful degradation**: `Promise.allSettled` so a single failing endpoint doesn't break the whole dashboard; partial-failure banner shows above the grid.
- **Error handling**: every `fetch` is wrapped in try/catch with `toast({ variant: "destructive" })`. Server `ok: false` responses surface the server's error message.
- **Optimistic updates**: Publish action updates the local program state immediately on success before re-fetching.
- **Custom scrollbar**: `eks-scroll` class (matches technician/participant dashboards).
- **Custom scroll containers**: `max-h-[28rem] overflow-y-auto` on all long lists (28rem ≈ 448px to fit the wider developer cards).
- **Responsive**: stats grid is `grid-cols-2 lg:grid-cols-4`; main grids are `grid-cols-1 lg:grid-cols-2`; Refresh rail collapses below stats on mobile.
- **Accessibility**: every interactive element is a real `<button>` or `<Link>`; ARIA labels via ShieldCheck `aria-label`; `title` attributes on truncated mono IDs/slugs; semantic HTML (`details`/`summary` for collapsible state snapshot).
- **TypeScript strict**: full interface definitions for every API payload; generic `readJson<T>` helper; no `any`; `ProgramState` union imported structurally.
- **No unused code**: `Activity` icon (used in `MarketplacePerformanceCard`) consolidated into the top lucide-react import block.

## APIs used (all real, all from the spec)
| Endpoint | Method | Used in |
|---|---|---|
| `/api/dashboard` | GET | (provided by parent as `data` prop) |
| `/api/programs/list` | GET | `MyProgramsCard` via `loadSubData` |
| `/api/programs/[id]/transition` | POST | `publishProgram` (Publish button) |
| `/api/programs/[id]/certify` | POST | `certifyProgram` (Certify button) |
| `/api/programs/sdk/scaffold` | GET | `SdkScaffoldCard` template list |
| `/api/programs/sdk/scaffold` | POST | `SdkScaffoldCard.submit` |
| `/api/developer/api-explorer` | GET | `ApiExplorerCard` |
| `/api/developer/simulator` | GET | `SimulatorCard` scenario list |
| `/api/developer/simulator` | POST | `runSimulation` (Run button) |
| `/api/developer/samples` | GET | `SamplesCard` (bonus) |
| `/api/marketplace/listings` | GET | `MarketplacePerformanceCard` |

## Lint
`bun run lint` → **0 errors, 0 warnings** on first pass (no fixes needed).

## Notes for downstream agents
- The component is **not yet wired into `src/app/dashboard/page.tsx`**. That file currently defines a local `DeveloperDashboard({ data })` function inline (lines 311-344) that does not accept `onRefresh`. To use this new component, replace the inline function with `import { DeveloperDashboard } from "@/components/dashboard/developer-dashboard"` and update the call site `case "developer": return <DeveloperDashboard data={data} onRefresh={refreshData} />` — but `refreshData` is not currently threaded through `RoleContent`. A future integration agent should swap the inline Participant/Technician/Developer dashboards for the imported components and thread `onRefresh` through `RoleContent` in one pass (same situation as build-tech-1).
- The SDK scaffold POST endpoint requires `template`, `slug`, AND `name` (not just `template` + `name` as the task brief suggested). The component auto-derives a slug from the project name (lowercase, kebab-case, max 48 chars) and sends all three.
- The Certify button is rendered on all program states (not just draft), because the server-side `/api/programs/[id]/certify` route internally handles the `in_review` transition before running the certification pipeline. This matches the actual API contract.
- The `MarketplacePerformanceCard` shows `stats.totalInstalls` / `stats.activeInstalls` from the dashboard data prop (server-aggregated), with a fallback that computes the same totals client-side from the listings array if the dashboard data is missing.
- The `SamplesCard` is a bonus 8th card (the task brief listed 7). It uses `/api/developer/samples` which was in the available API list but not in the required cards. It's a read-only catalog that complements the SDK Scaffold card.
