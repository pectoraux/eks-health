"use client";

import { CalendarCheck, Clock, FileLock2, PenLine, CheckCircle2 } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard, EmptyState } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface SessionRow {
  id: string; participantId: string; technicianId: string; programId: string;
  status: string; scheduledAt: string; measurementCount: number; evidenceCount: number; completedAt?: string;
}

export function TechSessionsSection({ data }: { data: PlatformSnapshot }) {
  const techs = (data.technicians as { sessions?: { recent?: SessionRow[]; stats?: { total?: number } }; appointments?: { recent?: Array<{ id: string; status: string; scheduledAt: string; durationMinutes: number; sessionType: string }> } }) ?? {};
  const sessions = techs.sessions?.recent ?? [];
  const appointments = techs.appointments?.recent ?? [];

  const statusMap: Record<string, "default" | "secondary" | "destructive"> = {
    verified: "default", completed: "default", scheduled: "secondary", in_progress: "secondary",
    checked_in: "secondary", technician_signed: "secondary", participant_confirmed: "secondary",
    program_validated: "secondary", disputed: "destructive", cancelled: "destructive", failed: "destructive",
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Measurement Sessions"
        subtitle="A session contains participant, technician, program, requested measurements, evidence, verification, location, time, device, notes, signatures, and audit references. Sessions become immutable records with a complete chain of custody."
        icon={<CalendarCheck className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Sessions" value={techs.sessions?.stats?.total ?? sessions.length} accent />
        <StatCard label="Appointments" value={appointments.length} />
        <StatCard label="Verified" value={sessions.filter((s) => s.status === "verified").length} />
        <StatCard label="Disputed" value={sessions.filter((s) => s.status === "disputed").length} />
      </div>

      <Panel title="Verification Workflow">
        <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-1.5">
          {[
            { step: "scheduled", icon: <Clock className="h-3.5 w-3.5" /> },
            { step: "checked_in", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
            { step: "in_progress", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
            { step: "evidence_captured", icon: <FileLock2 className="h-3.5 w-3.5" /> },
            { step: "technician_signed", icon: <PenLine className="h-3.5 w-3.5" /> },
            { step: "participant_confirmed", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
            { step: "program_validated", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
            { step: "verified", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
          ].map((s, i) => (
            <div key={s.step} className="flex flex-col items-center text-center">
              <div className="flex items-center gap-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)]">
                  {s.icon}
                </div>
                {i < 7 && <div className="h-px w-4 bg-border" />}
              </div>
              <Mono className="text-[9px] text-muted-foreground mt-1">{s.step}</Mono>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Recent Sessions">
        {sessions.length === 0 ? <EmptyState message="No sessions yet. Technicians will create sessions during appointments." /> : (
          <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Session</TableHead>
                  <TableHead>Technician</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Measurements</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="pr-4">Scheduled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-4"><Mono className="text-xs">{s.id.slice(0, 20)}…</Mono></TableCell>
                    <TableCell><Mono className="text-xs">{s.technicianId.slice(0, 16)}…</Mono></TableCell>
                    <TableCell><StateBadge state={s.status} map={statusMap} /></TableCell>
                    <TableCell><Mono className="text-xs">{s.measurementCount}</Mono></TableCell>
                    <TableCell><Mono className="text-xs">{s.evidenceCount}</Mono></TableCell>
                    <TableCell className="pr-4 text-xs text-muted-foreground">{new Date(s.scheduledAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel title="Chain of Custody">
        <p className="text-xs text-muted-foreground mb-3">Every verified measurement has a complete, traceable chain of custody — sealed with SHA-256 for tamper-evidence.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {["requested", "collected", "device_captured", "evidence_uploaded", "technician_signed", "participant_confirmed", "program_validated", "verified"].map((step) => (
            <div key={step} className="rounded-md border border-border/40 p-2">
              <Mono className="text-[10px] text-[var(--brand)]">{step}</Mono>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
