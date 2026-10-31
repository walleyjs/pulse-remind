import {
  calculateWilsonRatingConfidence,
  evaluateCommercePredicate,
  formatCurrencyAmount,
  type ExtractedCommerceState,
  type PredicateEvaluationResult
} from '../resolution/predicates.ts';
import {
  evaluateCandidateConformance,
  type ParsedDiscoveryIntent,
  type DestinationZone
} from './disambiguation.ts';
import type { DiscoveredCandidateListing, MerchantTier } from './provider.ts';

export interface RankedDealCandidate {
  listing: DiscoveredCandidateListing;
  promoSavings: number;
  landedPrice: number;
  effectiveShippingCost: number;
  referencePrice: number | null;
  savingsVsReference: number | null;
  dropPercentage: number | null;
  wilsonConfidence: number;
  similarityScore: number;
  meetsTargetPredicate: boolean;
  isParetoOptimal: boolean;
  compositeScore: number;
  predicateEvaluation: PredicateEvaluationResult;
  destinationZone?: DestinationZone;
  merchantTier?: MerchantTier;
}

export interface RejectedDealCandidate {
  listing: DiscoveredCandidateListing;
  stage: 'out_of_stock' | 'sku_disambiguation' | 'wilson_credibility' | 'merchant_fraud_guard';
  reason: string;
  wilsonConfidence?: number;
}

export interface DealRankingOutcome {
  rankedDeals: RankedDealCandidate[];
  immediateWinners: RankedDealCandidate[];
  rejectedCandidates: RejectedDealCandidate[];
}

/**
 * Evaluates all discovered merchant candidates through:
 * 1. Stock availability filter
 * 2. Total Landed Cost calculation (P_item + P_shipping - D_promo)
 * 3. SKU Disambiguation & Anti-Accessory conformance guard
 * 4. 95% Wilson Score Lower Bound credibility filter
 * 5. Pareto-Frontier optimality & multi-objective composite ranking
 */
export function rankDiscoveredCandidates(
  intent: ParsedDiscoveryIntent,
  candidates: DiscoveredCandidateListing[],
  options: { destinationZone?: DestinationZone } = {}
): DealRankingOutcome {
  const surviving: RankedDealCandidate[] = [];
  const rejectedCandidates: RejectedDealCandidate[] = [];

  const minWilson = intent.predicate.minRatingConfidence ?? 0.7;
  const minReviews = intent.predicate.minReviewCount ?? 10;
  const targetZone: DestinationZone = options.destinationZone || intent.destinationZone || 'lagos';

  const tierMultipliers: Record<MerchantTier, number> = {
    official_store: 1.05,
    platform_fulfilled: 1.0,
    vetted_3p: 0.85,
    unverified_classified: 0.25
  };

  for (const listing of candidates) {
    // 1. Out-of-stock guard
    if (!listing.inStock) {
      rejectedCandidates.push({
        listing,
        stage: 'out_of_stock',
        reason: 'Listing is currently out of stock'
      });
      continue;
    }

    // 2. Promo discount & Total Landed Cost with destination zone freight:
    // P_landed = P_item + P_shipping(zone) - D_promo
    let promoSavings = 0;
    let promoVerified = false;
    if (listing.promoCode) {
      if (listing.promoDiscountPercent && listing.promoDiscountPercent > 0) {
        promoSavings += (listing.price * listing.promoDiscountPercent) / 100;
        promoVerified = true;
      }
      if (listing.promoDiscountAmount && listing.promoDiscountAmount > 0) {
        promoSavings += listing.promoDiscountAmount;
        promoVerified = true;
      }
    }
    promoSavings = Number(promoSavings.toFixed(2));

    const effectiveShippingCost = listing.shippingByZone
      ? (listing.shippingByZone[targetZone] ?? listing.shippingCost)
      : (listing.shippingCost || 0);

    const landedPrice = Number(
      Math.max(0, listing.price + effectiveShippingCost - promoSavings).toFixed(2)
    );

    // 3. SKU Disambiguation, Anti-Accessory & Condition Conformance (UK Used / Tokunbo Guard)
    const conformance = evaluateCandidateConformance(intent, listing.title, landedPrice, listing.condition);
    if (!conformance.conformant) {
      rejectedCandidates.push({
        listing,
        stage: 'sku_disambiguation',
        reason: conformance.rejectionReason || 'SKU mismatch'
      });
      continue;
    }

    // 4. High-Ticket Unverified Classifieds Fraud Guard (> ₦50,000 / > $50)
    const highTicketThreshold = listing.currency === 'NGN' ? 50000 : 50;
    if (listing.merchantTier === 'unverified_classified' && landedPrice > highTicketThreshold) {
      rejectedCandidates.push({
        listing,
        stage: 'merchant_fraud_guard',
        reason: `High-ticket fraud guard: unverified classified listing (${formatCurrencyAmount(landedPrice, listing.currency)}) exceeds safe threshold ${formatCurrencyAmount(highTicketThreshold, listing.currency)}`
      });
      continue;
    }

    // 5. Statistical Seller/Product Rating Credibility weighted by Merchant Tier
    const tier = listing.merchantTier;
    const tierMultipliers: Record<MerchantTier, number> = {
      official_store: 1.05,
      platform_fulfilled: 1.0,
      vetted_3p: 0.95,
      unverified_classified: 0.25
    };
    const tierWeight = tier ? (tierMultipliers[tier] ?? 1.0) : 1.0;

    const baseWilson =
      listing.rating !== null && listing.reviewCount !== null
        ? calculateWilsonRatingConfidence(listing.rating, listing.reviewCount, 5.0)
        : 0;

    const weightedWilson = Number(Math.min(1.0, Math.max(0.0, baseWilson * tierWeight)).toFixed(4));

    if ((listing.reviewCount ?? 0) < minReviews || weightedWilson < minWilson) {
      rejectedCandidates.push({
        listing,
        stage: 'wilson_credibility',
        wilsonConfidence: weightedWilson,
        reason:
          (listing.reviewCount ?? 0) < minReviews
            ? `Unverified sample size (${listing.reviewCount ?? 0} reviews < minimum ${minReviews})`
            : `Wilson rating confidence ${(weightedWilson * 100).toFixed(1)}% below credibility floor ${(minWilson * 100).toFixed(1)}%${tier ? ` (tier: ${tier})` : ''}`
      });
      continue;
    }

    // 6. Evaluate against user's target CommercePredicateConfig using landedPrice
    const requiredCode = intent.predicate.requiredPromoCode;
    const codeMatchesIfRequired = requiredCode
      ? listing.promoCode?.toUpperCase() === requiredCode.toUpperCase() && promoVerified
      : promoVerified;

    const syntheticCommerceState: ExtractedCommerceState = {
      currentPrice: landedPrice,
      listPrice: listing.listPrice,
      currency: listing.currency || 'USD',
      availability: 'InStock',
      rawRatingValue: listing.rating,
      ratingCount: listing.reviewCount,
      ratingScaleMax: 5.0,
      ratingConfidenceScore: weightedWilson,
      promoCodeVerified: requiredCode ? codeMatchesIfRequired : promoVerified ? true : null,
      detectedPromoDiscount: listing.promoDiscountPercent,
      priceValidUntil: null,
      sellerName: listing.seller,
      source: 'json_ld'
    };

    const predEval = evaluateCommercePredicate(syntheticCommerceState, intent.predicate);

    const refPrice = intent.predicate.referencePrice ?? listing.listPrice ?? null;
    const savingsVsReference =
      refPrice && refPrice > landedPrice ? Number((refPrice - landedPrice).toFixed(2)) : null;
    const dropPercentage =
      refPrice && refPrice > landedPrice
        ? Number((((refPrice - landedPrice) / refPrice) * 100).toFixed(1))
        : null;

    surviving.push({
      listing,
      promoSavings,
      landedPrice,
      effectiveShippingCost,
      referencePrice: refPrice,
      savingsVsReference,
      dropPercentage,
      wilsonConfidence: weightedWilson,
      similarityScore: conformance.similarityScore,
      meetsTargetPredicate: predEval.satisfied,
      isParetoOptimal: false,
      compositeScore: 0,
      predicateEvaluation: predEval,
      destinationZone: targetZone,
      merchantTier: tier
    });
  }

  if (surviving.length === 0) {
    return { rankedDeals: [], immediateWinners: [], rejectedCandidates };
  }

  // Compute price normalization across surviving cluster for Pareto multi-objective scoring
  const maxObservedLanded = Math.max(...surviving.map((c) => c.referencePrice || c.landedPrice), 1);
  const minObservedLanded = Math.min(...surviving.map((c) => c.landedPrice));
  const priceSpan = Math.max(1, maxObservedLanded - minObservedLanded);

  for (const item of surviving) {
    // Pareto dominance check: dominated iff another item has <= landedPrice AND >= wilsonConfidence (with at least one strict)
    const dominated = surviving.some(
      (other) =>
        other !== item &&
        other.landedPrice <= item.landedPrice &&
        other.wilsonConfidence >= item.wilsonConfidence &&
        (other.landedPrice < item.landedPrice || other.wilsonConfidence > item.wilsonConfidence)
    );
    item.isParetoOptimal = !dominated;

    const normalizedPriceAdvantage = Math.max(
      0,
      Math.min(1, (maxObservedLanded - item.landedPrice) / priceSpan)
    );
    const promoBonus = item.promoSavings > 0 ? 1 : 0;

    // Multi-objective score S: balances landed cost advantage (0.55), Wilson trust (0.30), promo verification (0.08), SKU match (0.07)
    item.compositeScore = Number(
      (
        0.55 * normalizedPriceAdvantage +
        0.3 * item.wilsonConfidence +
        0.08 * promoBonus +
        0.07 * item.similarityScore +
        (item.isParetoOptimal ? 0.05 : 0)
      ).toFixed(4)
    );
  }

  // Sort: Immediate target winners first, then lowest landed cost / highest composite score
  surviving.sort((a, b) => {
    if (a.meetsTargetPredicate !== b.meetsTargetPredicate) {
      return a.meetsTargetPredicate ? -1 : 1;
    }
    if (b.compositeScore !== a.compositeScore) {
      return b.compositeScore - a.compositeScore;
    }
    return a.landedPrice - b.landedPrice;
  });

  const immediateWinners = surviving.filter((c) => c.meetsTargetPredicate);

  return {
    rankedDeals: surviving,
    immediateWinners,
    rejectedCandidates
  };
}
