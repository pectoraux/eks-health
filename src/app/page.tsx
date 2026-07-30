"use client";

import { useState } from "react";
import { usePlatformSnapshot } from "@/hooks/use-platform";
import { Sidebar } from "@/components/console/sidebar";
import { OverviewSection } from "@/components/console/sections/overview";
import { KernelSection } from "@/components/console/sections/kernel";
import { AccountsSection } from "@/components/console/sections/accounts";
import { AuthSection } from "@/components/console/sections/auth";
import { SessionsSection } from "@/components/console/sections/sessions";
import { OrgsSection } from "@/components/console/sections/orgs";
import { RolesSection } from "@/components/console/sections/roles";
import { AuthorizationSection } from "@/components/console/sections/authorization";
import { ConsentSection } from "@/components/console/sections/consent";
import { AuditSection } from "@/components/console/sections/audit";
import { MonitoringSection } from "@/components/console/sections/monitoring";
import { ComplianceSection } from "@/components/console/sections/compliance";
import { ArchitectureSection } from "@/components/console/sections/architecture";
import { ProgramsSection } from "@/components/console/sections/programs";
import { ProgramDetailSection } from "@/components/console/sections/program-detail";
import { MarketplaceSection } from "@/components/console/sections/marketplace";
import { CertificationSection } from "@/components/console/sections/certification";
import { SdkSection } from "@/components/console/sections/sdk";
import { HealthOverviewSection } from "@/components/console/sections/health-overview";
import { SchemasSection } from "@/components/console/sections/schemas";
import { MeasurementsSection } from "@/components/console/sections/measurements";
import { TimelineSection } from "@/components/console/sections/timeline";
import { TechniciansSection } from "@/components/console/sections/technicians";
import { SessionsSection as IdentitySessionsSection } from "@/components/console/sections/sessions";
import { ReputationSection } from "@/components/console/sections/reputation";
import { TechSessionsSection } from "@/components/console/sections/tech-sessions";
import { ConsoleFooter } from "@/components/console/footer";

export type ConsoleSection =
  | "overview"
  | "kernel"
  | "architecture"
  | "accounts"
  | "auth"
  | "sessions"
  | "orgs"
  | "roles"
  | "authorization"
  | "consent"
  | "audit"
  | "monitoring"
  | "compliance"
  | "programs"
  | "program-detail"
  | "marketplace"
  | "certification"
  | "sdk"
  | "health"
  | "schemas"
  | "measurements"
  | "timeline"
  | "technicians"
  | "tech-sessions"
  | "reputation";

export default function Home() {
  const [section, setSection] = useState<ConsoleSection>("overview");
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const { data, loading, error, refresh } = usePlatformSnapshot();

  const selectProgram = (id: string) => {
    setSelectedProgramId(id);
    setSection("program-detail");
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex flex-1 min-h-0">
        <Sidebar section={section} onSelect={setSection} />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
            {loading && !data ? (
              <ConsoleLoading />
            ) : error ? (
              <ConsoleError error={error} onRetry={refresh} />
            ) : data ? (
              <SectionRouter
                section={section}
                data={data}
                refresh={refresh}
                selectedProgramId={selectedProgramId}
                onSelectProgram={selectProgram}
              />
            ) : null}
          </div>
        </main>
      </div>
      <ConsoleFooter snapshot={data} />
    </div>
  );
}

function SectionRouter({
  section,
  data,
  refresh,
  selectedProgramId,
  onSelectProgram,
}: {
  section: ConsoleSection;
  data: NonNullable<ReturnType<typeof usePlatformSnapshot>["data"]>;
  refresh: () => void;
  selectedProgramId: string | null;
  onSelectProgram: (id: string) => void;
}) {
  switch (section) {
    case "overview":
      return <OverviewSection data={data} />;
    case "kernel":
      return <KernelSection data={data} />;
    case "architecture":
      return <ArchitectureSection data={data} />;
    case "accounts":
      return <AccountsSection data={data} onRefresh={refresh} />;
    case "auth":
      return <AuthSection data={data} onRefresh={refresh} />;
    case "sessions":
      return <IdentitySessionsSection data={data} onRefresh={refresh} />;
    case "orgs":
      return <OrgsSection data={data} onRefresh={refresh} />;
    case "roles":
      return <RolesSection data={data} onRefresh={refresh} />;
    case "authorization":
      return <AuthorizationSection data={data} />;
    case "consent":
      return <ConsentSection data={data} />;
    case "audit":
      return <AuditSection data={data} />;
    case "monitoring":
      return <MonitoringSection data={data} onRefresh={refresh} />;
    case "compliance":
      return <ComplianceSection data={data} />;
    case "programs":
      return <ProgramsSection data={data} onRefresh={refresh} onSelectProgram={onSelectProgram} />;
    case "program-detail":
      return <ProgramDetailSection data={data} onRefresh={refresh} programId={selectedProgramId} onBack={() => onSelectProgramBack()} />;
    case "marketplace":
      return <MarketplaceSection data={data} />;
    case "certification":
      return <CertificationSection data={data} onRefresh={refresh} />;
    case "sdk":
      return <SdkSection data={data} />;
    case "health":
      return <HealthOverviewSection data={data} />;
    case "schemas":
      return <SchemasSection data={data} />;
    case "measurements":
      return <MeasurementsSection data={data} onRefresh={refresh} />;
    case "timeline":
      return <TimelineSection data={data} />;
    case "technicians":
      return <TechniciansSection data={data} onRefresh={refresh} />;
    case "tech-sessions":
      return <TechSessionsSection data={data} />;
    case "reputation":
      return <ReputationSection data={data} />;
  }

  function onSelectProgramBack() {
    refresh();
    // navigate back via the sidebar — handled by parent state
  }
}

function ConsoleLoading() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <div className="h-10 w-10 rounded-full border-2 border-muted border-t-foreground animate-spin" />
      <p className="text-sm text-muted-foreground font-mono">Booting Eks-Health Platform Kernel…</p>
    </div>
  );
}

function ConsoleError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center text-destructive text-xl">!</div>
      <div>
        <p className="font-medium">Platform failed to boot</p>
        <p className="text-sm text-muted-foreground mt-1 font-mono">{error}</p>
      </div>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
      >
        Retry
      </button>
    </div>
  );
}
