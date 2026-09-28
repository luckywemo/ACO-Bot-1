import type { ExecutionTrace, LatencyBreakdown } from "@aco/database";

export const now = (): number => Date.now();

function diff(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
}

/**
 * Derive the per-stage latency breakdown from raw timestamps.
 *   detection    = event observed -> validation began
 *   validation   = validation window
 *   tx_build     = mint-tx request -> response (OpenSea API latency)
 *   simulation   = eth_call preflight
 *   signing      = local signing
 *   broadcast    = raw tx submission -> hash received
 *   confirmation = broadcast -> receipt
 *   total        = event observed -> terminal state
 */
export function computeLatencies(t: ExecutionTrace): LatencyBreakdown {
  const end =
    t.confirmation_received_at ??
    t.broadcast_completed_at ??
    t.signed_at ??
    t.transaction_received_at ??
    t.validation_completed_at;
  const out: LatencyBreakdown = {};
  const set = (k: keyof LatencyBreakdown, v: number | undefined) => {
    if (v !== undefined) out[k] = Math.round(v);
  };
  set("detection_ms", diff(t.event_detected_at, t.validation_started_at));
  set("validation_ms", diff(t.validation_started_at, t.validation_completed_at));
  set("tx_build_ms", diff(t.transaction_requested_at, t.transaction_received_at));
  set(
    "simulation_ms",
    diff(t.transaction_received_at, t.simulation_completed_at),
  );
  set("signing_ms", diff(t.sign_started_at, t.signed_at));
  set("broadcast_ms", diff(t.broadcast_started_at, t.broadcast_completed_at));
  set(
    "confirmation_ms",
    diff(t.broadcast_completed_at, t.confirmation_received_at),
  );
  set("total_ms", diff(t.event_detected_at, end));
  return out;
}
