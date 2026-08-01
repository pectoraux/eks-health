"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users, Activity, Stethoscope, Star, Calendar, Cpu, ShieldAlert,
  AlertTriangle, Plus, ChevronRight, ChevronDown, RefreshCw, Circle,
  CalendarClock, ClipboardList, ShieldCheck, Timer, FileWarning,
  Scale, TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types — mirror the shapes returned by /api/dashboard (health_technician) and
// the technician / health sub-APIs. Keeping them loose (optional fields) lets
// the dashboard degrade gracefully when the platform hasn't seeded data yet.
// ---------------------------------------------------------------------------

interface TechnicianSummary {
  id: string;
  displayName: string;
  category?: string;
  rating?: number;
  totalSessions?: number;
  verifiedSessions?: number;
  disputedSessions?: number;
  status?: string;
  reviewCount?: number;
}

interface MeasurementSession {
  id: string;
  participantId: string;
  technicianId: string;
  programId: string;
  status: string;
  scheduledAt: string;
  measurementCount: number;
  evidenceCount: number;
  completedAt?: string;
}

interface Appointment {
  id: string;
  participantId: string;
  technicianId: string;
  programId: string;
  status: string;
  scheduledAt: string;
  durationMinutes?: number;
  sessionType?: string;
}

interface DeviceRecord {
  id: string;
  serialNumber: string;
  model: string;
  manufacturer?: string;
  type: string;
  trustLevel: string;
  status: string;
  certified?: boolean;
  firmwareVersion?: string;
  lastCalibratedAt?: string;
}

interface DisputeRecord {
  id: string;
  status: string;
  reason: string;
  openedAt: string;
  technicianId: string;
  programId?: string;
}

interface FraudAlert {
  id: string;
  type: string;
  severity: string;
  status: string;
  detectedAt: string;
  technicianId: string;
}

interface HealthSchema {
  id: string;
  slug: string;
  name: string;
  category?: string;
  valueType: string;
  allowedUnits?: string[];
  defaultUnit?: string;
}

interface HealthSource {
  id: string;
  type: string;
  label: string;
  trustLevel?: string;
  verified?: boolean;
}

interface HealthProfile {
  id: string;
  accountId?: string;
  programCount?: number;
  deviceCount?: number;
  createdAt?: string;
}

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  technicians?: {
    stats: { total?: number; active?: number };
    list: TechnicianSummary[];
  };
  measurements?: {
    stats: { total?: number };
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TechnicianDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  const techs = data.technicians;
  const measurements = data.measurements;

  // Sub-API state (loaded client-side; dashboard route only ships aggregate stats)
  const [sessions, setSessions] = useState<MeasurementSession[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [disputes, setDisputes] = useState<DisputeRecord[]>([]);
  const [fraudAlerts, setFraudAlerts] = useState<FraudAlert[]>([]);
  const [loadingSub, setLoadingSub] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);

  // Record-measurement dialog state
  const [recordOpen, setRecordOpen] = useState(false);

  const loadSubData = useCallback(async () => {
    setLoadingSub(true);
    setSubError(null);
    try {
      const [sessRes, apptRes, devRes, dispRes, fraudRes] = await Promise.allSettled([
        fetch("/api/technicians/sessions", { cache: "no-store" }),
        fetch("/api/technicians/appointments", { cache: "no-store" }),
        fetch("/api/technicians/devices", { cache: "no-store" }),
        fetch("/api/technicians/disputes", { cache: "no-store" }),
        fetch("/api/technicians/fraud", { cache: "no-store" }),
      ]);

      // Promise.allSettled wraps the fetch promises; the json() reads happen below.
      const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T, label: string): Promise<T> => {
        if (r.status !== "fulfilled") {
          console.warn(`[technician-dashboard] ${label} request rejected`);
          return fallback;
        }
        try {
          const j = (await r.value.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
          if (!j?.ok) {
            console.warn(`[technician-dashboard] ${label} returned ok=false`, j?.error?.message);
            return fallback;
          }
          return (j.data as T) ?? fallback;
        } catch {
          return fallback;
        }
      };

      const [sess, appt, dev, disp, fraud] = await Promise.all([
        readJson<{ sessions: MeasurementSession[] } | MeasurementSession[]>(sessRes, { sessions: [] }, "sessions"),
        readJson<{ appointments: Appointment[] } | Appointment[]>(apptRes, { appointments: [] }, "appointments"),
        readJson<{ devices: DeviceRecord[] } | DeviceRecord[]>(devRes, { devices: [] }, "devices"),
        readJson<{ disputes: DisputeRecord[] } | DisputeRecord[]>(dispRes, { disputes: [] }, "disputes"),
        readJson<{ alerts: FraudAlert[] } | FraudAlert[]>(fraudRes, { alerts: [] }, "fraud"),
      ]);

      setSessions(Array.isArray(sess) ? sess : sess.sessions ?? []);
      setAppointments(Array.isArray(appt) ? appt : appt.appointments ?? []);
      setDevices(Array.isArray(dev) ? dev : dev.devices ?? []);
      setDisputes(Array.isArray(disp) ? disp : disp.disputes ?? []);
      setFraudAlerts(Array.isArray(fraud) ? fraud : fraud.alerts ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load technician data";
      setSubError(msg);
      toast({ title: "Load failed", description: msg, variant: "destructive" });
    } finally {
      setLoadingSub(false);
    }
  }, []);

  useEffect(() => {
    void loadSubData();
  }, [loadSubData]);

  // Derived stats ---------------------------------------------------------
  const avgRating = useMemo(() => {
    const rated = techs?.list?.filter((t) => typeof t.rating === "number") ?? [];
    if (rated.length === 0) return 0;
    return rated.reduce((s, t) => s + (t.rating ?? 0), 0) / rated.length;
  }, [techs]);

  const activeSessions = useMemo(() => {
    const activeStates = new Set(["in_progress", "active", "scheduled", "open"]);
    return sessions.filter((s) => activeStates.has(s.status?.toLowerCase())).length;
  }, [sessions]);

  const handleRecorded = useCallback(() => {
    setRecordOpen(false);
    onRefresh();
    // Sessions list may reference the new measurement; refresh sub-data too.
    void loadSubData();
  }, [onRefresh, loadSubData]);

  const handleManualRefresh = useCallback(() => {
    onRefresh();
    void loadSubData();
  }, [onRefresh, loadSubData]);

  return (
    <div className="space-y-6">
      {/* Top stat row + primary action */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
          <StatCard
            icon={<Users className="h-4 w-4" />}
            label="Total Technicians"
            value={techs?.stats.total ?? 0}
            hint={`${techs?.stats.active ?? 0} active`}
          />
          <StatCard
            icon={<Stethoscope className="h-4 w-4" />}
            label="Active Sessions"
            value={activeSessions}
            hint={`${sessions.length} total`}
            loading={loadingSub}
          />
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label="Measurements Recorded"
            value={measurements?.stats.total ?? 0}
            hint="all profiles"
          />
          <StatCard
            icon={<Star className="h-4 w-4" />}
            label="Avg Rating"
            value={avgRating > 0 ? avgRating.toFixed(2) : "—"}
            hint={`${techs?.list?.filter((t) => typeof t.rating === "number").length ?? 0} rated`}
          />
        </div>
        <div className="flex sm:flex-col gap-2 sm:justify-end">
          <Button
            onClick={() => setRecordOpen(true)}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90 h-9"
          >
            <Plus className="h-4 w-4 mr-1" /> Record Measurement
          </Button>
          <Button variant="outline" onClick={handleManualRefresh} className="h-9" disabled={loadingSub}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loadingSub ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {subError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          Could not load some technician data: {subError}. Showing partial view.
        </div>
      )}

      {/* Sessions + Appointments row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SessionsCard sessions={sessions} loading={loadingSub} onRefresh={handleManualRefresh} />
        <AppointmentsCard appointments={appointments} loading={loadingSub} onRefresh={handleManualRefresh} />
      </div>

      {/* Devices + Disputes/Fraud row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DevicesCard devices={devices} loading={loadingSub} />
        <DisputesFraudCard disputes={disputes} fraudAlerts={fraudAlerts} loading={loadingSub} />
      </div>

      {/* Record-measurement dialog */}
      <RecordMeasurementDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        onRecorded={handleRecorded}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions — expandable list with state badges
// ---------------------------------------------------------------------------

function SessionsCard({
  sessions,
  loading,
  onRefresh,
}: {
  sessions: MeasurementSession[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const stateVariant = (state: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = state?.toLowerCase();
    if (s === "completed" || s === "verified") return "default";
    if (s === "in_progress" || s === "active" || s === "scheduled" || s === "open") return "secondary";
    if (s === "disputed" || s === "cancelled" || s === "failed") return "destructive";
    return "outline";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Measurement Sessions
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{sessions.length} sessions</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-8 w-8" />}
            message="No measurement sessions recorded yet."
          />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto eks-scroll pr-1">
            {sessions.slice(0, 50).map((s) => {
              const isOpen = expanded === s.id;
              return (
                <Collapsible key={s.id} open={isOpen} onOpenChange={(o) => setExpanded(o ? s.id : null)}>
                  <div className="rounded-lg border border-border/60 overflow-hidden">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-accent/40 transition-colors"
                      >
                        <Circle
                          className={`h-2.5 w-2.5 shrink-0 ${
                            s.status === "completed" ? "fill-emerald-500 text-emerald-500"
                            : s.status === "disputed" || s.status === "failed" ? "fill-destructive text-destructive"
                            : "fill-amber-500 text-amber-500"
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {labelFor(s.participantId)}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            Tech: {labelFor(s.technicianId)} · {labelFor(s.programId)}
                          </p>
                        </div>
                        <Badge variant={stateVariant(s.status)} className="text-[10px] capitalize">
                          {s.status}
                        </Badge>
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t border-border/60 bg-muted/30 p-3 grid grid-cols-2 gap-3 text-xs">
                        <Detail label="Session ID" value={s.id} mono />
                        <Detail label="Participant" value={s.participantId} mono />
                        <Detail label="Technician" value={s.technicianId} mono />
                        <Detail label="Program" value={s.programId} mono />
                        <Detail
                          label="Scheduled"
                          value={fmtDate(s.scheduledAt)}
                        />
                        <Detail
                          label="Completed"
                          value={s.completedAt ? fmtDate(s.completedAt) : "—"}
                        />
                        <Detail
                          label="Measurements"
                          value={String(s.measurementCount)}
                          icon={<Activity className="h-3 w-3" />}
                        />
                        <Detail
                          label="Evidence"
                          value={String(s.evidenceCount)}
                          icon={<ShieldCheck className="h-3 w-3" />}
                        />
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })}
          </div>
        )}
        {sessions.length > 0 && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onRefresh}>
              <RefreshCw className="h-3 w-3 mr-1" /> Reload
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Appointments — list + "Schedule New" informational dialog
// ---------------------------------------------------------------------------

function AppointmentsCard({
  appointments,
  loading,
  onRefresh,
}: {
  appointments: Appointment[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const statusVariant = (state: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = state?.toLowerCase();
    if (s === "confirmed" || s === "scheduled" || s === "completed") return "default";
    if (s === "pending" || s === "in_progress") return "secondary";
    if (s === "cancelled" || s === "no_show") return "destructive";
    return "outline";
  };

  const sorted = useMemo(() => {
    return [...appointments].sort((a, b) => {
      const ta = new Date(a.scheduledAt).getTime();
      const tb = new Date(b.scheduledAt).getTime();
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    });
  }, [appointments]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          Appointments
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">{appointments.length} total</Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setScheduleOpen(true)}
          >
            <Plus className="h-3 w-3 mr-1" /> Schedule New
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Calendar className="h-8 w-8" />}
            message="No appointments on the calendar."
          />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto eks-scroll pr-1">
            {sorted.slice(0, 50).map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 p-3"
              >
                <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {labelFor(a.participantId)}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {fmtDate(a.scheduledAt)}
                    {a.durationMinutes ? ` · ${a.durationMinutes}m` : ""}
                    {a.sessionType ? ` · ${a.sessionType}` : ""}
                  </p>
                </div>
                <Badge variant={statusVariant(a.status)} className="text-[10px] capitalize">
                  {a.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule New Appointment</DialogTitle>
            <DialogDescription>
              Capture basic appointment details. Full scheduling will be wired to the
              technician appointments API once write endpoints ship.
            </DialogDescription>
          </DialogHeader>
          <ScheduleForm
            onSubmit={async (data) => {
              try {
                const res = await fetch("/api/technicians/appointments", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(data),
                });
                const j = await res.json();
                if (j.ok) {
                  toast({ title: "Appointment scheduled", description: `Appointment ID: ${j.data.id}` });
                  setScheduleOpen(false);
                  onRefresh();
                } else {
                  toast({ title: "Failed", description: j.error?.message ?? "Could not schedule", variant: "destructive" });
                }
              } catch {
                toast({ title: "Error", description: "Network error", variant: "destructive" });
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ScheduleForm({ onSubmit }: { onSubmit: (data: {
  technicianId: string;
  participantId: string;
  programId: string;
  sessionType: string;
  scheduledAt: string;
  durationMinutes?: number;
  notes?: string[];
}) => void }) {
  const [participant, setParticipant] = useState("");
  const [date, setDate] = useState("");
  const [duration, setDuration] = useState("30");
  const [type, setType] = useState("in_clinic");

  const handleSubmit = () => {
    // Convert datetime-local to ISO
    const iso = date ? new Date(date).toISOString() : new Date().toISOString();
    onSubmit({
      technicianId: "tech_demo_1", // will be overridden by server if needed
      participantId: participant || "acc_demo_1",
      programId: "prg_cardio_care",
      sessionType: type,
      scheduledAt: iso,
      durationMinutes: parseInt(duration, 10) || 30,
    });
  };

  return (
    <div className="space-y-3 py-2">
      <div className="space-y-1.5">
        <Label htmlFor="appt-participant">Participant ID</Label>
        <Input
          id="appt-participant"
          value={participant}
          onChange={(e) => setParticipant(e.target.value)}
          placeholder="acc_demo_1"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="appt-date">Scheduled At</Label>
          <Input
            id="appt-date"
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="appt-duration">Duration (min)</Label>
          <Input
            id="appt-duration"
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Session Type</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="in_clinic">In-clinic</SelectItem>
            <SelectItem value="home_visit">Home visit</SelectItem>
            <SelectItem value="telehealth">Telehealth</SelectItem>
            <SelectItem value="field">Field session</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DialogFooter>
        <Button onClick={handleSubmit}>Schedule</Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function DevicesCard({
  devices,
  loading,
}: {
  devices: DeviceRecord[];
  loading: boolean;
}) {
  const statusVariant = (state: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = state?.toLowerCase();
    if (s === "active" || s === "online" || s === "ready") return "default";
    if (s === "calibrating" || s === "standby") return "secondary";
    if (s === "offline" || s === "retired" || s === "faulty") return "destructive";
    return "outline";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          Device Registry
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{devices.length} devices</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : devices.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-8 w-8" />}
            message="No devices registered."
          />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto eks-scroll pr-1">
            {devices.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
                    <Cpu className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{d.model}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {d.manufacturer ? `${d.manufacturer} · ` : ""}{d.type} · SN {d.serialNumber}
                    </p>
                  </div>
                  <Badge variant={statusVariant(d.status)} className="text-[10px] capitalize">
                    {d.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <Badge variant="outline" className="text-[9px] capitalize">
                    <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
                    {d.trustLevel}
                  </Badge>
                  {d.certified && (
                    <Badge variant="outline" className="text-[9px] text-emerald-600 border-emerald-600/30">
                      Certified
                    </Badge>
                  )}
                  {d.firmwareVersion && (
                    <span className="text-[10px] text-muted-foreground">fw {d.firmwareVersion}</span>
                  )}
                  {d.lastCalibratedAt && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      Calibrated {fmtDate(d.lastCalibratedAt, true)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Disputes + Fraud alerts
// ---------------------------------------------------------------------------

function DisputesFraudCard({
  disputes,
  fraudAlerts,
  loading,
}: {
  disputes: DisputeRecord[];
  fraudAlerts: FraudAlert[];
  loading: boolean;
}) {
  const severityVariant = (sev: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = sev?.toLowerCase();
    if (s === "critical" || s === "high") return "destructive";
    if (s === "medium") return "secondary";
    if (s === "low") return "outline";
    return "default";
  };

  const disputeVariant = (state: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = state?.toLowerCase();
    if (s === "resolved" || s === "closed") return "default";
    if (s === "open" || s === "investigating") return "destructive";
    if (s === "withdrawn") return "outline";
    return "secondary";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Disputes &amp; Fraud
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">{disputes.length} disputes</Badge>
          <Badge variant="outline" className="text-[10px]">{fraudAlerts.length} alerts</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : disputes.length === 0 && fraudAlerts.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-8 w-8" />}
            message="No disputes or fraud alerts. All clear."
          />
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto eks-scroll pr-1">
            {fraudAlerts.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Fraud Alerts
                </p>
                {fraudAlerts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5"
                  >
                    <FileWarning className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium capitalize">{a.type.replace(/_/g, " ")}</span>
                        <Badge variant={severityVariant(a.severity)} className="text-[9px] capitalize">
                          {a.severity}
                        </Badge>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Tech: {labelFor(a.technicianId)} · Detected {fmtDate(a.detectedAt, true)}
                      </p>
                    </div>
                    <Badge variant={a.status === "resolved" || a.status === "dismissed" ? "outline" : "secondary"} className="text-[9px] capitalize">
                      {a.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            {disputes.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
                  <Scale className="h-3 w-3" /> Disputes
                </p>
                {disputes.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-start gap-2 rounded-md border border-border/60 p-2.5"
                  >
                    <Scale className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{d.reason}</p>
                      <p className="text-[10px] text-muted-foreground">
                        Tech: {labelFor(d.technicianId)}
                        {d.programId ? ` · ${labelFor(d.programId)}` : ""}
                        {" · "}Opened {fmtDate(d.openedAt, true)}
                      </p>
                    </div>
                    <Badge variant={disputeVariant(d.status)} className="text-[9px] capitalize">
                      {d.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Record Measurement dialog — fetches schemas + sources + profiles, POSTs
// ---------------------------------------------------------------------------

function RecordMeasurementDialog({
  open,
  onOpenChange,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRecorded: () => void;
}) {
  const [schemas, setSchemas] = useState<HealthSchema[]>([]);
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [profiles, setProfiles] = useState<HealthProfile[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [schemaId, setSchemaId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [value, setValue] = useState("");
  const [tags, setTags] = useState("technician-recorded");
  const [submitting, setSubmitting] = useState(false);

  // Load metadata the first time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingMeta(true);
    setMetaError(null);
    (async () => {
      try {
        const [schemaRes, sourceRes, profileRes] = await Promise.allSettled([
          fetch("/api/health/schemas", { cache: "no-store" }),
          fetch("/api/health/sources", { cache: "no-store" }),
          fetch("/api/health/profiles", { cache: "no-store" }),
        ]);

        const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T): Promise<T> => {
          if (r.status !== "fulfilled") return fallback;
          try {
            const j = (await r.value.json()) as { ok?: boolean; data?: T };
            if (!j?.ok) return fallback;
            return (j.data as T) ?? fallback;
          } catch {
            return fallback;
          }
        };

        const schemaData = await readJson<HealthSchema[] | { schemas?: HealthSchema[] }>(schemaRes, []);
        const sourceData = await readJson<{ sources?: HealthSource[] } | HealthSource[]>(sourceRes, { sources: [] });
        const profileData = await readJson<HealthProfile[] | { profiles?: HealthProfile[] }>(profileRes, []);

        const schemasArr = Array.isArray(schemaData) ? schemaData : [];
        const sourcesArr = Array.isArray(sourceData) ? sourceData : sourceData.sources ?? [];
        const profilesArr = Array.isArray(profileData) ? profileData : [];

        if (cancelled) return;
        setSchemas(schemasArr);
        setSources(sourcesArr);
        setProfiles(profilesArr);

        // Defaults — pick first option of each so the form is submittable immediately.
        if (schemasArr[0] && !schemaId) {
          setSchemaId(schemasArr[0].id);
          const u = schemasArr[0].defaultUnit ?? schemasArr[0].allowedUnits?.[0] ?? "";
          if (u) setUnitId(u);
        }
        if (sourcesArr[0] && !sourceId) setSourceId(sourcesArr[0].id);
        if (profilesArr[0] && !profileId) setProfileId(profilesArr[0].id);

        if (schemasArr.length === 0) {
          setMetaError("No measurement schemas available. Ensure the health platform is seeded.");
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Could not load measurement metadata";
          setMetaError(msg);
          toast({ title: "Load failed", description: msg, variant: "destructive" });
        }
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // When schema changes, sync the unit to the schema's default / first allowed unit.
  const onSchemaChange = (id: string) => {
    setSchemaId(id);
    const s = schemas.find((x) => x.id === id);
    const u = s?.defaultUnit ?? s?.allowedUnits?.[0] ?? "";
    if (u) setUnitId(u);
  };

  const submit = async () => {
    if (!schemaId || !profileId || value === "" || !unitId) {
      toast({
        title: "Missing fields",
        description: "Schema, profile, value and unit are required.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const parsed = Number(value);
      if (Number.isNaN(parsed)) {
        toast({ title: "Invalid value", description: "Value must be a number.", variant: "destructive" });
        setSubmitting(false);
        return;
      }
      const body = {
        schemaId,
        profileId,
        value: parsed,
        unitId,
        sourceId: sourceId || undefined,
        collectedBy: "technician",
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
      const res = await fetch("/api/health/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        data?: { measurementId?: string; verificationState?: string };
        error?: { message?: string };
      };
      if (data.ok) {
        toast({
          title: "Measurement recorded",
          description: `Verification state: ${data.data?.verificationState ?? "pending"}`,
        });
        setValue("");
        onRecorded();
      } else {
        toast({
          title: "Recording failed",
          description: data.error?.message ?? "Server rejected the measurement",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Network error",
        description: err instanceof Error ? err.message : "Could not reach server",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedSchema = schemas.find((s) => s.id === schemaId);
  const allowedUnits = selectedSchema?.allowedUnits ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Measurement</DialogTitle>
          <DialogDescription>
            Submit a new measurement against a participant&apos;s health profile. The platform
            validates it against the schema and assigns a verification state.
          </DialogDescription>
        </DialogHeader>

        {loadingMeta ? (
          <div className="py-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" /> Loading measurement metadata…
          </div>
        ) : metaError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {metaError}
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label>Measurement Type</Label>
              <Select value={schemaId} onValueChange={onSchemaChange}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {schemas.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.category ? ` · ${s.category}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Unit</Label>
                {allowedUnits.length > 0 ? (
                  <Select value={unitId} onValueChange={setUnitId}>
                    <SelectTrigger><SelectValue placeholder="Select unit" /></SelectTrigger>
                    <SelectContent>
                      {allowedUnits.map((u) => (
                        <SelectItem key={u} value={u}>{u}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={unitId}
                    onChange={(e) => setUnitId(e.target.value)}
                    placeholder="unit id"
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meas-value">Value</Label>
                <Input
                  id="meas-value"
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0.0"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                      {s.type ? ` · ${s.type}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Participant Profile</Label>
              {profiles.length > 0 ? (
                <Select value={profileId} onValueChange={setProfileId}>
                  <SelectTrigger><SelectValue placeholder="Select profile" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.id}
                        {p.accountId ? ` · ${p.accountId}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  placeholder="prof_..."
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meas-tags">Tags (comma-separated)</Label>
              <Input
                id="meas-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="technician-recorded"
              />
            </div>

            {selectedSchema && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-1">
                <Timer className="h-3 w-3" />
                <span>
                  Type: {selectedSchema.valueType}
                  {selectedSchema.category ? ` · ${selectedSchema.category}` : ""}
                </span>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || loadingMeta || !!metaError}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
          >
            {submitting ? (
              <>
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Recording…
              </>
            ) : (
              <>
                <TrendingUp className="h-4 w-4 mr-1" /> Record Measurement
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  label,
  value,
  hint,
  loading,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  loading?: boolean;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-md ${
              accent ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted text-muted-foreground"
            }`}
          >
            {icon}
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className={`text-2xl font-bold ${accent ? "text-[var(--brand)]" : ""}`}>
          {loading ? <span className="inline-block h-6 w-10 rounded bg-muted animate-pulse align-middle" /> : value}
        </p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Detail({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className={`text-xs font-medium truncate ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </p>
    </div>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border/60 p-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
              <div className="h-2.5 w-1/2 rounded bg-muted animate-pulse" />
            </div>
            <div className="h-5 w-12 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="text-muted-foreground/60 mb-2">{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | undefined | null, short = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (short) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Make raw IDs (prof_xxx, tech_yyy, prog_zzz) slightly friendlier to read.
function labelFor(id: string): string {
  if (!id) return "—";
  return id;
}
