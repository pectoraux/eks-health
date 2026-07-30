/**
 * Eks-Health Kernel — Notification Infrastructure
 *
 * The platform's outbound notification layer. All user-facing messages
 * (welcome emails, OTP SMS, program invites, system alerts, webhooks) flow
 * through this single abstraction. No specific delivery backend is
 * hardcoded — providers register per channel against a uniform
 * `NotificationProvider` interface.
 *
 * Capabilities:
 *  - Multi-channel: email, sms, push, in_app, webhook
 *  - Pluggable providers per channel (default: in-memory capture adapter)
 *  - Template registry with `{param}` interpolation + `{{#if}}...{{/if}}`
 *  - User preferences (channel enable/disable) enforced on every send
 *  - Scheduling (deliver-at-time via queued messages)
 *  - Bulk send
 *  - Append-only notification log with full delivery lifecycle
 *
 * The default adapter is in-memory; production swaps in SES/Twilio/FCM/Slack.
 */

import type { CorrelationId, UserId } from "../core";
import {
  NotFoundError,
  ValidationError,
  generateId,
  getClock,
} from "../core";

// ---------------------------------------------------------------------------
// Channels & statuses
// ---------------------------------------------------------------------------

export type NotificationChannel = "email" | "sms" | "push" | "in_app" | "webhook";

export type NotificationStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "bounced"
  | "filtered";

// ---------------------------------------------------------------------------
// Recipients & preferences
// ---------------------------------------------------------------------------

export interface NotificationRecipient {
  readonly userId?: UserId;
  readonly email?: string;
  readonly phone?: string; // E.164
  readonly deviceToken?: string;
  readonly webhookUrl?: string;
  readonly language?: string;
}

export interface NotificationPreference {
  readonly userId: UserId;
  /** Per-channel master switch. Missing channel = enabled (default allow). */
  readonly channels: Partial<Record<NotificationChannel, boolean>>;
  /** Optional template-category overrides, e.g. { security: { email: true } }. */
  readonly categoryOverrides?: Record<string, Partial<Record<NotificationChannel, boolean>>>;
}

// ---------------------------------------------------------------------------
// Templates & messages
// ---------------------------------------------------------------------------

export type TemplateParamValue = string | number | boolean | undefined | null;

export interface NotificationTemplate {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly subject?: string;
  readonly body: string;
  readonly description?: string;
  readonly category?: string;
  readonly variables: readonly string[];
}

export interface NotificationMessage {
  readonly id?: string;
  readonly channel: NotificationChannel;
  readonly templateId?: string;
  readonly params?: Record<string, TemplateParamValue>;
  readonly recipient: NotificationRecipient;
  readonly subject?: string;
  readonly body?: string;
  readonly providerName?: string;
  readonly scheduledFor?: string; // ISO-8601 future time
  readonly category?: string;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: CorrelationId;
}

export interface NotificationDeliveryResult {
  readonly messageId: string;
  readonly status: NotificationStatus;
  readonly provider: string;
  readonly providerMessageId?: string;
  readonly at: string;
  readonly error?: string;
}

export interface NotificationLog {
  readonly id: string;
  readonly messageId: string;
  readonly channel: NotificationChannel;
  readonly recipient: NotificationRecipient;
  readonly templateId?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly status: NotificationStatus;
  readonly provider?: string;
  readonly category?: string;
  readonly at: string;
  readonly error?: string;
  readonly correlationId?: CorrelationId;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface NotificationProvider {
  readonly name: string;
  readonly channel: NotificationChannel;
  send(message: NotificationMessage): Promise<NotificationDeliveryResult>;
}

// ---------------------------------------------------------------------------
// In-memory provider (default adapter for every channel)
// ---------------------------------------------------------------------------

export class InMemoryNotificationProvider implements NotificationProvider {
  readonly name: string;
  readonly channel: NotificationChannel;
  private readonly sent = new Map<string, NotificationMessage>();

  constructor(channel: NotificationChannel, name = "in-memory") {
    this.channel = channel;
    this.name = name;
  }

  async send(message: NotificationMessage): Promise<NotificationDeliveryResult> {
    const id = message.id ?? generateId("msg_");
    this.sent.set(id, { ...message, id });
    return {
      messageId: id,
      status: "sent",
      provider: this.name,
      providerMessageId: `mem_${id}`,
      at: getClock().iso(),
    };
  }

  getSent(): readonly NotificationMessage[] {
    return [...this.sent.values()];
  }

  clear(): void {
    this.sent.clear();
  }
}

// ---------------------------------------------------------------------------
// Built-in template registry
// ---------------------------------------------------------------------------

export const TEMPLATES = {
  welcomeEmail: "welcome_email",
  otpSms: "otp_sms",
  programInvitePush: "program_invite_push",
  systemAlertInApp: "system_alert_inapp",
} as const;

export type BuiltinTemplateId = (typeof TEMPLATES)[keyof typeof TEMPLATES];

export const BUILTIN_TEMPLATES: readonly NotificationTemplate[] = [
  {
    id: TEMPLATES.welcomeEmail,
    channel: "email",
    subject: "Welcome to Eks-Health, {name}!",
    body: [
      "Hi {name},",
      "",
      "Welcome to Eks-Health{#if programName}! You've been invited to join the {programName} program{/if}.",
      "Your account is ready and waiting.",
      "",
      "— The Eks-Health Team",
    ].join("\n"),
    description: "Sent on new user sign-up.",
    category: "onboarding",
    variables: ["name", "programName"],
  },
  {
    id: TEMPLATES.otpSms,
    channel: "sms",
    body: "Your Eks-Health code is {code}. It expires in 10 minutes.{{#if debug}} [tenant: {tenant}]{{/if}}",
    description: "One-time-passcode for 2FA / verification.",
    category: "security",
    variables: ["code", "debug", "tenant"],
  },
  {
    id: TEMPLATES.programInvitePush,
    channel: "push",
    body: "{inviterName} invited you to join {programName}. Tap to accept.{{#if expiresAt}} Expires {expiresAt}.{{/if}}",
    description: "Push notification for program invitations.",
    category: "program",
    variables: ["inviterName", "programName", "expiresAt"],
  },
  {
    id: TEMPLATES.systemAlertInApp,
    channel: "in_app",
    subject: "System Alert",
    body: "{alertMessage}{{#if actionUrl}}\n\nOpen: {actionUrl}{{/if}}",
    description: "In-app banner for platform-level alerts.",
    category: "system",
    variables: ["alertMessage", "actionUrl"],
  },
];

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

export interface RenderedTemplate {
  readonly subject?: string;
  readonly body: string;
}

/** Truthiness rule for {{#if}}. */
function isTruthy(v: TemplateParamValue): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return Boolean(v);
}

function stringify(v: TemplateParamValue): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Render a template body/subject against a params map.
 * Supports:
 *   {param}                 -> simple interpolation
 *   {{#if param}}…{{/if}}   -> keep … only when param is truthy (single-level)
 */
export function renderTemplateString(
  template: string,
  params: Record<string, TemplateParamValue> = {},
): string {
  // 1. Resolve {{#if}}…{{/if}} blocks first (non-greedy, single-level).
  const ifRe = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  let out = template.replace(ifRe, (_m, name: string, inner: string) => {
    return isTruthy(params[name as string]) ? inner : "";
  });
  // 2. Resolve {param} interpolations.
  out = out.replace(/\{(\w+)\}/g, (_m, name: string) => {
    return stringify(params[name as string]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface ProviderRegistration {
  readonly provider: NotificationProvider;
  isDefault: boolean;
}

export interface NotificationManagerStats {
  readonly channelsRegistered: number;
  readonly templatesRegistered: number;
  readonly logSize: number;
  readonly pendingScheduled: number;
}

export class NotificationManager {
  private readonly providers = new Map<NotificationChannel, Map<string, ProviderRegistration>>();
  private readonly templates = new Map<string, NotificationTemplate>();
  private readonly preferences = new Map<string, NotificationPreference>();
  private readonly log: NotificationLog[] = [];
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    // Register the in-memory default for every supported channel.
    for (const ch of ["email", "sms", "push", "in_app", "webhook"] as NotificationChannel[]) {
      const p = new InMemoryNotificationProvider(ch);
      this.registerProvider(ch, p.name, p);
      this.setDefaultProvider(ch, p.name);
    }
    // Register built-in templates.
    for (const t of BUILTIN_TEMPLATES) {
      this.templates.set(t.id, t);
    }
  }

  // -- Providers ----------------------------------------------------------

  registerProvider(channel: NotificationChannel, name: string, provider: NotificationProvider): void {
    if (provider.channel !== channel) {
      throw new ValidationError(
        "eks.error.notification.channel_mismatch",
        `Provider '${name}' declares channel '${provider.channel}' but was registered for '${channel}'`,
        "Notification provider misconfigured.",
      );
    }
    let bucket = this.providers.get(channel);
    if (!bucket) {
      bucket = new Map();
      this.providers.set(channel, bucket);
    }
    const isDefault = bucket.size === 0;
    bucket.set(name, { provider, isDefault });
  }

  setDefaultProvider(channel: NotificationChannel, name: string): void {
    const bucket = this.providers.get(channel);
    if (!bucket || !bucket.has(name)) {
      throw new NotFoundError(
        "eks.error.notification.provider_not_found",
        `No '${name}' provider registered for channel '${channel}'`,
        "Notification provider is not configured.",
      );
    }
    for (const [n, reg] of bucket.entries()) {
      bucket.set(n, { ...reg, isDefault: n === name });
    }
  }

  getDefaultProvider(channel: NotificationChannel): NotificationProvider {
    const bucket = this.providers.get(channel);
    if (!bucket || bucket.size === 0) {
      throw new NotFoundError(
        "eks.error.notification.no_provider_for_channel",
        `No provider registered for channel '${channel}'`,
        "Notification channel is not configured.",
      );
    }
    for (const reg of bucket.values()) {
      if (reg.isDefault) return reg.provider;
    }
    // Fallback: first registered.
    return [...bucket.values()][0]!.provider;
  }

  getProvider(channel: NotificationChannel, name: string): NotificationProvider | undefined {
    return this.providers.get(channel)?.get(name)?.provider;
  }

  listProviders(channel?: NotificationChannel): readonly string[] {
    if (channel) {
      return [...(this.providers.get(channel)?.keys() ?? [])];
    }
    const out: string[] = [];
    for (const bucket of this.providers.values()) {
      for (const name of bucket.keys()) out.push(name);
    }
    return out;
  }

  // -- Templates ----------------------------------------------------------

  registerTemplate(template: NotificationTemplate): void {
    this.templates.set(template.id, template);
  }

  getTemplate(id: string): NotificationTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(): readonly NotificationTemplate[] {
    return [...this.templates.values()];
  }

  /** Render a registered template by id. Throws if not found. */
  renderTemplate(id: string, params: Record<string, TemplateParamValue> = {}): RenderedTemplate {
    const t = this.templates.get(id);
    if (!t) {
      throw new NotFoundError(
        "eks.error.notification.template_not_found",
        `Notification template '${id}' is not registered`,
        "Notification template is missing.",
      );
    }
    const body = renderTemplateString(t.body, params);
    const subject = t.subject ? renderTemplateString(t.subject, params) : undefined;
    return { subject, body };
  }

  // -- Preferences -------------------------------------------------------

  getUserPreferences(userId: UserId): NotificationPreference {
    return (
      this.preferences.get(userId) ?? {
        userId,
        channels: {},
      }
    );
  }

  setUserPreferences(userId: UserId, prefs: NotificationPreference): void {
    this.preferences.set(userId, { ...prefs, userId });
  }

  /** Returns true if the (userId, channel, category) tuple is allowed. */
  private isAllowed(userId: UserId | undefined, channel: NotificationChannel, category?: string): boolean {
    if (!userId) return true; // No user identity → cannot enforce prefs, allow.
    const prefs = this.preferences.get(userId);
    if (!prefs) return true; // No prefs → default allow.
    if (category && prefs.categoryOverrides?.[category]) {
      const override = prefs.categoryOverrides[category]!;
      if (override[channel] !== undefined) {
        return override[channel] === true;
      }
    }
    if (prefs.channels[channel] !== undefined) {
      return prefs.channels[channel] === true;
    }
    return true; // Default allow.
  }

  // -- Sending -----------------------------------------------------------

  /**
   * Send a single message. Honors templates, user preferences, scheduling,
   * and provider overrides. Returns the final log entry.
   */
  async send(message: NotificationMessage): Promise<NotificationLog> {
    const messageId = message.id ?? generateId("msg_");
    const now = getClock().iso();

    // 1. Resolve template if present.
    let subject = message.subject;
    let body = message.body;
    let templateId = message.templateId;
    let channel = message.channel;
    if (message.templateId) {
      const t = this.templates.get(message.templateId);
      if (!t) {
        throw new NotFoundError(
          "eks.error.notification.template_not_found",
          `Notification template '${message.templateId}' is not registered`,
          "Notification template is missing.",
        );
      }
      const rendered = this.renderTemplate(message.templateId, message.params ?? {});
      subject = subject ?? rendered.subject;
      body = body ?? rendered.body;
      channel = t.channel; // Template's channel wins.
      templateId = message.templateId;
    }

    // 2. Preference check.
    const userId = message.recipient.userId;
    if (!this.isAllowed(userId, channel, message.category ?? templateId)) {
      const entry: NotificationLog = {
        id: generateId("nl_"),
        messageId,
        channel,
        recipient: message.recipient,
        templateId,
        subject,
        body,
        status: "filtered",
        category: message.category,
        at: now,
        correlationId: message.correlationId,
      };
      this.log.push(entry);
      return entry;
    }

    // 3. Scheduling: if scheduledFor is in the future, queue.
    if (message.scheduledFor) {
      const when = Date.parse(message.scheduledFor);
      if (Number.isNaN(when)) {
        throw new ValidationError(
          "eks.error.notification.invalid_schedule",
          `Invalid scheduledFor timestamp: '${message.scheduledFor}'`,
          "Notification schedule is invalid.",
        );
      }
      const delay = when - getClock().epochMs();
      if (delay > 0) {
        const queued: NotificationLog = {
          id: generateId("nl_"),
          messageId,
          channel,
          recipient: message.recipient,
          templateId,
          subject,
          body,
          status: "queued",
          category: message.category,
          at: now,
          correlationId: message.correlationId,
        };
        this.log.push(queued);
        const enriched: NotificationMessage = {
          ...message,
          id: messageId,
          subject,
          body,
          channel,
          templateId,
          scheduledFor: undefined,
        };
        const timer = setTimeout(() => {
          this.pendingTimers.delete(timer);
          void this.dispatch(enriched, messageId);
        }, delay);
        this.pendingTimers.add(timer);
        return queued;
      }
    }

    // 4. Dispatch immediately.
    return this.dispatch(
      { ...message, id: messageId, subject, body, channel, templateId },
      messageId,
    );
  }

  private async dispatch(
    message: NotificationMessage,
    messageId: string,
  ): Promise<NotificationLog> {
    const provider = message.providerName
      ? this.getProvider(message.channel, message.providerName)
      : this.getDefaultProvider(message.channel);
    if (!provider) {
      throw new NotFoundError(
        "eks.error.notification.provider_not_found",
        `Notification provider '${message.providerName}' not registered for channel '${message.channel}'`,
        "Notification provider is not configured.",
      );
    }
    let entry: NotificationLog;
    try {
      const result = await provider.send(message);
      entry = {
        id: generateId("nl_"),
        messageId,
        channel: message.channel,
        recipient: message.recipient,
        templateId: message.templateId,
        subject: message.subject,
        body: message.body,
        status: result.status,
        provider: result.provider,
        category: message.category,
        at: result.at,
        error: result.error,
        correlationId: message.correlationId,
      };
    } catch (e) {
      entry = {
        id: generateId("nl_"),
        messageId,
        channel: message.channel,
        recipient: message.recipient,
        templateId: message.templateId,
        subject: message.subject,
        body: message.body,
        status: "failed",
        provider: provider.name,
        category: message.category,
        at: getClock().iso(),
        error: e instanceof Error ? e.message : String(e),
        correlationId: message.correlationId,
      };
    }
    this.log.push(entry);
    return entry;
  }

  /** Send many messages in parallel. Returns one log entry per input. */
  async sendBulk(messages: readonly NotificationMessage[]): Promise<NotificationLog[]> {
    return Promise.all(messages.map((m) => this.send(m)));
  }

  // -- Log ---------------------------------------------------------------

  getLog(filter?: (e: NotificationLog) => boolean): readonly NotificationLog[] {
    return filter ? this.log.filter(filter) : [...this.log];
  }

  stats(): NotificationManagerStats {
    return {
      channelsRegistered: this.providers.size,
      templatesRegistered: this.templates.size,
      logSize: this.log.length,
      pendingScheduled: this.pendingTimers.size,
    };
  }

  /** Cancel any pending scheduled deliveries. Test/maintenance hook. */
  cancelPending(): void {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _notifications: NotificationManager | null = null;

export function getNotifications(): NotificationManager {
  if (!_notifications) _notifications = new NotificationManager();
  return _notifications;
}

export function setNotifications(mgr: NotificationManager): void {
  _notifications = mgr;
}

export function resetNotifications(): void {
  _notifications = null;
}

// Re-export the userId helper for convenience.
export { asUserId } from "../core";
