/**
 * Eks-Health Program OS — Program Dependencies
 *
 * Programs depend on SDK versions, shared libraries, other capabilities,
 * and future shared components. This module supports: dependency resolution,
 * version constraints, conflict detection, upgrade planning, and cycle
 * detection.
 *
 * Includes a real semver range parser supporting: ^, ~, >=, >, <=, <, =,
 * exact, *, compound AND (space-separated), and OR (||).
 */

import "server-only";
import {
  type ProgramId,
  type SemVer,
  ProgramError,
  parseSemVer,
  compareSemVer,
  semVerToString,
} from "../core";
import type { ProgramManifest, ProgramDependency } from "../manifests";
import { getRegistry } from "../lifecycle";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export type ConstraintOperator =
  | "^"
  | "~"
  | ">="
  | ">"
  | "<="
  | "<"
  | "="
  | "*";

export interface VersionConstraint {
  readonly operator: ConstraintOperator;
  readonly version?: SemVer;
}

export interface DependencyNode {
  readonly id: string; // name@version
  readonly name: string;
  readonly version: string;
  readonly type: "sdk" | "library" | "program" | "capability";
  readonly depth: number;
  readonly source: "manifest" | "transitive";
}

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly constraint: string;
}

export interface DependencyGraph {
  readonly nodes: DependencyNode[];
  readonly edges: DependencyEdge[];
  readonly cycles: string[][];
}

export type ConflictType =
  | "missing"
  | "version_conflict"
  | "cycle"
  | "unknown_library"
  | "unknown_sdk";

export interface ConflictReport {
  readonly type: ConflictType;
  readonly message: string;
  readonly dependencyName?: string;
  readonly requestedRange?: string;
  readonly availableVersions?: string[];
}

export interface ResolutionResult {
  readonly resolved: DependencyNode[];
  readonly graph: DependencyGraph;
  readonly conflicts: ConflictReport[];
  readonly warnings: string[];
  readonly rootProgramId?: ProgramId;
}

export interface LibraryVersion {
  readonly version: SemVer;
  readonly deprecated?: boolean;
  readonly dependencies?: ProgramDependency[];
  readonly notes?: string;
}

export interface SharedLibrary {
  readonly name: string;
  readonly description: string;
  readonly versions: LibraryVersion[];
}

export interface UpgradeStep {
  readonly dependency: string;
  readonly from?: string;
  readonly to: string;
  readonly breaking: boolean;
  readonly reason: string;
}

export interface UpgradePlan {
  readonly programId: ProgramId;
  readonly targetSdkVersion: SemVer;
  readonly steps: UpgradeStep[];
  readonly breakingChanges: string[];
  readonly migrationPath: string[];
  readonly feasible: boolean;
}

// ---------------------------------------------------------------------------
// Semver range parser + satisfaction checker
// ---------------------------------------------------------------------------

/**
 * Parse a range string into OR groups of AND constraints.
 * Examples:
 *   "^1.2.3"               → [[{^,1.2.3}]]
 *   ">=1.0.0 <2.0.0"       → [[{>=,1.0.0},{<,2.0.0}]]
 *   "1.0.0 || 2.0.0"       → [[{=,1.0.0}],[{=,2.0.0}]]
 *   "*"                    → [[{*,}]]
 */
export function parseRange(range: string): VersionConstraint[][] {
  const trimmed = range.trim();
  if (trimmed === "") throw new ProgramError({
    code: "eks.program.dependencies.empty_range",
    category: "validation",
    message: "Empty version range.",
    userMessage: "Invalid dependency range.",
  });
  const orGroups = trimmed.split("||").map((g) => g.trim());
  return orGroups.map((g) => {
    if (g === "*") return [{ operator: "*" as ConstraintOperator }];
    const parts = g.split(/\s+/).filter(Boolean);
    return parts.map((p) => parseConstraint(p));
  });
}

function parseConstraint(c: string): VersionConstraint {
  if (c === "*") return { operator: "*" };
  const m = c.match(/^(\^|~|>=|>|<=|<|=)?(.+)$/);
  if (!m) {
    throw new ProgramError({
      code: "eks.program.dependencies.invalid_constraint",
      category: "validation",
      message: `Invalid version constraint: ${c}`,
      userMessage: "Invalid dependency constraint.",
    });
  }
  const op = (m[1] || "=") as ConstraintOperator;
  const version = parseSemVer(m[2]);
  return { operator: op, version };
}

/**
 * Check if a version satisfies a constraint.
 */
function satisfiesConstraint(version: SemVer, c: VersionConstraint): boolean {
  if (c.operator === "*") return true;
  if (!c.version) return false;
  const cmp = compareSemVer(version, c.version);
  switch (c.operator) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "^": {
      // Compatible-with: same major, >= version, < (major+1).0.0
      // Special: ^0.x.y → >=0.x.y <0.(x+1).0
      // Special: ^0.0.z → >=0.0.z <0.0.(z+1)
      if (cmp < 0) return false;
      if (c.version.major > 0) {
        return version.major === c.version.major;
      }
      if (c.version.minor > 0) {
        return (
          version.major === 0 && version.minor === c.version.minor
        );
      }
      return (
        version.major === 0 &&
        version.minor === 0 &&
        version.patch === c.version.patch
      );
    }
    case "~": {
      // Patch-level: same major.minor, >= version, < major.(minor+1).0
      if (cmp < 0) return false;
      return (
        version.major === c.version.major &&
        version.minor === c.version.minor
      );
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

function detectCycles(
  nodeIds: string[],
  edges: DependencyEdge[],
): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
    if (!adj.has(e.to)) adj.set(e.to, []);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (onStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    onStack.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      dfs(next);
    }
    path.pop();
    onStack.delete(node);
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) dfs(id);
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Shared library catalog
// ---------------------------------------------------------------------------

const DEFAULT_LIBRARIES: SharedLibrary[] = [
  {
    name: "eks-program-sdk",
    description: "The official Eks-Health Program SDK.",
    versions: [
      { version: parseSemVer("1.0.0"), notes: "Stable release." },
      { version: parseSemVer("1.1.0"), notes: "Added AI prompt API." },
      { version: parseSemVer("2.0.0"), notes: "Breaking: new capability model.", dependencies: [] },
    ],
  },
  {
    name: "eks-ui-kit",
    description: "Shared UI components for program dashboards.",
    versions: [
      {
        version: parseSemVer("1.0.0"),
        dependencies: [{ name: "eks-i18n-pack", versionRange: "^1.0.0", type: "library" }],
      },
      {
        version: parseSemVer("1.1.0"),
        dependencies: [{ name: "eks-i18n-pack", versionRange: "^1.0.0", type: "library" }],
      },
      {
        version: parseSemVer("2.0.0"),
        notes: "Breaking: redesign.",
        dependencies: [{ name: "eks-i18n-pack", versionRange: "^1.0.0", type: "library" }],
      },
    ],
  },
  {
    name: "eks-data-utils",
    description: "Data transformation utilities for program metrics.",
    versions: [{ version: parseSemVer("1.0.0") }],
  },
  {
    name: "eks-chart-lib",
    description: "Charting library for health visualizations.",
    versions: [
      {
        version: parseSemVer("1.2.0"),
        dependencies: [{ name: "eks-ui-kit", versionRange: "^1.0.0", type: "library" }],
      },
      {
        version: parseSemVer("1.3.0"),
        dependencies: [{ name: "eks-ui-kit", versionRange: "^1.0.0", type: "library" }],
      },
    ],
  },
  {
    name: "eks-i18n-pack",
    description: "Internationalization translation packs.",
    versions: [{ version: parseSemVer("1.0.0") }],
  },
  {
    name: "eks-analytics-sdk",
    description: "Analytics SDK for program event tracking.",
    versions: [
      {
        version: parseSemVer("2.0.0"),
        dependencies: [{ name: "eks-data-utils", versionRange: "^1.0.0", type: "library" }],
      },
    ],
  },
  {
    name: "eks-ai-tools",
    description: "AI prompt engineering and chain-of-thought utilities.",
    versions: [
      {
        version: parseSemVer("0.9.0"),
        dependencies: [{ name: "eks-data-utils", versionRange: "^1.0.0", type: "library" }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Dependency Manager
// ---------------------------------------------------------------------------

export class DependencyManager {
  private readonly libraries = new Map<string, SharedLibrary>();

  constructor() {
    for (const lib of DEFAULT_LIBRARIES) {
      this.libraries.set(lib.name, lib);
    }
  }

  // ---- Library management ----------------------------------------------

  registerLibrary(lib: SharedLibrary): void {
    if (this.libraries.has(lib.name)) {
      throw new ProgramError({
        code: "eks.program.dependencies.library.duplicate",
        category: "validation",
        message: `Library ${lib.name} already registered.`,
        userMessage: "Library already exists.",
      });
    }
    this.libraries.set(lib.name, lib);
  }

  listLibraries(): readonly SharedLibrary[] {
    return [...this.libraries.values()];
  }

  getLibrary(name: string): SharedLibrary | undefined {
    return this.libraries.get(name);
  }

  // ---- Satisfaction check ----------------------------------------------

  /**
   * Check if a version satisfies a range string.
   * Supports ^, ~, >=, >, <=, <, =, exact, *, compound AND, OR.
   */
  satisfies(version: SemVer | string, range: string): boolean {
    const v = typeof version === "string" ? parseSemVer(version) : version;
    try {
      const groups = parseRange(range);
      return groups.every((group) => group.length > 0) &&
        groups.some((group) => group.every((c) => satisfiesConstraint(v, c)));
    } catch {
      return false;
    }
  }

  // ---- Resolution ------------------------------------------------------

  resolve(manifest: ProgramManifest): ResolutionResult {
    const resolved: DependencyNode[] = [];
    const edges: DependencyEdge[] = [];
    const conflicts: ConflictReport[] = [];
    const warnings: string[] = [];
    const seen = new Map<string, DependencyNode>(); // name → node
    const nodeIds = new Set<string>();

    // BFS queue: { dep, depth, parentId }
    const queue: {
      dep: ProgramDependency;
      depth: number;
      parentId?: string;
      source: "manifest" | "transitive";
    }[] = (manifest.dependencies ?? []).map((d) => ({
      dep: d,
      depth: 0,
      source: "manifest" as const,
    }));

    const rootId = `program:${manifest.id}`;
    nodeIds.add(rootId);

    // Add edges from root → manifest deps (handled in the BFS loop below)

    while (queue.length > 0) {
      const item = queue.shift()!;
      const { dep, depth, parentId, source } = item;

      // For SDK deps, look up the SDK library
      const lookupName = dep.type === "sdk" ? "eks-program-sdk" : dep.name;
      const lib = this.libraries.get(lookupName);
      if (!lib) {
        conflicts.push({
          type: dep.type === "sdk" ? "unknown_sdk" : "unknown_library",
          message: `Unknown ${dep.type} dependency: ${dep.name}`,
          dependencyName: dep.name,
          requestedRange: dep.versionRange,
        });
        continue;
      }

      // Find matching versions
      const matching = lib.versions.filter((v) =>
        this.satisfies(v.version, dep.versionRange),
      );
      if (matching.length === 0) {
        conflicts.push({
          type: "version_conflict",
          message: `No version of ${dep.name} satisfies ${dep.versionRange}`,
          dependencyName: dep.name,
          requestedRange: dep.versionRange,
          availableVersions: lib.versions.map((v) => semVerToString(v.version)),
        });
        continue;
      }

      // Pick the highest matching version
      const chosen = matching.reduce((best, v) =>
        compareSemVer(v.version, best.version) > 0 ? v : best,
      );
      const chosenVersionStr = semVerToString(chosen.version);
      const nodeId = `${dep.name}@${chosenVersionStr}`;

      if (chosen.deprecated) {
        warnings.push(`${dep.name}@${chosenVersionStr} is deprecated.`);
      }

      const existing = seen.get(dep.name);
      if (existing) {
        // Already resolved — check compatibility
        if (existing.version !== chosenVersionStr) {
          warnings.push(
            `Version conflict for ${dep.name}: resolved ${existing.version} but ${dep.versionRange} also matches ${chosenVersionStr}`,
          );
        }
        if (parentId) {
          edges.push({ from: parentId, to: existing.id, constraint: dep.versionRange });
        }
        continue;
      }

      const node: DependencyNode = {
        id: nodeId,
        name: dep.name,
        version: chosenVersionStr,
        type: dep.type,
        depth,
        source,
      };
      seen.set(dep.name, node);
      resolved.push(node);
      nodeIds.add(nodeId);

      // Edge from parent (or root for manifest deps)
      if (parentId) {
        edges.push({ from: parentId, to: nodeId, constraint: dep.versionRange });
      } else {
        edges.push({ from: rootId, to: nodeId, constraint: dep.versionRange });
      }

      // Enqueue transitive dependencies
      if (chosen.dependencies) {
        for (const tdep of chosen.dependencies) {
          queue.push({
            dep: tdep,
            depth: depth + 1,
            parentId: nodeId,
            source: "transitive",
          });
        }
      }
    }

    // Detect cycles (in resolved subgraph + root)
    const allNodeIds = [rootId, ...resolved.map((n) => n.id)];
    const cycles = detectCycles(allNodeIds, edges);
    for (const cycle of cycles) {
      conflicts.push({
        type: "cycle",
        message: `Dependency cycle detected: ${cycle.join(" → ")}`,
      });
    }

    return {
      resolved,
      graph: { nodes: resolved, edges, cycles },
      conflicts,
      warnings,
      rootProgramId: manifest.id,
    };
  }

  // ---- Conflict detection between two programs -------------------------

  detectConflicts(
    manifestA: ProgramManifest,
    manifestB: ProgramManifest,
  ): ConflictReport[] {
    const conflicts: ConflictReport[] = [];
    const resA = this.resolve(manifestA);
    const resB = this.resolve(manifestB);

    // Only consider resolved deps (ignore unresolved conflicts from individual runs)
    const mapA = new Map(resA.resolved.map((n) => [n.name, n.version]));
    const mapB = new Map(resB.resolved.map((n) => [n.name, n.version]));

    const allNames = new Set([...mapA.keys(), ...mapB.keys()]);
    for (const name of allNames) {
      const va = mapA.get(name);
      const vb = mapB.get(name);
      if (va && vb && va !== vb) {
        // Check if versions are semver-compatible (same major)
        const sa = parseSemVer(va);
        const sb = parseSemVer(vb);
        if (sa.major !== sb.major) {
          conflicts.push({
            type: "version_conflict",
            message: `${name}: program A requires ${va}, program B requires ${vb} — incompatible major versions`,
            dependencyName: name,
            requestedRange: `${va} vs ${vb}`,
            availableVersions: [va, vb],
          });
        }
      }
    }

    // Also surface any cycles from either resolution
    for (const c of resA.conflicts) {
      if (c.type === "cycle") conflicts.push(c);
    }
    for (const c of resB.conflicts) {
      if (c.type === "cycle") conflicts.push(c);
    }

    return conflicts;
  }

  // ---- Upgrade planning ------------------------------------------------

  planUpgrade(programId: ProgramId, targetSdkVersion: SemVer): UpgradePlan {
    const registry = getRegistry();
    const record = registry.get(programId);
    if (!record) {
      throw new ProgramError({
        code: "eks.program.dependencies.program_not_found",
        category: "not_found",
        message: `Program ${programId} not found in registry.`,
        userMessage: "Program not found.",
      });
    }

    const currentVersion = record.versions.find(
      (v) => v.id === record.currentVersionId,
    );
    const manifest = currentVersion?.manifest;
    if (!manifest) {
      throw new ProgramError({
        code: "eks.program.dependencies.no_current_version",
        category: "not_found",
        message: `Program ${programId} has no current version.`,
        userMessage: "Program has no current version.",
      });
    }

    const steps: UpgradeStep[] = [];
    const breakingChanges: string[] = [];
    const migrationPath: string[] = [];
    let feasible = true;

    // Check SDK upgrade
    const currentSdk = manifest.sdkVersion;
    const sdkCmp = compareSemVer(targetSdkVersion, currentSdk);
    if (sdkCmp !== 0) {
      const breaking = targetSdkVersion.major !== currentSdk.major;
      steps.push({
        dependency: "eks-program-sdk",
        from: semVerToString(currentSdk),
        to: semVerToString(targetSdkVersion),
        breaking,
        reason: breaking
          ? "Major version bump — breaking API changes likely"
          : "Compatible upgrade within same major",
      });
      if (breaking) {
        breakingChanges.push(
          `SDK ${semVerToString(currentSdk)} → ${semVerToString(targetSdkVersion)} is a major bump`,
        );
        migrationPath.push("Review breaking SDK changes in the migration guide");
        // Check if target SDK version exists
        const sdkLib = this.libraries.get("eks-program-sdk");
        if (sdkLib && !sdkLib.versions.some((v) => compareSemVer(v.version, targetSdkVersion) === 0)) {
          feasible = false;
          breakingChanges.push(`Target SDK version ${semVerToString(targetSdkVersion)} is not yet released`);
        }
      }
    }

    // Check each dependency against the target SDK
    for (const dep of manifest.dependencies ?? []) {
      if (dep.type === "sdk") continue; // already handled
      const lib = this.libraries.get(dep.name);
      if (!lib) {
        steps.push({
          dependency: dep.name,
          to: "unknown",
          breaking: true,
          reason: "Library not in catalog — manual verification required",
        });
        feasible = false;
        continue;
      }

      // Find a version compatible with the target SDK
      // (For now, pick the latest version that satisfies the declared range)
      const matching = lib.versions.filter((v) =>
        this.satisfies(v.version, dep.versionRange),
      );
      if (matching.length === 0) {
        // Try latest version
        const latest = lib.versions.reduce((best, v) =>
          compareSemVer(v.version, best.version) > 0 ? v : best,
        );
        const breaking = latest.version.major > (matching[0]?.version.major ?? 0);
        steps.push({
          dependency: dep.name,
          from: dep.versionRange,
          to: semVerToString(latest.version),
          breaking,
          reason: "No version satisfies the declared range — recommend upgrade to latest",
        });
        if (breaking) {
          breakingChanges.push(`${dep.name} requires a major upgrade`);
        }
      }
    }

    migrationPath.push("Update SDK version in manifest");
    migrationPath.push("Run contract tests (eks test --category contract)");
    migrationPath.push("Run certification pipeline (eks certify)");
    if (breakingChanges.length > 0) {
      migrationPath.push("Notify users of breaking changes and request re-consent");
    }

    return {
      programId,
      targetSdkVersion,
      steps,
      breakingChanges,
      migrationPath,
      feasible,
    };
  }

  // ---- Constraint parsing (public) ------------------------------------

  parseConstraint(range: string): VersionConstraint[][] {
    return parseRange(range);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: DependencyManager | null = null;
export function getDependencies(): DependencyManager {
  if (!_mgr) _mgr = new DependencyManager();
  return _mgr;
}

export function resetDependencies(): void {
  _mgr = null;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type { ProgramId, SemVer } from "../core";
export type { ProgramManifest, ProgramDependency } from "../manifests";
