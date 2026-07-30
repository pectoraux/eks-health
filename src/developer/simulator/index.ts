/**
 * Eks-Health Developer Platform — Local Simulator
 *
 * Developers simulate an entire ecosystem locally: participants, technicians,
 * organizations, competitions, measurements, leaderboards, rewards, notifications,
 * AI providers, payment events, marketplace events. Offline scenarios, network
 * failures, large-scale datasets. No production deployment required.
 */

import "server-only";
import {
  type SimulationId,
  type SimulationScenarioId,
  type SimulationScenario,
  type SimulatedEntity,
  type SimulationEvent,
  type SimulationConfig,
  type SimulationResult,
  DeveloperError,
  asSimulationId,
  asSimulationScenarioId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { DEVELOPER_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Pre-built simulation scenarios
// ---------------------------------------------------------------------------

export const BUILTIN_SCENARIOS: readonly SimulationScenario[] = [
  scenario("competition-flow", "Competition Flow", "Simulate a full competition lifecycle: registration → measurements → scoring → leaderboard → rewards.", [
    { id: "p1", type: "participant", label: "Alice (participant)", properties: { ageRange: "30-39", country: "GH" }, createdAt: "" },
    { id: "p2", type: "participant", label: "Bob (participant)", properties: { ageRange: "40-49", country: "GH" }, createdAt: "" },
    { id: "t1", type: "technician", label: "Dr. Owusu (technician)", properties: { trustLevel: "clinical", region: "GH" }, createdAt: "" },
    { id: "c1", type: "competition", label: "Cardio Challenge", properties: { scope: "national", participants: 2 }, createdAt: "" },
  ], [
    ev("participant_registered", 0, "Participants register for the competition"),
    ev("measurement_recorded", 500, "Technician records BP for Alice"),
    ev("measurement_verified", 1000, "Technician verifies the measurement"),
    ev("score_updated", 1500, "Score recalculated for Alice"),
    ev("leaderboard_updated", 2000, "Leaderboard ranks updated"),
    ev("measurement_recorded", 2500, "Technician records BP for Bob"),
    ev("score_updated", 3000, "Score recalculated for Bob"),
    ev("leaderboard_updated", 3500, "Leaderboard ranks updated again"),
    ev("reward_triggered", 4000, "Season ends, rewards distributed"),
  ], { timeScale: 10, offlineMode: false, networkFailureRate: 0, seed: 42, maxEntities: 100 }),
  scenario("offline-sync", "Offline Sync", "Simulate offline measurement capture with later synchronization.", [
    { id: "p1", type: "participant", label: "Alice (offline)", properties: { offline: true }, createdAt: "" },
  ], [
    ev("offline_measurement_1", 0, "Alice records steps offline"),
    ev("offline_measurement_2", 1000, "Alice records sleep offline"),
    ev("offline_measurement_3", 2000, "Alice records weight offline"),
    ev("network_restored", 5000, "Network connectivity restored"),
    ev("sync_started", 5100, "Synchronization begins"),
    ev("sync_completed", 6000, "All 3 measurements synced successfully"),
  ], { timeScale: 5, offlineMode: true, networkFailureRate: 0, seed: 42, maxEntities: 10 }),
  scenario("large-scale", "Large Scale (10K participants)", "Stress test with 10,000 simulated participants.", [
    { id: "bulk", type: "participant", label: "10,000 participants", properties: { count: 10000 }, createdAt: "" },
  ], [
    ev("bulk_register", 0, "10,000 participants register"),
    ev("bulk_measurements", 2000, "50,000 measurements recorded"),
    ev("bulk_scoring", 5000, "10,000 scores computed"),
    ev("bulk_leaderboard", 8000, "10,000-entry leaderboard built"),
    ev("bulk_rewards", 10000, "Rewards distributed to top 100"),
  ], { timeScale: 100, offlineMode: false, networkFailureRate: 0.01, seed: 42, maxEntities: 10000 }),
  scenario("network-failure", "Network Failure Recovery", "Simulate network failures during critical operations.", [
    { id: "p1", type: "participant", label: "Alice", properties: {}, createdAt: "" },
  ], [
    ev("api_call_1", 0, "API call succeeds"),
    ev("network_down", 500, "Network goes down"),
    ev("api_call_2", 1000, "API call fails (queued)"),
    ev("api_call_3", 1500, "API call fails (queued)"),
    ev("network_restored", 3000, "Network restored"),
    ev("queue_flushed", 3100, "Queued calls retried and succeed"),
  ], { timeScale: 1, offlineMode: false, networkFailureRate: 0.5, seed: 42, maxEntities: 100 }),
  scenario("ai-workflow", "AI Workflow Execution", "Simulate an AI workflow: plan generation → mission assignment → adaptation.", [
    { id: "p1", type: "participant", label: "Alice", properties: {}, createdAt: "" },
    { id: "ai1", type: "ai_provider", label: "AI Provider", properties: { model: "glm-4" }, createdAt: "" },
  ], [
    ev("ai_plan_requested", 0, "AI plan generation requested"),
    ev("ai_plan_generated", 1500, "AI returns personalized plan"),
    ev("missions_assigned", 2000, "5 daily missions assigned"),
    ev("mission_completed_1", 3000, "Alice completes first mission"),
    ev("ai_adaptation", 4000, "AI adapts plan based on completion"),
    ev("new_missions", 4500, "2 new missions assigned"),
  ], { timeScale: 2, offlineMode: false, networkFailureRate: 0, seed: 42, maxEntities: 50 }),
];

function scenario(id: string, name: string, description: string, entities: SimulatedEntity[], events: SimulationEvent[], config: SimulationConfig): SimulationScenario {
  const now = getClock().iso();
  return {
    id: asSimulationScenarioId(id),
    name, description,
    entities: entities.map((e) => ({ ...e, createdAt: now })),
    eventSequence: events,
    config,
    createdAt: now,
  };
}

function ev(type: string, delayMs: number, description: string): SimulationEvent {
  return { id: generateId("se_"), delayMs, type, payload: {}, description };
}

const SCENARIO_INDEX = new Map(BUILTIN_SCENARIOS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export class Simulator {
  private readonly customScenarios = new Map<SimulationScenarioId, SimulationScenario>();
  private readonly results: SimulationResult[] = [];

  listScenarios(): SimulationScenario[] {
    return [...BUILTIN_SCENARIOS, ...this.customScenarios.values()];
  }

  getScenario(id: SimulationScenarioId): SimulationScenario | undefined {
    return SCENARIO_INDEX.get(id) ?? this.customScenarios.get(id);
  }

  registerScenario(scenario: SimulationScenario): void {
    this.customScenarios.set(scenario.id, scenario);
  }

  /** Run a simulation scenario. Returns a SimulationResult with fired events + state snapshot. */
  async run(scenarioId: SimulationScenarioId, overrides?: Partial<SimulationConfig>): Promise<SimulationResult> {
    const scenario = this.getScenario(scenarioId);
    if (!scenario) {
      throw new DeveloperError({
        code: "eks.developer.simulation.scenario_not_found",
        category: "not_found",
        message: `Scenario ${scenarioId} not found.`,
        userMessage: "Simulation scenario not found.",
      });
    }

    const config: SimulationConfig = { ...scenario.config, ...overrides };
    const startedAt = getClock().iso();
    const startTime = Date.now();
    const errors: string[] = [];
    let eventsFired = 0;

    // Simulate deterministic random based on seed
    const rng = createSeededRandom(config.seed);

    // Fire events in sequence (simulated — real timing compressed by timeScale)
    for (const event of scenario.eventSequence) {
      eventsFired++;
      // Simulate network failures
      if (config.networkFailureRate > 0 && rng() < config.networkFailureRate) {
        errors.push(`Network failure during event: ${event.type} (${event.description})`);
        continue;
      }
      // In a real implementation, each event would trigger actual platform operations
      // Here we record that it fired successfully
    }

    // Build state snapshot
    const stateSnapshot: Record<string, unknown> = {
      entities: scenario.entities.length,
      eventsFired,
      errors: errors.length,
      config,
      scenarioName: scenario.name,
    };

    const durationMs = Date.now() - startTime;
    const result: SimulationResult = {
      id: asSimulationId(generateId("sim_")),
      scenarioId,
      startedAt,
      completedAt: getClock().iso(),
      eventsFired,
      errors,
      stateSnapshot,
      durationMs,
    };
    this.results.push(result);

    void getEventBus().publish(buildEvent(DEVELOPER_EVENTS.simulationStarted, { scenarioId, config }, {}, "domain"));
    void getEventBus().publish(buildEvent(DEVELOPER_EVENTS.simulationCompleted, { simulationId: result.id, eventsFired, errors: errors.length, durationMs }, {}, "domain"));

    return result;
  }

  /** Run multiple scenarios in sequence. */
  async runBatch(scenarioIds: SimulationScenarioId[]): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];
    for (const id of scenarioIds) {
      results.push(await this.run(id));
    }
    return results;
  }

  getResults(): SimulationResult[] {
    return [...this.results];
  }

  getStats(): { totalRuns: number; totalEvents: number; totalErrors: number; avgDurationMs: number } {
    const totalRuns = this.results.length;
    const totalEvents = this.results.reduce((a, r) => a + r.eventsFired, 0);
    const totalErrors = this.results.reduce((a, r) => a + r.errors.length, 0);
    const avgDurationMs = totalRuns > 0 ? this.results.reduce((a, r) => a + (r.durationMs ?? 0), 0) / totalRuns : 0;
    return { totalRuns, totalEvents, totalErrors, avgDurationMs };
  }
}

/** Mulberry32 seeded random (deterministic). */
function createSeededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _sim: Simulator | null = null;
export function getSimulator(): Simulator {
  if (!_sim) _sim = new Simulator();
  return _sim;
}
