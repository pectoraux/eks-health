/**
 * Eks-Health Technician Network — Appointment Platform
 *
 * A scheduling engine: booking, real availability computation against
 * weekly hours + blackout periods + existing appointments, rescheduling,
 * cancellation with waitlist promotion, recurring series, reminders.
 *
 * Programs customize booking rules per program (lead time, horizon,
 * cancellation policy, max reschedules, payment-required flag). The
 * platform itself knows nothing about specific healthcare domains —
 * it just manages time slots and capacity.
 *
 * All availability math is REAL: it consults the technician profile's
 * weeklyHours (in their timezone), excludes blackout windows and
 * existing appointments, and respects maxConcurrentBookings.
 */

import "server-only";
import {
  type AppointmentId,
  type WaitlistEntryId,
  type TechnicianId,
  type ProgramId,
  type AccountId,
  type AppointmentStatus,
  type AppointmentType,
  type PaymentIntentId,
  TechnicianError,
  TECHNICIAN_EVENTS,
  asAppointmentId,
  asWaitlistEntryId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getTechnicians, type AvailabilitySchedule } from "../profiles";

// ---------------------------------------------------------------------------
// Time / location primitives
// ---------------------------------------------------------------------------

export interface AppointmentLocation {
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
}

export interface TimeSlot {
  readonly start: string; // ISO-8601 UTC
  readonly end: string; // ISO-8601 UTC
  readonly available: boolean;
  readonly reason?: string; // why unavailable if applicable
}

export interface AvailabilityWindow {
  readonly start: string;
  readonly end: string;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Appointment
// ---------------------------------------------------------------------------

export interface AppointmentReminder {
  readonly id: string;
  readonly sentAt: string;
  readonly channel: "email" | "sms" | "push" | "in_app";
  readonly sentTo?: string;
  readonly message?: string;
}

export interface Appointment {
  readonly id: AppointmentId;
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly sessionType: AppointmentType;
  readonly scheduledAt: string; // ISO-8601 UTC
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly location?: AppointmentLocation | "remote";
  readonly status: AppointmentStatus;
  readonly notes: string[];
  readonly createdBy: AccountId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt?: string;
  readonly cancelledAt?: string;
  readonly cancellationReason?: string;
  readonly noShowAt?: string;
  readonly rescheduledFrom?: AppointmentId;
  readonly rescheduleCount: number;
  readonly paymentIntentId?: PaymentIntentId;
  readonly reminders: AppointmentReminder[];
  readonly recurringSeriesId?: string;
}

export interface CreateAppointmentInput {
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly sessionType: AppointmentType;
  readonly scheduledAt: string;
  readonly durationMinutes?: number;
  readonly timezone?: string;
  readonly location?: AppointmentLocation | "remote";
  readonly notes?: string[];
  readonly createdBy: AccountId;
  readonly paymentIntentId?: PaymentIntentId;
  readonly recurringSeriesId?: string;
  /** Skip rule validation (used internally for reschedules / recurring series). */
  readonly skipRuleValidation?: boolean;
}

// ---------------------------------------------------------------------------
// Booking rules (program-scoped)
// ---------------------------------------------------------------------------

export interface BookingRule {
  readonly programId: ProgramId;
  readonly minLeadTimeHours: number;
  readonly maxHorizonDays: number;
  readonly cancellationPolicy: "flexible" | "moderate" | "strict" | "custom";
  readonly allowReschedule: boolean;
  readonly maxReschedules: number;
  readonly requirePaymentIntent: boolean;
  readonly slotDurationMinutes?: number;
  readonly customAttributes?: Record<string, unknown>;
}

const DEFAULT_BOOKING_RULE: BookingRule = {
  programId: "" as ProgramId,
  minLeadTimeHours: 1,
  maxHorizonDays: 30,
  cancellationPolicy: "moderate",
  allowReschedule: true,
  maxReschedules: 3,
  requirePaymentIntent: false,
  slotDurationMinutes: 60,
};

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export interface WaitlistEntry {
  readonly id: WaitlistEntryId;
  readonly appointmentId?: AppointmentId; // original appointment that was full/cancelled
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly requestedSlot: { start: string; end: string };
  readonly position: number;
  readonly createdAt: string;
  readonly promotedTo?: AppointmentId;
  readonly promotedAt?: string;
}

export interface AddToWaitlistInput {
  readonly appointmentId?: AppointmentId;
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly requestedSlot: { start: string; end: string };
}

// ---------------------------------------------------------------------------
// Recurring appointments
// ---------------------------------------------------------------------------

export type RecurrencePattern = "daily" | "weekly" | "biweekly" | "monthly";

export interface RecurringAppointment {
  readonly id: string;
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly sessionType: AppointmentType;
  readonly pattern: RecurrencePattern;
  readonly startAt: string;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly location?: AppointmentLocation | "remote";
  readonly occurrences: number;
  readonly appointmentIds: AppointmentId[];
  readonly createdBy: AccountId;
  readonly createdAt: string;
  readonly until?: string;
}

export interface SetupRecurringInput {
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly sessionType: AppointmentType;
  readonly pattern: RecurrencePattern;
  readonly startAt: string;
  readonly durationMinutes?: number;
  readonly timezone?: string;
  readonly location?: AppointmentLocation | "remote";
  readonly occurrences?: number;
  readonly until?: string;
  readonly createdBy: AccountId;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  requested: ["confirmed", "cancelled", "no_show", "rescheduled"],
  offered: ["confirmed", "cancelled", "no_show", "rescheduled"],
  confirmed: ["in_progress", "cancelled", "no_show", "rescheduled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: [],
};

// ---------------------------------------------------------------------------
// Appointment manager
// ---------------------------------------------------------------------------

export class AppointmentManager {
  private readonly appointments = new Map<AppointmentId, Appointment>();
  private readonly bookingRules = new Map<ProgramId, BookingRule>();
  private readonly waitlist = new Map<WaitlistEntryId, WaitlistEntry>();
  private readonly waitlistByAppointment = new Map<AppointmentId, WaitlistEntryId[]>();
  private readonly recurring = new Map<string, RecurringAppointment>();
  private readonly byParticipant = new Map<AccountId, AppointmentId[]>();
  private readonly byTechnician = new Map<TechnicianId, AppointmentId[]>();
  private readonly byProgram = new Map<ProgramId, AppointmentId[]>();

  // -------------------------------------------------------------------------
  // Booking rules
  // -------------------------------------------------------------------------

  setBookingRule(rule: BookingRule): BookingRule {
    this.bookingRules.set(rule.programId, rule);
    return rule;
  }

  getBookingRule(programId: ProgramId): BookingRule {
    return this.bookingRules.get(programId) ?? { ...DEFAULT_BOOKING_RULE, programId };
  }

  // -------------------------------------------------------------------------
  // Booking
  // -------------------------------------------------------------------------

  book(input: CreateAppointmentInput): Appointment {
    const profile = getTechnicians().get(input.technicianId);
    if (!profile) {
      throw new TechnicianError({
        code: "eks.technician.appointment.technician_not_found",
        category: "not_found",
        message: "Technician not found.",
        metadata: { technicianId: input.technicianId },
      });
    }
    if (profile.status !== "active") {
      throw new TechnicianError({
        code: "eks.technician.appointment.technician_inactive",
        category: "state_conflict",
        message: `Technician is ${profile.status}.`,
        userMessage: "This technician is not currently accepting bookings.",
        metadata: { technicianId: input.technicianId, status: profile.status },
      });
    }

    const rule = this.getBookingRule(input.programId);
    const duration = input.durationMinutes ?? rule.slotDurationMinutes ?? 60;
    const timezone = input.timezone ?? profile.availability.timezone;

    if (!input.skipRuleValidation) {
      this.validateBookingRules(input, rule, duration);
    }

    const startMs = new Date(input.scheduledAt).getTime();
    const endMs = startMs + duration * 60_000;
    if (!Number.isFinite(startMs)) {
      throw new TechnicianError({
        code: "eks.technician.appointment.invalid_time",
        category: "validation",
        message: "scheduledAt is not a valid ISO timestamp.",
        metadata: { scheduledAt: input.scheduledAt },
      });
    }

    // Check availability: weekly hours + blackout + existing appointments.
    if (!input.skipRuleValidation) {
      this.assertAvailable(input.technicianId, profile.availability, startMs, endMs, input.sessionType);
    }

    const now = getClock().iso();
    const appt: Appointment = {
      id: asAppointmentId(generateId("appt_")),
      participantId: input.participantId,
      technicianId: input.technicianId,
      programId: input.programId,
      sessionType: input.sessionType,
      scheduledAt: input.scheduledAt,
      durationMinutes: duration,
      timezone,
      location: input.location,
      status: "requested",
      notes: input.notes ?? [],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      rescheduleCount: 0,
      reminders: [],
      paymentIntentId: input.paymentIntentId,
      recurringSeriesId: input.recurringSeriesId,
    };
    this.appointments.set(appt.id, appt);
    this.indexBy(appt);

    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.appointmentBooked,
        {
          appointmentId: appt.id,
          technicianId: appt.technicianId,
          participantId: appt.participantId,
          programId: appt.programId,
          scheduledAt: appt.scheduledAt,
          durationMinutes: appt.durationMinutes,
          sessionType: appt.sessionType,
        },
        {},
        "domain",
      ),
    );
    return appt;
  }

  confirm(id: AppointmentId, actor?: AccountId): Appointment {
    const updated = this.transition(id, "confirmed", { actor, setConfirmedAt: true });
    return updated;
  }

  start(id: AppointmentId, actor?: AccountId): Appointment {
    return this.transition(id, "in_progress", { actor });
  }

  complete(id: AppointmentId, actor?: AccountId): Appointment {
    return this.transition(id, "completed", { actor });
  }

  cancel(id: AppointmentId, reason: string, actor?: AccountId): Appointment {
    const updated = this.transition(id, "cancelled", { actor, reason, setCancelledAt: true });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.appointmentCancelled,
        {
          appointmentId: id,
          technicianId: updated.technicianId,
          participantId: updated.participantId,
          reason,
          cancelledAt: updated.cancelledAt,
        },
        {},
        "domain",
      ),
    );
    // Auto-promote waitlist for the cancelled slot.
    void this.promoteFromWaitlist(id);
    return updated;
  }

  markNoShow(id: AppointmentId, actor?: AccountId): Appointment {
    const now = getClock().iso();
    return this.transition(id, "no_show", { actor, extra: { noShowAt: now } });
  }

  /**
   * Reschedule: cancel the current appointment (mark as "rescheduled") and
   * create a new one linked via rescheduledFrom. Enforces maxReschedules
   * from the program's booking rule.
   */
  reschedule(
    id: AppointmentId,
    newSlot: { scheduledAt: string; durationMinutes?: number; location?: AppointmentLocation | "remote" },
    actor?: AccountId,
  ): Appointment {
    const original = this.require(id);
    const rule = this.getBookingRule(original.programId);
    if (!rule.allowReschedule) {
      throw new TechnicianError({
        code: "eks.technician.appointment.reschedule_not_allowed",
        category: "state_conflict",
        message: "Rescheduling is not allowed for this program.",
        metadata: { appointmentId: id, programId: original.programId },
      });
    }
    if (original.rescheduleCount >= rule.maxReschedules) {
      throw new TechnicianError({
        code: "eks.technician.appointment.max_reschedules_exceeded",
        category: "state_conflict",
        message: `Max reschedules (${rule.maxReschedules}) exceeded.`,
        userMessage: "You have rescheduled this appointment the maximum number of times.",
        metadata: { appointmentId: id, rescheduleCount: original.rescheduleCount },
      });
    }
    // Mark the original as rescheduled (terminal).
    this.transition(id, "rescheduled", { actor });

    const newAppt = this.book({
      participantId: original.participantId,
      technicianId: original.technicianId,
      programId: original.programId,
      sessionType: original.sessionType,
      scheduledAt: newSlot.scheduledAt,
      durationMinutes: newSlot.durationMinutes ?? original.durationMinutes,
      timezone: original.timezone,
      location: newSlot.location ?? original.location,
      notes: original.notes,
      createdBy: actor ?? original.createdBy,
      paymentIntentId: original.paymentIntentId,
      recurringSeriesId: original.recurringSeriesId,
      skipRuleValidation: false,
    });
    // Link rescheduledFrom + bump rescheduleCount.
    const linked: Appointment = {
      ...newAppt,
      rescheduledFrom: original.id,
      rescheduleCount: original.rescheduleCount + 1,
    };
    this.appointments.set(linked.id, linked);
    this.indexBy(linked);

    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.appointmentRescheduled,
        {
          appointmentId: linked.id,
          originalAppointmentId: original.id,
          technicianId: linked.technicianId,
          participantId: linked.participantId,
          newScheduledAt: linked.scheduledAt,
        },
        {},
        "domain",
      ),
    );
    return linked;
  }

  get(id: AppointmentId): Appointment | undefined {
    return this.appointments.get(id);
  }

  list(filter?: {
    participantId?: AccountId;
    technicianId?: TechnicianId;
    programId?: ProgramId;
    status?: AppointmentStatus;
    from?: string;
    to?: string;
    recurringSeriesId?: string;
  }): Appointment[] {
    let list = [...this.appointments.values()];
    if (filter?.participantId) list = list.filter((a) => a.participantId === filter.participantId);
    if (filter?.technicianId) list = list.filter((a) => a.technicianId === filter.technicianId);
    if (filter?.programId) list = list.filter((a) => a.programId === filter.programId);
    if (filter?.status) list = list.filter((a) => a.status === filter.status);
    if (filter?.from) list = list.filter((a) => a.scheduledAt >= filter.from!);
    if (filter?.to) list = list.filter((a) => a.scheduledAt <= filter.to!);
    if (filter?.recurringSeriesId) list = list.filter((a) => a.recurringSeriesId === filter.recurringSeriesId);
    return list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  // -------------------------------------------------------------------------
  // Waitlist
  // -------------------------------------------------------------------------

  addToWaitlist(input: AddToWaitlistInput): WaitlistEntry {
    const now = getClock().iso();
    // Position = current max position for the same technician + 1, scoped by
    // the requested slot start to keep the queue coherent per time window.
    const existing = [...this.waitlist.values()].filter(
      (e) =>
        e.technicianId === input.technicianId &&
        e.requestedSlot.start === input.requestedSlot.start &&
        !e.promotedAt,
    );
    const position = existing.length + 1;
    const entry: WaitlistEntry = {
      id: asWaitlistEntryId(generateId("waitlist_")),
      appointmentId: input.appointmentId,
      participantId: input.participantId,
      technicianId: input.technicianId,
      programId: input.programId,
      requestedSlot: input.requestedSlot,
      position,
      createdAt: now,
    };
    this.waitlist.set(entry.id, entry);
    if (input.appointmentId) {
      const list = this.waitlistByAppointment.get(input.appointmentId) ?? [];
      this.waitlistByAppointment.set(input.appointmentId, [...list, entry.id]);
    }
    void getEventBus().publish(
      buildEvent(
        "eks.technician.appointment.waitlist_added",
        {
          waitlistEntryId: entry.id,
          appointmentId: input.appointmentId,
          technicianId: input.technicianId,
          participantId: input.participantId,
          position,
        },
        {},
        "domain",
      ),
    );
    return entry;
  }

  /**
   * Promote the next eligible waitlist entry for a cancelled appointment's
   * slot. Creates a new appointment for the promoted participant and marks
   * the waitlist entry as promoted.
   */
  promoteFromWaitlist(cancelledAppointmentId: AppointmentId): Appointment | undefined {
    const cancelled = this.appointments.get(cancelledAppointmentId);
    if (!cancelled) return undefined;
    const entries = (this.waitlistByAppointment.get(cancelledAppointmentId) ?? [])
      .map((id) => this.waitlist.get(id)!)
      .filter((e) => e && !e.promotedAt)
      .sort((a, b) => a.position - b.position);
    if (entries.length === 0) return undefined;
    const next = entries[0];
    const newAppt = this.book({
      participantId: next.participantId,
      technicianId: next.technicianId,
      programId: next.programId,
      sessionType: cancelled.sessionType,
      scheduledAt: cancelled.scheduledAt,
      durationMinutes: cancelled.durationMinutes,
      timezone: cancelled.timezone,
      location: cancelled.location,
      createdBy: cancelled.createdBy,
      skipRuleValidation: true, // promotion bypasses lead time (slot already exists)
    });
    const promoted: WaitlistEntry = {
      ...next,
      promotedTo: newAppt.id,
      promotedAt: getClock().iso(),
    };
    this.waitlist.set(next.id, promoted);
    void getEventBus().publish(
      buildEvent(
        "eks.technician.appointment.waitlist_promoted",
        {
          waitlistEntryId: next.id,
          originalAppointmentId: cancelledAppointmentId,
          newAppointmentId: newAppt.id,
          participantId: next.participantId,
        },
        {},
        "domain",
      ),
    );
    return newAppt;
  }

  listWaitlist(filter?: {
    technicianId?: TechnicianId;
    programId?: ProgramId;
    appointmentId?: AppointmentId;
    includePromoted?: boolean;
  }): WaitlistEntry[] {
    let list = [...this.waitlist.values()];
    if (filter?.technicianId) list = list.filter((e) => e.technicianId === filter.technicianId);
    if (filter?.programId) list = list.filter((e) => e.programId === filter.programId);
    if (filter?.appointmentId) list = list.filter((e) => e.appointmentId === filter.appointmentId);
    if (!filter?.includePromoted) list = list.filter((e) => !e.promotedAt);
    return list.sort((a, b) => a.position - b.position);
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  /**
   * Compute available slots between [from, to] for a technician.
   * REAL availability computation:
   *   1. Iterate candidate slot starts in `slotDurationMinutes` increments.
   *   2. For each candidate, check the technician's weeklyHours (in their
   *      timezone) — skip if outside working hours or crossing midnight.
   *   3. Exclude slots overlapping blackout periods or existing appointments
   *      beyond maxConcurrentBookings.
   */
  getAvailability(
    technicianId: TechnicianId,
    from: string,
    to: string,
    options?: { slotDurationMinutes?: number; sessionType?: AppointmentType },
  ): TimeSlot[] {
    const profile = getTechnicians().get(technicianId);
    if (!profile) {
      throw new TechnicianError({
        code: "eks.technician.appointment.technician_not_found",
        category: "not_found",
        message: "Technician not found.",
        metadata: { technicianId },
      });
    }
    const sched = profile.availability;
    const slotDuration = options?.slotDurationMinutes ?? this.getBookingRule(profile.supportedPrograms[0] ?? ("" as ProgramId)).slotDurationMinutes ?? 60;
    const stepMs = slotDuration * 60_000;
    const slots: TimeSlot[] = [];

    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return slots;
    }

    const existing = this.list({ technicianId })
      .filter((a) => a.status !== "cancelled" && a.status !== "rescheduled" && a.status !== "no_show")
      .map((a) => ({
        start: new Date(a.scheduledAt).getTime(),
        end: new Date(a.scheduledAt).getTime() + a.durationMinutes * 60_000,
      }));

    const blackout = sched.blackoutPeriods.map((b) => ({
      start: new Date(b.from).getTime(),
      end: new Date(b.to).getTime(),
    }));

    const minStartMs = Date.now() + sched.bookingLeadTimeHours * 3_600_000;

    // Snap cursor up to the next slot boundary (UTC) so slots are aligned.
    let cursor = Math.ceil(fromMs / stepMs) * stepMs;
    while (cursor + stepMs <= toMs) {
      const slotStart = cursor;
      const slotEnd = cursor + stepMs;
      cursor += stepMs;

      if (slotStart < minStartMs) continue;

      const startInfo = tzParts(new Date(slotStart).toISOString(), sched.timezone);
      const endInfo = tzParts(new Date(slotEnd).toISOString(), sched.timezone);
      // Reject slots that cross midnight in the technician's tz.
      if (endInfo.dayOfWeek !== startInfo.dayOfWeek) continue;

      const dayHours = sched.weeklyHours.find((w) => w.dayOfWeek === startInfo.dayOfWeek);
      if (!dayHours) continue;

      const startMinutes = startInfo.hour * 60 + startInfo.minute;
      const endMinutes = endInfo.hour * 60 + endInfo.minute;
      const withinSlot = dayHours.slots.some(
        (s) => startMinutes >= s.startHour * 60 && endMinutes <= s.endHour * 60,
      );
      if (!withinSlot) continue;

      const available = this.isSlotAvailable(slotStart, slotEnd, existing, blackout, sched.maxConcurrentBookings);
      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
        available: available.ok,
        reason: available.reason,
      });
    }
    return slots.sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Real check that a slot is bookable for a technician. */
  private isSlotAvailable(
    startMs: number,
    endMs: number,
    existing: Array<{ start: number; end: number }>,
    blackout: Array<{ start: number; end: number }>,
    maxConcurrent: number,
  ): { ok: boolean; reason?: string } {
    for (const b of blackout) {
      if (startMs < b.end && endMs > b.start) {
        return { ok: false, reason: "blackout_period" };
      }
    }
    let overlapping = 0;
    for (const a of existing) {
      if (startMs < a.end && endMs > a.start) overlapping++;
    }
    if (overlapping >= maxConcurrent) {
      return { ok: false, reason: "capacity_full" };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Recurring
  // -------------------------------------------------------------------------

  setupRecurring(input: SetupRecurringInput): RecurringAppointment {
    const occurrences = input.occurrences ?? 8;
    if (occurrences < 1 || occurrences > 365) {
      throw new TechnicianError({
        code: "eks.technician.appointment.invalid_recurrence",
        category: "validation",
        message: "occurrences must be between 1 and 365.",
        metadata: { occurrences },
      });
    }
    const seriesId = `rec_${generateId()}`;
    const appointmentIds: AppointmentId[] = [];
    const startMs = new Date(input.startAt).getTime();
    const intervalMs = recurrenceIntervalMs(input.pattern);
    for (let i = 0; i < occurrences; i++) {
      const scheduledAt = new Date(startMs + i * intervalMs).toISOString();
      if (input.until && scheduledAt > input.until) break;
      try {
        const appt = this.book({
          participantId: input.participantId,
          technicianId: input.technicianId,
          programId: input.programId,
          sessionType: input.sessionType,
          scheduledAt,
          durationMinutes: input.durationMinutes,
          timezone: input.timezone,
          location: input.location,
          createdBy: input.createdBy,
          recurringSeriesId: seriesId,
        });
        appointmentIds.push(appt.id);
      } catch (err) {
        // If a slot in the series is unavailable, skip it but keep going.
        // We log via event bus for observability.
        void getEventBus().publish(
          buildEvent(
            "eks.technician.appointment.recurring_slot_skipped",
            { seriesId, scheduledAt, reason: err instanceof Error ? err.message : String(err) },
            {},
            "domain",
          ),
        );
      }
    }
    const series: RecurringAppointment = {
      id: seriesId,
      participantId: input.participantId,
      technicianId: input.technicianId,
      programId: input.programId,
      sessionType: input.sessionType,
      pattern: input.pattern,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes ?? 60,
      timezone: input.timezone ?? "UTC",
      location: input.location,
      occurrences: appointmentIds.length,
      appointmentIds,
      createdBy: input.createdBy,
      createdAt: getClock().iso(),
      until: input.until,
    };
    this.recurring.set(seriesId, series);
    return series;
  }

  getRecurring(seriesId: string): RecurringAppointment | undefined {
    return this.recurring.get(seriesId);
  }

  listRecurring(filter?: { participantId?: AccountId; technicianId?: TechnicianId; programId?: ProgramId }): RecurringAppointment[] {
    let list = [...this.recurring.values()];
    if (filter?.participantId) list = list.filter((r) => r.participantId === filter.participantId);
    if (filter?.technicianId) list = list.filter((r) => r.technicianId === filter.technicianId);
    if (filter?.programId) list = list.filter((r) => r.programId === filter.programId);
    return list;
  }

  // -------------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------------

  sendReminder(id: AppointmentId, channel: AppointmentReminder["channel"], message?: string, sentTo?: string): Appointment {
    const appt = this.require(id);
    const reminder: AppointmentReminder = {
      id: generateId("rem_"),
      sentAt: getClock().iso(),
      channel,
      sentTo,
      message,
    };
    const updated: Appointment = {
      ...appt,
      reminders: [...appt.reminders, reminder],
      updatedAt: getClock().iso(),
    };
    this.appointments.set(id, updated);
    void getEventBus().publish(
      buildEvent(
        "eks.technician.appointment.reminder_sent",
        { appointmentId: id, reminderId: reminder.id, channel, sentTo },
        {},
        "domain",
      ),
    );
    return updated;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    waitlistSize: number;
    recurringSeries: number;
  } {
    const list = [...this.appointments.values()];
    const byStatus: Record<string, number> = {};
    for (const a of list) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    return {
      total: list.length,
      byStatus,
      waitlistSize: [...this.waitlist.values()].filter((e) => !e.promotedAt).length,
      recurringSeries: this.recurring.size,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private require(id: AppointmentId): Appointment {
    const appt = this.appointments.get(id);
    if (!appt) {
      throw new TechnicianError({
        code: "eks.technician.appointment.not_found",
        category: "not_found",
        message: "Appointment not found.",
        userMessage: "This appointment does not exist.",
        metadata: { appointmentId: id },
      });
    }
    return appt;
  }

  private transition(
    id: AppointmentId,
    toStatus: AppointmentStatus,
    opts: {
      actor?: AccountId;
      reason?: string;
      setConfirmedAt?: boolean;
      setCancelledAt?: boolean;
      extra?: Partial<Appointment>;
    },
  ): Appointment {
    const appt = this.require(id);
    const allowed = APPOINTMENT_TRANSITIONS[appt.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new TechnicianError({
        code: "eks.technician.appointment.invalid_transition",
        category: "state_conflict",
        message: `Cannot transition appointment from ${appt.status} to ${toStatus}.`,
        userMessage: "This appointment state change is not allowed.",
        metadata: { appointmentId: id, from: appt.status, to: toStatus },
      });
    }
    const now = getClock().iso();
    const updated: Appointment = {
      ...appt,
      status: toStatus,
      confirmedAt: opts.setConfirmedAt ? now : appt.confirmedAt,
      cancelledAt: opts.setCancelledAt ? now : appt.cancelledAt,
      cancellationReason: opts.reason ?? appt.cancellationReason,
      updatedAt: now,
      ...(opts.extra ?? {}),
    };
    this.appointments.set(id, updated);
    return updated;
  }

  private validateBookingRules(input: CreateAppointmentInput, rule: BookingRule, duration: number): void {
    if (rule.requirePaymentIntent && !input.paymentIntentId) {
      throw new TechnicianError({
        code: "eks.technician.appointment.payment_required",
        category: "payment_required",
        message: "This program requires a payment intent to book.",
        userMessage: "A payment is required to confirm this booking.",
        metadata: { programId: input.programId },
      });
    }
    const startMs = new Date(input.scheduledAt).getTime();
    const nowMs = Date.now();
    const minLeadMs = rule.minLeadTimeHours * 3_600_000;
    if (startMs < nowMs + minLeadMs) {
      throw new TechnicianError({
        code: "eks.technician.appointment.lead_time_violation",
        category: "validation",
        message: `Booking must be at least ${rule.minLeadTimeHours}h in advance.`,
        userMessage: `Please book at least ${rule.minLeadTimeHours} hour(s) in advance.`,
        metadata: { scheduledAt: input.scheduledAt, minLeadTimeHours: rule.minLeadTimeHours },
      });
    }
    const horizonMs = rule.maxHorizonDays * 86_400_000;
    if (startMs > nowMs + horizonMs) {
      throw new TechnicianError({
        code: "eks.technician.appointment.horizon_exceeded",
        category: "validation",
        message: `Booking cannot be more than ${rule.maxHorizonDays} days ahead.`,
        userMessage: `Bookings can only be made up to ${rule.maxHorizonDays} days in advance.`,
        metadata: { scheduledAt: input.scheduledAt, maxHorizonDays: rule.maxHorizonDays },
      });
    }
    if (duration <= 0 || duration > 24 * 60) {
      throw new TechnicianError({
        code: "eks.technician.appointment.invalid_duration",
        category: "validation",
        message: "Duration must be between 1 and 1440 minutes.",
        metadata: { duration },
      });
    }
  }

  private assertAvailable(
    technicianId: TechnicianId,
    sched: AvailabilitySchedule,
    startMs: number,
    endMs: number,
    _sessionType: AppointmentType,
  ): void {
    // 1. Weekly hours check (technician's tz).
    const startInfo = tzParts(new Date(startMs).toISOString(), sched.timezone);
    const endInfo = tzParts(new Date(endMs).toISOString(), sched.timezone);
    const dayHours = sched.weeklyHours.find((w) => w.dayOfWeek === startInfo.dayOfWeek);
    if (!dayHours) {
      throw new TechnicianError({
        code: "eks.technician.appointment.outside_hours",
        category: "appointment_conflict",
        message: `Technician does not work on this day (dow=${startInfo.dayOfWeek}).`,
        userMessage: "The technician is not available on this day.",
        metadata: { technicianId, dayOfWeek: startInfo.dayOfWeek },
      });
    }
    const startMinutes = startInfo.hour * 60 + startInfo.minute;
    const endMinutes = endInfo.hour * 60 + endInfo.minute;
    const withinSlot = dayHours.slots.some(
      (s) => startMinutes >= s.startHour * 60 && endMinutes <= s.endHour * 60,
    );
    // Handle wrap to next day (endMinutes < startMinutes) — for simplicity, allow
    // only same-day slots here.
    if (!withinSlot && endMinutes >= startMinutes) {
      throw new TechnicianError({
        code: "eks.technician.appointment.outside_hours",
        category: "appointment_conflict",
        message: `Time ${startMinutes}-${endMinutes} outside working hours.`,
        userMessage: "The requested time is outside the technician's working hours.",
        metadata: { technicianId, startMinutes, endMinutes },
      });
    }

    // 2. Blackout periods.
    for (const b of sched.blackoutPeriods) {
      const bStart = new Date(b.from).getTime();
      const bEnd = new Date(b.to).getTime();
      if (startMs < bEnd && endMs > bStart) {
        throw new TechnicianError({
          code: "eks.technician.appointment.blackout",
          category: "appointment_conflict",
          message: `Time overlaps a blackout period${b.reason ? ` (${b.reason})` : ""}.`,
          userMessage: "The technician is unavailable during this period.",
          metadata: { technicianId, blackoutFrom: b.from, blackoutTo: b.to },
        });
      }
    }

    // 3. Existing appointments + maxConcurrentBookings.
    const existing = this.list({ technicianId })
      .filter((a) => a.status !== "cancelled" && a.status !== "rescheduled" && a.status !== "no_show")
      .map((a) => ({
        start: new Date(a.scheduledAt).getTime(),
        end: new Date(a.scheduledAt).getTime() + a.durationMinutes * 60_000,
      }));
    let overlapping = 0;
    for (const a of existing) {
      if (startMs < a.end && endMs > a.start) overlapping++;
    }
    if (overlapping >= sched.maxConcurrentBookings) {
      throw new TechnicianError({
        code: "eks.technician.appointment.capacity_full",
        category: "appointment_conflict",
        message: `Technician is at max concurrent bookings (${sched.maxConcurrentBookings}).`,
        userMessage: "The technician is fully booked at this time.",
        metadata: { technicianId, overlapping, maxConcurrent: sched.maxConcurrentBookings },
      });
    }
  }

  private indexBy(a: Appointment): void {
    const pList = this.byParticipant.get(a.participantId) ?? [];
    this.byParticipant.set(a.participantId, [...pList, a.id]);
    const tList = this.byTechnician.get(a.technicianId) ?? [];
    this.byTechnician.set(a.technicianId, [...tList, a.id]);
    const prList = this.byProgram.get(a.programId) ?? [];
    this.byProgram.set(a.programId, [...prList, a.id]);
  }
}

// ---------------------------------------------------------------------------
// Timezone helpers (no external deps; uses Intl.DateTimeFormat)
// ---------------------------------------------------------------------------

interface TzParts {
  dayOfWeek: number;
  hour: number;
  minute: number;
  year: number;
  month: number;
  day: number;
}
export type { TzParts };

function tzParts(iso: string, timezone: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(iso));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hourRaw = map.hour ?? "0";
  const hour = parseInt(hourRaw === "24" ? "0" : hourRaw, 10) || 0;
  return {
    dayOfWeek: weekdayMap[map.weekday ?? "Sun"] ?? 0,
    hour,
    minute: parseInt(map.minute ?? "0", 10) || 0,
    year: parseInt(map.year ?? "1970", 10),
    month: parseInt(map.month ?? "1", 10),
    day: parseInt(map.day ?? "1", 10),
  };
}

/**
 * Combine a tz-derived calendar day with a minute offset (minutes since
 * midnight in that tz) to produce a UTC epoch ms. Uses Intl.DateTimeFormat
 * to detect the tz offset at that instant. Exported for testing / external
 * callers that need to translate wall-clock times to UTC.
 */
export function combineTz(dayInfo: TzParts, minutesSinceMidnight: number, timezone: string): number {
  const wallClockUtcGuess = Date.UTC(
    dayInfo.year,
    dayInfo.month - 1,
    dayInfo.day,
    Math.floor(minutesSinceMidnight / 60),
    minutesSinceMidnight % 60,
    0,
    0,
  );
  const guessIso = new Date(wallClockUtcGuess).toISOString();
  const back = tzParts(guessIso, timezone);
  const intendedMinutes = dayInfo.day * 1440 + Math.floor(minutesSinceMidnight / 60) * 60 + (minutesSinceMidnight % 60);
  const actualMinutes = back.day * 1440 + back.hour * 60 + back.minute;
  let offsetMinutes = intendedMinutes - actualMinutes;
  if (offsetMinutes > 720) offsetMinutes -= 1440;
  if (offsetMinutes < -720) offsetMinutes += 1440;
  return wallClockUtcGuess + offsetMinutes * 60_000;
}


function recurrenceIntervalMs(pattern: RecurrencePattern): number {
  switch (pattern) {
    case "daily": return 86_400_000;
    case "weekly": return 7 * 86_400_000;
    case "biweekly": return 14 * 86_400_000;
    case "monthly": return 30 * 86_400_000;
    default: return 7 * 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: AppointmentManager | null = null;

export function getAppointments(): AppointmentManager {
  if (!_manager) _manager = new AppointmentManager();
  return _manager;
}

/** Test-only: replace the singleton. */
export function setAppointments(manager: AppointmentManager | null): void {
  _manager = manager;
}
