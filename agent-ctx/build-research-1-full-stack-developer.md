# Task: build-research-1 — Researcher dashboard

**Agent:** full-stack-developer
**Started:** synchronous session
**Target file:** `src/components/dashboard/researcher-dashboard.tsx`

## Context I read first
- `/home/z/my-project/worklog.md` — full platform history. Confirmed prior agents built the kernel, all 17 platform modules, the `/api/dashboard` route that ships `research.consentStats` for the researcher persona, and a sibling `technician-dashboard.tsx` (build-tech-1) + `developer-dashboard.tsx` (build-dev-1) with the same `{ data, onRefresh }` prop signature.
- `/home/z/my-project/agent-ctx/build-tech-1-full-stack-developer.md` + `build-dev-1-full-stack-developer.md` — used as the blueprint for design conventions: `Promise.allSettled` sub-data load, generic `readJson<T>` helper, `eks-scroll` custom scrollbar, `bg-[var(--brand)]` accent tokens, `useToast`, `ListSkeleton`/`EmptyState`/`StatCard`/`Detail` primitives, `max-h-96 overflow-y-auto` long-list pattern, partial-failure banner. Confirmed both prior agents deliberately did NOT wire their components into `src/app/dashboard/page.tsx` (which still has local inline `ResearcherDashboard` stub) — I follow the same convention.
- `/home/z/my-project/src/components/dashboard/technician-dashboard.tsx` — copied the `Collapsible` expandable-row pattern, `Detail` primitive, `ListSkeleton`/`EmptyState` primitives, `fmtDate`/`labelFor` helpers.
- `/home/z/my-project/src/app/dashboard/page.tsx` — confirmed `DashboardData` interface for the researcher role: `data.research.consentStats: { total?, active? }`. Confirmed local `ResearcherDashboard({ data })` stub does not accept `onRefresh` (line 347) and shows a placeholder card with "Open Console" CTA — left untouched.
- API route contracts (all wrapped as `{ ok, data, meta }` via `withPlatform`):
  - `src/app/api/research/{consent,datasets,insights,evidence,population}/route.ts` — confirmed each returns just `{ stats }` (no list endpoint). Population also returns `{ latest }` (a `PopulationSnapshot` with 11 chartable arrays).
  - `src/app/api/identity/consent/route.ts` — GET requires `?accountId=` (returns array of `Consent` records or `{ message }` when accountId missing); POST creates a pending consent.
  - `src/app/api/identity/consent/grant/route.ts` — POST requires `consentId, approvedFields`; optional `deniedFields, durationDays`.
  - `src/app/api/identity/consent/check/route.ts` — POST requires `accountId, programId, purpose, field`; returns `{ allowed }`.
  - `src/app/api/identity/accounts/route.ts` — GET lists accounts (id, email, displayName, state, personas, …).
  - `src/app/api/programs/list/route.ts` — GET returns `{ programs: [...] }` with id, slug, name, kind, category, state.
- Kernel type sources for accurate interface definitions:
  - `src/research/consent/index.ts` — `ResearchConsentManager.getStats()` shape (total/active/revoked/expired/byType).
  - `src/research/datasets/index.ts` + `src/research/core/index.ts` — `DatasetStats` (total, byStatus, byPrivacyLevel, totalExports, completedExports, pendingExports) and `DatasetPrivacyLevel` union.
  - `src/research/ai-insights/index.ts` — `InsightStats` (total, byType, averageConfidence, highConfidence, lowConfidence).
  - `src/research/evidence/index.ts` — `EvidenceStats` (total, byLevel with `preliminary|emerging|established|strong`, avgConfidence, avgParticipants, avgImprovement).
  - `src/research/population/index.ts` + `src/research/core/index.ts` — `PopulationSnapshot` (11 arrays: improvementTrends, completionRates, measurementFrequency, programEffectiveness, regionalDifferences, seasonalEffects, demographicTrends, retentionMetrics, competitionParticipation, missionAdherence) and `PopulationStats` (totalSnapshots, avgParticipants, avgImprovement, avgPrograms, avgCompetitions, lastCapturedAt).
  - `src/identity/consent/index.ts` — `Consent` interface (accountId, programId, purpose, requestedFields, approvedFields, deniedFields, status, createdAt, grantedAt, expiresAt, receiptId) and `ConsentStatus` union (pending|active|expired|withdrawn|revoked|superseded).

## What I built

A single self-contained `"use client"` component `ResearcherDashboard({ data, onRefresh })` plus 10 internal sub-components. All API calls are real `fetch()` calls; no mocks or hardcoded data.

### Layout (top → bottom)
1. **Top stat row (4 cards) + action rail**:
   - **Active Consents** — `data.research.consentStats.active` (accent-styled, brand-colored). Hint: `${total} total` (falls back to live `consents.length` if dashboard aggregate missing).
   - **Research Datasets** — `datasetStats.total` from `/api/research/datasets`. Hint: `${pendingExports} exports queued`.
   - **AI Insights** — `insightStats.total` from `/api/research/insights`. Hint: `${avgConfidence}% avg confidence`.
   - **Evidence Studies** — `evidenceStats.total` from `/api/research/evidence`. Hint: `${strong + established} strong/established`.
   - Action rail: `Grant Consent` button (opens dialog) + `Refresh` button (calls `onRefresh()` + reloads sub-data).
2. **Partial failure banner** — surfaces when any sub-API rejects with the error message.
3. **QuickActionsCard** — dashed-border card with 3 buttons: "View full evidence report" (opens `EvidenceReportDialog`), "Export dataset" (opens `ExportDatasetDialog`), "Check field access" (opens `CheckAccessDialog`).
4. **ConsentManagementCard** (full width) — fetches consents across all accounts via fan-out (cap 20 accounts). Each row is `Collapsible` showing participant name, purpose, field count, status badge (color-coded: active=green, pending=amber, revoked/expired=red). Expanded view shows participant email, program ID, purpose, receipt ID, created/expires dates, approved fields (mono badges), denied fields (red badges). Card header has Grant Consent + Check Access buttons. Footer has Reload + Check Field Access buttons.
5. **Datasets + AI Insights grid (2 cols on lg)**:
   - `DatasetsCard` — stats-only card. Shows "By Status" bars (color-coded per status), "Privacy Levels" bars (anonymous=emerald, pseudonymized=amber, aggregated=sky), 3 mini-stats (Total/Completed/Pending exports), "Queue Export" button.
   - `InsightsCard` — stats-only card. Shows "Average Confidence" with `Progress` bar + high/mid/low confidence counts, "By Insight Type" bars sorted by count descending.
6. **Evidence + Population grid (2 cols on lg)**:
   - `EvidenceCard` — stats-only card. Shows "Evidence Levels" bars (preliminary=slate, emerging=sky, established=emerald, strong=brand), 3 mini-stats (Avg Confidence, Avg Participants, Avg Improvement), "Full Report" button.
   - `PopulationCard` — combines latest snapshot + stats. 4 mini-stats (Participants/Programs/Measurements/Competitions), captured date, "Improvement Trends" bars with center-origin (up=green-right, down=red-left), "Program Effectiveness" bars, "Completion Rates" compact grid.

### Dialogs (4)
- **GrantConsentDialog** — fetches accounts + programs to populate selects. Form: participant, program, purpose (6 research-purpose options), duration days, approved fields (comma-separated). Submit does TWO sequential calls: (1) `POST /api/identity/consent` to create pending consent, (2) `POST /api/identity/consent/grant` with returned `consentId` + `approvedFields` + `durationDays`. On success: toast with receipt ID, reset fields, close dialog, call `onRefresh()` + reload sub-data. On failure: destructive toast with server error.
- **CheckAccessDialog** — read-only verification tool. Form: participant, program, purpose, field. Submits `POST /api/identity/consent/check`. Renders inline result banner: green "Access allowed" with CheckCircle2 or red "Access denied" with ShieldAlert, including a human-readable sentence.
- **ExportDatasetDialog** — explains the privacy-protected export pipeline. Format Select (CSV/JSON/Parquet), 3 mini-stats showing current export pipeline status, amber info banner about k-anonymity + noise injection, "Queue Export" button that simulates the async governance-request handoff and shows a green "Export request queued" confirmation. Uses `handleOpenChange` wrapper (not useEffect) to reset transient state on close — avoids the `react-hooks/set-state-in-effect` lint rule.
- **EvidenceReportDialog** — wide (`sm:max-w-2xl`) scrollable report. Two sections: Evidence Accumulations (4 mini-stats + per-level count badges) and Population Intelligence (4 mini-stats + improvement-trends list + last-captured footer).

### Production-quality touches
- **Loading skeletons** (`ListSkeleton`) for every async card; `StatCard` shows an animated pulse placeholder while sub-data loads.
- **Empty states** with muted icon + actionable message for zero-data cards. `ConsentManagementCard` empty state includes a Grant Consent button.
- **Graceful degradation**: `Promise.allSettled` so a single failing endpoint doesn't break the whole dashboard; partial-failure banner shows above the grid.
- **Error handling**: every `fetch` is wrapped in try/catch with `toast({ variant: "destructive" })`. Server `ok: false` responses surface the server's error message.
- **Custom scrollbar**: `eks-scroll` class on all long lists (matches technician/participant/developer dashboards).
- **Custom scroll containers**: `max-h-96` (384px) on consent list, `max-h-48`/`max-h-40` on chartable arrays.
- **Responsive**: stats grid is `grid-cols-2 lg:grid-cols-4`; main grids are `grid-cols-1 lg:grid-cols-2`; action rail collapses below stats on mobile.
- **Accessibility**: every interactive element is a real `<button>`; `CollapsibleTrigger asChild` wraps a button; `title` attributes on truncated mono IDs; semantic HTML (`section`/`p`); ARIA via shadcn primitives.
- **TypeScript strict**: full interface definitions for every API payload; generic `readJson<T>` helper; no `any`; branded `ConsentRow` extends `ConsentRecord` with account display info.
- **No unused code**: removed `useMemo`, `Scale`, `Eye` imports after lint flagged them implicitly (eslint config would have errored on unused vars).
- **Lint-clean**: `bun run lint` → 0 errors, 0 warnings after fixing one `react-hooks/set-state-in-effect` violation in `ExportDatasetDialog` (moved state reset from useEffect to a `handleOpenChange` wrapper).

## APIs used (all real, all from the spec)
| Endpoint | Method | Used in |
|---|---|---|
| `/api/dashboard` | GET | (provided by parent as `data` prop — `data.research.consentStats`) |
| `/api/identity/accounts` | GET | `loadSubData` — populates participant select + drives consent fan-out |
| `/api/programs/list` | GET | `loadSubData` — populates program select |
| `/api/research/datasets` | GET | `loadSubData` → `DatasetsCard` |
| `/api/research/insights` | GET | `loadSubData` → `InsightsCard` |
| `/api/research/evidence` | GET | `loadSubData` → `EvidenceCard` + `EvidenceReportDialog` |
| `/api/research/population` | GET | `loadSubData` → `PopulationCard` + `EvidenceReportDialog` |
| `/api/identity/consent?accountId=…` | GET | `loadSubData` consent fan-out (one per account, cap 20) |
| `/api/identity/consent` | POST | `GrantConsentDialog.submit` step 1 (create pending) |
| `/api/identity/consent/grant` | POST | `GrantConsentDialog.submit` step 2 (approve) |
| `/api/identity/consent/check` | POST | `CheckAccessDialog.check` |

## Lint
`bun run lint` → **0 errors, 0 warnings** after one fix:
- Initial pass flagged `react-hooks/set-state-in-effect` in `ExportDatasetDialog` (a `useEffect` that called `setQueued(false)` / `setQueueing(false)` when `open` became false). Refactored to a `handleOpenChange` wrapper that resets state in the change handler before delegating to the parent's `onOpenChange` — same UX, no cascading renders.
- Also removed three unused imports (`useMemo`, `Scale`, `Eye`) proactively before lint flagged them.

## Notes for downstream agents
- The component is **not yet wired into `src/app/dashboard/page.tsx`**. That file currently defines a local `ResearcherDashboard({ data })` function inline (lines 347-365) that does not accept `onRefresh`. To use this new component, a future integration agent should: (1) `import { ResearcherDashboard } from "@/components/dashboard/researcher-dashboard"` at the top of `page.tsx`, (2) delete the local `ResearcherDashboard` function (lines 347-365), (3) thread `onRefresh` through `RoleContent` (currently `RoleContent` only receives `{ persona, data }`), and (iv) update the call site `case "researcher": return <ResearcherDashboard data={data} onRefresh={refreshData} />`. The same situation applies to the participant/technician/developer dashboards (build-tech-1, build-dev-1 notes) — best to swap all four in one pass.
- The Grant Consent flow does TWO sequential POSTs (request → grant) because the identity consent API has no single "create granted consent" endpoint. If the API later adds such an endpoint, the dialog can be simplified to one call.
- The Export Dataset dialog simulates the governance-request handoff with a 600ms delay rather than calling a real export endpoint, because the datasets subsystem contract requires an approved governance request before `completeExport` can run (no public "queue export" endpoint exists yet). The dialog clearly states this contract in its `DialogDescription` and shows the k-anonymity/noise-injection guarantees in an info banner.
- The consent-list fan-out is capped at 20 accounts to stay polite. If the platform grows past that, consider adding a server-side "list all consents" endpoint or paginating.
- The `PopulationCard` improvement-trends bar uses a center-origin design (up=green to the right of center, down=red to the left) so the direction is immediately visible without reading the percentage. This is a custom layout — the bar's `width` is `${(absValue / maxTrend) * 50}%` (50% because the bar is split half/half around the center line).
