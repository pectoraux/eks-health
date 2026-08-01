# Task: build-tech-1 — Health Technician dashboard

**Agent:** full-stack-developer
**Started:** synchronous session
**Target file:** `src/components/dashboard/technician-dashboard.tsx`

## Context I read first
- `/home/z/my-project/worklog.md` (full history — confirmed prior agents built the platform kernel, technician subsystem APIs, DB persistence, and a sibling `participant-dashboard.tsx` with the same prop signature `{ data, onRefresh }`).
- `/home/z/my-project/src/components/dashboard/participant-dashboard.tsx` — used as the design template (stat cards, dialogs, `eks-scroll` custom scrollbar, `bg-[var(--brand)]` accent tokens, `useToast`).
- `/home/z/my-project/src/app/dashboard/page.tsx` — confirmed the local `DashboardData` interface and that the technician role receives `data.technicians.stats` + `data.technicians.list` + `data.measurements.stats` from `/api/dashboard`.
- All technician + health API routes under `src/app/api/technicians/*` and `src/app/api/health/*` to learn the exact response shapes (all wrapped as `{ ok, data }` via `withPlatform`; `/api/health/schemas` returns an array directly under `data`).
- `src/lib/platform-server.ts` (`withPlatform` wrapper) and `src/health/schemas/index.ts` (`MeasurementSchema.allowedUnits`, `defaultUnit`) for type accuracy.

## What I built

A single self-contained `"use client"` component `TechnicianDashboard({ data, onRefresh })` plus several internal sub-components. All API calls are real `fetch()` calls; no mocks or hardcoded data.

### Layout (top → bottom)
1. **Top stat row (4 cards) + action rail**: Total Technicians (`data.technicians.stats.total`), Active Sessions (derived client-side from `/api/technicians/sessions` filtering `in_progress|active|scheduled|open`), Measurements Recorded (`data.measurements.stats.total`), Avg Rating (computed from `data.technicians.list` ratings). Buttons: `Record Measurement` (opens dialog) and `Refresh` (calls `onRefresh()` + reloads sub-data).
2. **Sessions + Appointments grid (2 cols on lg)**:
   - `SessionsCard` — expandable list (`Collapsible` from shadcn/ui). Each row shows participant, technician, program, status badge (color-coded). Expanded view shows session ID, participant/technician/program IDs (mono), scheduled/completed dates, measurement & evidence counts.
   - `AppointmentsCard` — sorted by `scheduledAt`, status badges, and a **Schedule New** button that opens a `Dialog` with a draft form (participant, datetime-local, duration, session type). Since no `POST /api/technicians/appointments` endpoint exists yet, the dialog clearly states this in `DialogDescription` and the submit button just toasts "Saved locally" with an explanation — no fake server call.
3. **Devices + Disputes/Fraud grid (2 cols on lg)**:
   - `DevicesCard` — list with model, manufacturer, type, serial, status badge, trust-level badge, certified badge, firmware version, last calibrated date.
   - `DisputesFraudCard` — split into two subsections: Fraud Alerts (severity color-coded: critical/high = destructive) and Disputes (status color-coded). Shows reason, technician, program, opened/detected dates.
4. **`RecordMeasurementDialog`** — full workflow:
   - On open, fires `Promise.allSettled` against `/api/health/schemas`, `/api/health/sources`, `/api/health/profiles`.
   - Selects: measurement type (schema), unit (synced to schema's `defaultUnit` or first `allowedUnits` entry; falls back to free-text input if no units), source, participant profile (with free-text fallback), value (numeric), tags (comma-separated, default `technician-recorded`).
   - Submits `POST /api/health/measurements` with `{ schemaId, profileId, value: Number(value), unitId, sourceId, collectedBy: "technician", tags: [...] }`.
   - Validates: required fields, numeric value. On success: toast with verification state, reset value, close dialog, call `onRefresh()` + reload sub-data. On failure: destructive toast with server error message.

### Production-quality touches
- **Loading skeletons** (`ListSkeleton`) for every async card; `StatCard` shows an animated pulse placeholder while sub-data loads.
- **Empty states** with muted icon + message for zero-data cards.
- **Graceful degradation**: `Promise.allSettled` so a single failing endpoint doesn't break the whole dashboard; partial-failure banner shows above the grid.
- **Error handling**: every `fetch` is wrapped in try/catch with `toast({ variant: "destructive" })`. Server `ok: false` responses surface the server's error message.
- **Custom scrollbar**: `eks-scroll` class (matches participant-dashboard).
- **Custom scroll containers**: `max-h-96 overflow-y-auto` on all long lists.
- **Responsive**: stats grid is `grid-cols-2 lg:grid-cols-4`; main grids are `grid-cols-1 lg:grid-cols-2`; action rail collapses below stats on mobile.
- **Accessibility**: every interactive element is a real `<button>`; `CollapsibleTrigger asChild` wraps a button; ARIA labels via shadcn primitives; `title` attributes on truncated mono IDs.
- **TypeScript strict**: full interface definitions for every API payload; generic `readJson<T>` helper; no `any`.
- **No unused code**: removed a dead `unpack` helper before linting; removed an unnecessary `eslint-disable` comment after lint flagged it.

## APIs used (all real, all from the spec)
| Endpoint | Method | Used in |
|---|---|---|
| `/api/dashboard` | GET | (provided by parent as `data` prop) |
| `/api/technicians/sessions` | GET | `SessionsCard` via `loadSubData` |
| `/api/technicians/appointments` | GET | `AppointmentsCard` via `loadSubData` |
| `/api/technicians/devices` | GET | `DevicesCard` via `loadSubData` |
| `/api/technicians/disputes` | GET | `DisputesFraudCard` via `loadSubData` |
| `/api/technicians/fraud` | GET | `DisputesFraudCard` via `loadSubData` |
| `/api/health/schemas` | GET | `RecordMeasurementDialog` metadata load |
| `/api/health/sources` | GET | `RecordMeasurementDialog` metadata load |
| `/api/health/profiles` | GET | `RecordMeasurementDialog` metadata load |
| `/api/health/measurements` | POST | `RecordMeasurementDialog.submit` |

## Lint
`bun run lint` → **0 errors, 0 warnings** after removing one stray `eslint-disable-next-line` directive.

## Notes for downstream agents
- The component is **not yet wired into `src/app/dashboard/page.tsx`**. That file currently defines a local `TechnicianDashboard` function inline. To use this new component, replace the inline function with `import { TechnicianDashboard } from "@/components/dashboard/technician-dashboard"` and update the call site `case "health_technician": return <TechnicianDashboard data={data} onRefresh={...} />` (the parent currently passes no `onRefresh` — a `refreshData` callback would need to be threaded through `RoleContent`). Left this for a future integration agent to avoid touching shared page.tsx in this task.
- Same situation exists for the sibling `participant-dashboard.tsx` (exists but unused). A future "wire-up" agent could swap both at once.
- The `ScheduleFormStub` is intentionally a local-only draft: it captures form state and shows a toast explaining the missing POST endpoint, rather than faking a network call. When `/api/technicians/appointments` POST ships, replace `onSubmit` with a real fetch and call `onRefresh` after.
