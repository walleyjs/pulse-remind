import type { EvaluationResult } from './types.ts';

export interface ConsensusOutcome {
  confirmed: boolean;
  isFlapping: boolean;
  agreedState: boolean | null;
  confidence: number;
  reason: string;
}

/**
 * Anti-Flap Multi-Probe Consensus Verification
 * Prevents false alerts caused by transient CDN 502/503 blips, A/B test variations, or geo-IP maintenance.
 */
export function verifyProbeConsensus(
  primary: EvaluationResult,
  confirmation?: EvaluationResult | null
): ConsensusOutcome {
  if (!confirmation) {
    // If only one probe ran (e.g., unchanged closed state), single probe is accepted
    return {
      confirmed: true,
      isFlapping: false,
      agreedState: primary.isOpen,
      confidence: primary.confidence,
      reason: primary.summary
    };
  }

  // Both probes must agree on open vs closed state
  if (primary.isOpen === confirmation.isOpen) {
    const combinedConfidence = Math.min(0.99, (primary.confidence + confirmation.confidence) / 2 + 0.05);
    return {
      confirmed: true,
      isFlapping: false,
      agreedState: primary.isOpen,
      confidence: combinedConfidence,
      reason: `Consensus verified (probe 1=${primary.summary}, probe 2=${confirmation.summary})`
    };
  }

  // Discrepancy detected -> flapping state
  return {
    confirmed: false,
    isFlapping: true,
    agreedState: null,
    confidence: 0.5,
    reason: `Flapping state detected: probe 1 isOpen=${primary.isOpen} vs probe 2 isOpen=${confirmation.isOpen}. Suppressing alert.`
  };
}
