"use client";

import {
  LayoutDashboard,
  Boxes,
  Network,
  Users,
  KeyRound,
  MonitorSmartphone,
  Building2,
  ShieldCheck,
  Scale,
  FileLock2,
  Activity,
  ClipboardCheck,
  HeartPulse,
  Package,
  Store,
  BadgeCheck,
  Code2,
  Moon,
  Sun,
} from "lucide-react";
import type { ConsoleSection } from "@/app/page";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

interface NavItem {
  id: ConsoleSection;
  label: string;
  icon: typeof LayoutDashboard;
  group: string;
}

const NAV: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, group: "Platform" },
  { id: "kernel", label: "Kernel", icon: Boxes, group: "Platform" },
  { id: "architecture", label: "Architecture", icon: Network, group: "Platform" },
  { id: "accounts", label: "Accounts", icon: Users, group: "Identity" },
  { id: "auth", label: "Authentication", icon: KeyRound, group: "Identity" },
  { id: "sessions", label: "Sessions", icon: MonitorSmartphone, group: "Identity" },
  { id: "orgs", label: "Organizations", icon: Building2, group: "Identity" },
  { id: "roles", label: "Roles & Permissions", icon: ShieldCheck, group: "Identity" },
  { id: "authorization", label: "Authorization", icon: Scale, group: "Identity" },
  { id: "consent", label: "Consent", icon: FileLock2, group: "Identity" },
  { id: "audit", label: "Audit Trail", icon: ClipboardCheck, group: "Security" },
  { id: "monitoring", label: "Security Monitoring", icon: Activity, group: "Security" },
  { id: "compliance", label: "Compliance", icon: ShieldCheck, group: "Security" },
  { id: "programs", label: "Programs", icon: Package, group: "Program OS" },
  { id: "marketplace", label: "Marketplace", icon: Store, group: "Program OS" },
  { id: "certification", label: "Certification", icon: BadgeCheck, group: "Program OS" },
  { id: "sdk", label: "Developer SDK", icon: Code2, group: "Program OS" },
];

export function Sidebar({
  section,
  onSelect,
}: {
  section: ConsoleSection;
  onSelect: (s: ConsoleSection) => void;
}) {
  const { theme, setTheme } = useTheme();
  // Avoid hydration mismatch: render a stable label until mounted.
  const isDark = typeof window !== "undefined" ? theme === "dark" : true;
  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/50 backdrop-blur-sm sticky top-0 h-screen">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]">
          <HeartPulse className="h-5 w-5" />
        </div>
        <div className="flex flex-col leading-none">
          <span className="font-semibold text-sm tracking-tight">Eks-Health</span>
          <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Platform OS</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto eks-scroll px-3 py-4 space-y-5">
        {groups.map((group) => (
          <div key={group} className="space-y-1">
            <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </p>
            {NAV.filter((n) => n.group === group).map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left ${
                    active
                      ? "bg-[var(--brand)] text-[var(--brand-foreground)]"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          <span className="ml-2.5">{isDark ? "Light" : "Dark"} mode</span>
        </Button>
      </div>
    </aside>
  );
}
