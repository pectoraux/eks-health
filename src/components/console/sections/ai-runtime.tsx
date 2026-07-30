"use client";

import { Bot, ShieldCheck, Zap, Activity, Workflow, Brain } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function AISection({ data }: { data: PlatformSnapshot }) {
  // The AI runtime doesn't have a snapshot in the platform snapshot yet,
  // but we can show the architecture and capabilities.
  return (
    <div className="space-y-6">
      <SectionHeader
        title="AI Runtime & Safety Layer"
        subtitle="The production AI execution environment. Multiple providers, model routing, prompt templates, structured outputs, tool calling, memory, retrieval, workflow orchestration, and agent coordination. Every request passes through a safety layer — no program can bypass it. No provider is hardcoded."
        icon={<Bot className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="AI Subsystems" value={6} hint="core, runtime, safety, agents, workflows, observability" accent />
        <StatCard label="Safety Checks" value={7} hint="PII, injection, consent..." />
        <StatCard label="Workflow Steps" value={15} hint="step types" />
        <StatCard label="Agent Roles" value={8} hint="coach, planner, advisor..." />
      </div>

      <Panel title="AI Execution Pipeline">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1.5">
          {[
            { step: "Prompt Render", icon: <Brain className="h-3.5 w-3.5" /> },
            { step: "Safety Check", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
            { step: "Model Route", icon: <Zap className="h-3.5 w-3.5" /> },
            { step: "Provider Call", icon: <Bot className="h-3.5 w-3.5" /> },
            { step: "Output Validate", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
            { step: "Cost Track", icon: <Activity className="h-3.5 w-3.5" /> },
            { step: "Response", icon: <CheckCircle className="h-3.5 w-3.5" /> },
          ].map((s, i) => (
            <div key={s.step} className="flex flex-col items-center text-center">
              <div className="flex items-center gap-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)]">
                  {s.icon}
                </div>
                {i < 6 && <div className="h-px w-3 bg-border" />}
              </div>
              <Mono className="text-[9px] text-muted-foreground mt-1">{s.step}</Mono>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Safety Layer Checks">
          <div className="space-y-2">
            {[
              { name: "Permission Validation", desc: "Does the program have the 'ai' capability?" },
              { name: "Consent Validation", desc: "Is there an active consent for AI?" },
              { name: "PII Detection", desc: "Real regex: email, phone, SSN, credit card (Luhn-validated), IPv4" },
              { name: "Prompt Injection", desc: "Pattern matching: 'ignore previous', 'system:', 'admin override'" },
              { name: "External URL Blocking", desc: "Blocks URLs in prompts" },
              { name: "Model Allowlist", desc: "Only approved models can be used" },
              { name: "Token Limits", desc: "Max tokens per request enforced" },
            ].map((c) => (
              <div key={c.name} className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
                <ShieldCheck className="h-4 w-4 text-[var(--brand)] mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium">{c.name}</p>
                  <p className="text-[11px] text-muted-foreground">{c.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Program AI Agents">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              { name: "Nutrition Coach", role: "nutrition_coach" },
              { name: "Exercise Planner", role: "exercise_planner" },
              { name: "Sleep Advisor", role: "sleep_advisor" },
              { name: "Medication Reminder", role: "medication_reminder" },
              { name: "Motivation Coach", role: "motivation_coach" },
              { name: "Risk Explainer", role: "risk_explainer" },
              { name: "Habit Builder", role: "habit_builder" },
              { name: "Research Assistant", role: "research_assistant" },
            ].map((a) => (
              <div key={a.role} className="rounded-md border border-border/60 p-2.5">
                <div className="flex items-center gap-1.5">
                  <Bot className="h-3.5 w-3.5 text-[var(--brand)]" />
                  <span className="text-xs font-medium">{a.name}</span>
                </div>
                <Mono className="text-[10px] text-muted-foreground">{a.role}</Mono>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Workflow Engine">
        <p className="text-xs text-muted-foreground mb-3">Programs define multi-step workflows. The platform executes them step by step with real context propagation.</p>
        <div className="flex items-center gap-2 flex-wrap">
          {["initial_assessment", "generate_ai_plan", "book_technician", "collect_measurements", "update_score", "generate_missions", "notify_participant", "evaluate_progress", "adapt_plan", "knowledge_retrieval", "ai_execution", "conditional_branch", "wait", "parallel"].map((step, i) => (
            <div key={step} className="flex items-center gap-1">
              <Badge variant="outline" className="text-[10px] font-mono">{step}</Badge>
              {i < 13 && <span className="text-muted-foreground text-xs">→</span>}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="AI Observability">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {[
            { metric: "Execution Time", desc: "Latency per request" },
            { metric: "Token Usage", desc: "Prompt + completion tokens" },
            { metric: "Cost", desc: "Per-model cost tracking" },
            { metric: "Failure Rates", desc: "By provider, by model" },
            { metric: "Prompt Versions", desc: "Which versions are used" },
            { metric: "Tool Usage", desc: "Which tools are called" },
            { metric: "Safety Interventions", desc: "Blocked requests" },
            { metric: "Recommendation Acceptance", desc: "User adoption rate" },
            { metric: "Mission Completion", desc: "AI-generated mission success" },
            { metric: "p95 Latency", desc: "Nearest-rank percentile" },
          ].map((o) => (
            <div key={o.metric} className="rounded-md border border-border/40 p-2.5">
              <p className="text-xs font-medium">{o.metric}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{o.desc}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Provider Neutrality">
        <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-3">
          <div className="flex items-start gap-2">
            <Zap className="h-4 w-4 text-[var(--brand)] mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-[var(--brand)]">No provider is hardcoded</p>
              <p className="text-xs text-muted-foreground mt-1">
                The AI runtime uses a provider abstraction. Register any provider (OpenAI, Anthropic, z-ai-web-dev-sdk, local models) via the adapter interface.
                If no provider is configured, requests return a structured "provider_not_configured" response — never fake output.
                Fallback models, streaming, cost tracking, and observability work identically across providers.
              </p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function CheckCircle({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
