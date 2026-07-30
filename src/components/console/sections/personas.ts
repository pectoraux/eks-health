export const PERSONAS = [
  { persona: "participant", label: "Participant", description: "Tracks their own preventive health.", defaultPermissions: ["self:read", "self:write", "consent:manage"], sensitive: false },
  { persona: "health_technician", label: "Health Technician", description: "Collects measurements for participants.", defaultPermissions: ["measurement:collect", "participant:limited:read"], sensitive: true },
  { persona: "developer", label: "Developer", description: "Builds Programs & extensions.", defaultPermissions: ["developer:console", "extension:create"], sensitive: false },
  { persona: "researcher", label: "Researcher", description: "Requests de-identified data.", defaultPermissions: ["research:request", "research:dataset:read"], sensitive: true },
  { persona: "org_admin", label: "Org Administrator", description: "Manages an organization.", defaultPermissions: ["org:manage", "org:members:manage"], sensitive: true },
  { persona: "platform_admin", label: "Platform Administrator", description: "Operates the platform.", defaultPermissions: ["platform:*"], sensitive: true },
  { persona: "marketplace_reviewer", label: "Marketplace Reviewer", description: "Reviews Program listings.", defaultPermissions: ["marketplace:review", "marketplace:approve"], sensitive: true },
  { persona: "support_agent", label: "Support Agent", description: "Assists users with access issues.", defaultPermissions: ["support:ticket:read", "support:ticket:respond"], sensitive: true },
] as const;
