/**
 * PulseRemind Commerce & Arbitrage Temporal Predicate Engine
 *
 * Implements:
 * 1. Wilson Score Lower Bound Confidence calculation for seller/product ratings
 * 2. Schema.org Offer / AggregateRating / PriceSpecification & SSR __NEXT_DATA__ parsing
 * 3. Composite temporal comparison predicates (Price Drop, Percentage Discount, Rating Floor)
 * 4. Non-destructive promo-code token verification state machine
 */

export interface PricePredicateConfig {
  targetPrice?: number;
  currency?: string;
  maxDropPercentage?: number; // e.g. 20 for 20% off reference
  minDropPercentage?: number; // alias for maxDropPercentage
  referencePrice?: number;
  minRatingConfidence?: number; // Wilson score lower bound [0.0 - 1.0]
  minReviewCount?: number;
  requiredPromoCode?: string;
}

export type CommercePredicateConfig = PricePredicateConfig;

export interface ExtractedCommerceState {
  currentPrice: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: 'InStock' | 'OutOfStock' | 'PreOrder' | 'Unknown';
  rawRatingValue: number | null;
  ratingCount: number | null;
  ratingScaleMax: number;
  ratingConfidenceScore: number | null; // Wilson score lower bound
  promoCodeVerified: boolean | null;
  detectedPromoDiscount: number | null;
  priceValidUntil: string | null;
  sellerName: string | null;
  source: 'json_ld' | 'next_data' | 'microdata' | 'heuristics' | 'none';
}

export interface PredicateEvaluationResult {
  satisfied: boolean;
  reasons: string[];
  extracted: ExtractedCommerceState;
  effectiveDropPercentage: number | null;
  savingsAmount: number | null;
}

export type CommerceEvaluationResult = PredicateEvaluationResult;

/**
 * Calculates the Wilson Score Lower Bound for binomial proportions / ratings.
 * Maps star ratings [1..scaleMax] into normalized positive proportion p in [0, 1].
 *
 * Formula:
 * W = (p_hat + z^2 / (2n) - z * sqrt((p_hat * (1 - p_hat) + z^2 / (4n)) / n)) / (1 + z^2 / n)
 *
 * @param rating Average rating value (e.g. 4.6)
 * @param reviewCount Total number of reviews (n)
 * @param scaleMax Maximum rating scale (defaults to 5.0)
 * @param zConfidence Z-score for confidence level (default 1.96 for 95% two-sided confidence)
 */
export function calculateWilsonRatingConfidence(
  rating: number,
  reviewCount: number,
  scaleMax = 5.0,
  zConfidence = 1.96
): number {
  if (reviewCount <= 0 || isNaN(rating) || rating <= 0) return 0;
  
  // Normalize rating to [0, 1]
  const pHat = Math.min(1.0, Math.max(0.0, (rating - 1.0) / (scaleMax - 1.0)));
  const n = reviewCount;
  const z = zConfidence;
  const z2 = z * z;

  const numerator =
    pHat + z2 / (2 * n) - z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  const score = numerator / denominator;
  return Math.max(0.0, Math.min(1.0, Number(score.toFixed(4))));
}

/**
 * Parses currency and amount from raw string with support for:
 * - Symbols: ₦, $, €, £
 * - Codes: NGN, USD, EUR, GBP, N
 * - Suffix slang: k/K (thousands), m/M (millions)
 * - Comma-separated numbers: ₦550,000, 1.2m, 450k, N450k
 */
export function parseCurrencyAmount(rawStr: string): { amount: number; currency?: string } | null {
  if (!rawStr || !rawStr.trim()) return null;
  const cleaned = rawStr.trim();

  const match = cleaned.match(
    /(?:(₦|\bNGN\b|\bN(?=[0-9\s])|\$|\bUSD\b|€|\bEUR\b|£|\bGBP\b)\s*)?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kmKM])?\b/i
  );
  if (!match) return null;

  const rawCurrMarker = match[1] ? match[1].trim() : undefined;
  const numPart = parseFloat(match[2].replace(/,/g, ''));
  if (isNaN(numPart) || numPart < 0) return null;

  const multiplierToken = match[3] ? match[3].toLowerCase() : null;
  let multiplier = 1;
  if (multiplierToken === 'k') multiplier = 1000;
  else if (multiplierToken === 'm') multiplier = 1000000;

  const amount = Number((numPart * multiplier).toFixed(2));

  let currency: string | undefined;
  if (rawCurrMarker) {
    const upper = rawCurrMarker.toUpperCase();
    if (upper === '₦' || upper === 'NGN' || upper === 'N') {
      currency = 'NGN';
    } else if (upper === '€' || upper === 'EUR') {
      currency = 'EUR';
    } else if (upper === '£' || upper === 'GBP') {
      currency = 'GBP';
    } else if (upper === '$' || upper === 'USD') {
      currency = 'USD';
    }
  } else if (multiplierToken === 'k' || multiplierToken === 'm') {
    currency = 'NGN';
  }

  return { amount, currency };
}

/**
 * Formats a numeric currency amount with its appropriate symbol (₦ for NGN, $ for USD, € for EUR, £ for GBP).
 */
export function formatCurrencyAmount(amount: number, currency = 'USD'): string {
  const curr = (currency || 'USD').toUpperCase();
  const isInt = Number.isInteger(amount);
  const formattedNum = isInt
    ? amount.toLocaleString('en-US')
    : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (curr === 'NGN' || curr === '₦') {
    return `₦${formattedNum}`;
  }
  if (curr === 'EUR' || curr === '€') {
    return `€${formattedNum}`;
  }
  if (curr === 'GBP' || curr === '£') {
    return `£${formattedNum}`;
  }
  return `$${formattedNum}`;
}

/**
 * Extracts structured commerce state from HTML using Schema.org JSON-LD and SSR __NEXT_DATA__.
 */
export function extractStructuredCommerceState(
  rawHtml: string,
  requiredPromoCode?: string
): ExtractedCommerceState {
  const result: ExtractedCommerceState = {
    currentPrice: null,
    listPrice: null,
    currency: null,
    availability: 'Unknown',
    rawRatingValue: null,
    ratingCount: null,
    ratingScaleMax: 5.0,
    ratingConfidenceScore: null,
    promoCodeVerified: null,
    detectedPromoDiscount: null,
    priceValidUntil: null,
    sellerName: null,
    source: 'none'
  };

  // 1. Check <script type="application/ld+json">
  const ldRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = ldRegex.exec(rawHtml)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const objects: Record<string, any>[] = [];
      collectJsonObjects(parsed, objects);

      for (const obj of objects) {
        // Schema.org AggregateRating
        if (obj['@type'] === 'AggregateRating' || obj.ratingValue !== undefined) {
          const val = parseFloat(obj.ratingValue);
          const count = parseInt(obj.ratingCount || obj.reviewCount || '0', 10);
          const best = parseFloat(obj.bestRating || '5.0');
          if (!isNaN(val)) {
            result.rawRatingValue = val;
            result.ratingCount = isNaN(count) ? 0 : count;
            result.ratingScaleMax = isNaN(best) ? 5.0 : best;
            result.ratingConfidenceScore = calculateWilsonRatingConfidence(
              result.rawRatingValue,
              result.ratingCount,
              result.ratingScaleMax
            );
            result.source = 'json_ld';
          }
        }

        // Schema.org Offer or Product with offers
        if (obj['@type'] === 'Offer' || obj['@type'] === 'Product' || obj.price !== undefined) {
          const rawPrice = obj.price ?? obj.lowPrice ?? obj.priceSpecification?.price;
          if (rawPrice !== undefined && rawPrice !== null) {
            const p = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
            if (!isNaN(p)) {
              result.currentPrice = p;
              if (obj.highPrice !== undefined || obj.listPrice !== undefined) {
                const lp = parseFloat(String(obj.highPrice ?? obj.listPrice).replace(/[^0-9.]/g, ''));
                if (!isNaN(lp)) result.listPrice = lp;
              }
              result.currency = obj.priceCurrency || obj.priceSpecification?.priceCurrency || result.currency;
              result.priceValidUntil = obj.priceValidUntil || null;
              if (obj.seller?.name) result.sellerName = String(obj.seller.name);
              const avail = String(obj.availability || '');
              if (avail.includes('InStock')) result.availability = 'InStock';
              else if (avail.includes('OutOfStock') || avail.includes('SoldOut')) result.availability = 'OutOfStock';
              else if (avail.includes('PreOrder')) result.availability = 'PreOrder';
              result.source = 'json_ld';
            }
          }
        }
      }
    } catch {}
  }

  // 2. Check SSR __NEXT_DATA__ if JSON-LD price was missing
  if (result.currentPrice === null) {
    const nextMatch = rawHtml.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch) {
      try {
        const nextJson = JSON.parse(nextMatch[1].trim());
        const props = nextJson.props?.pageProps;
        if (props) {
          const candidateProduct = props.product || props.initialData?.product || props.item;
          if (candidateProduct) {
            const price = parseFloat(candidateProduct.price || candidateProduct.finalPrice || candidateProduct.salePrice);
            if (!isNaN(price)) {
              result.currentPrice = price;
              result.listPrice = parseFloat(candidateProduct.listPrice || candidateProduct.msrp || candidateProduct.originalPrice) || null;
              result.currency = candidateProduct.currency || 'USD';
              result.availability = candidateProduct.inStock === false ? 'OutOfStock' : 'InStock';
              result.source = 'next_data';
              if (candidateProduct.rating) {
                result.rawRatingValue = parseFloat(candidateProduct.rating);
                result.ratingCount = parseInt(candidateProduct.reviewCount || '0', 10);
                result.ratingConfidenceScore = calculateWilsonRatingConfidence(
                  result.rawRatingValue,
                  result.ratingCount
                );
              }
            }
          }
        }
      } catch {}
    }
  }

  // 3. Optional Promo Code verification against page HTML
  if (requiredPromoCode) {
    const promoRes = validatePromoCodeToken(requiredPromoCode, rawHtml);
    result.promoCodeVerified = promoRes.valid;
    result.detectedPromoDiscount = promoRes.valid ? promoRes.discountPercentage : null;
  }

  return result;
}

function collectJsonObjects(input: any, acc: Record<string, any>[]): void {
  if (!input || typeof input !== 'object') return;
  if (Array.isArray(input)) {
    for (const item of input) collectJsonObjects(item, acc);
    return;
  }
  acc.push(input);
  for (const key of Object.keys(input)) {
    if (typeof input[key] === 'object') {
      collectJsonObjects(input[key], acc);
    }
  }
}

/**
 * Non-destructive simulated promo-code checkout validator.
 * Simulates coupon evaluation against basket state machine without creating active transactions.
 */
export function validatePromoCodeToken(
  code: string,
  rawHtmlOrCartState: string | Record<string, any>
): { valid: boolean; discountPercentage: number; description: string } {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    return { valid: false, discountPercentage: 0, description: 'Empty promo code' };
  }

  if (typeof rawHtmlOrCartState === 'object') {
    const validPromos = rawHtmlOrCartState.active_coupons || rawHtmlOrCartState.coupons || {};
    if (validPromos[normalizedCode]) {
      const discount = Number(validPromos[normalizedCode]) || 10;
      return {
        valid: true,
        discountPercentage: discount,
        description: `Verified coupon ${normalizedCode} applied: ${discount}% off`
      };
    }
  }

  // Text/HTML based coupon validation signature check
  const html = String(rawHtmlOrCartState);
  const regexSuccess = new RegExp(
    `(?:code|coupon|promo|voucher)\\s+['"]?${normalizedCode}['"]?\\s+(?:is\\s+valid|applied|gives\\s+([0-9]{1,2})%|saves\\s+\\$([0-9.]+))`,
    'i'
  );
  const match = html.match(regexSuccess);
  if (match) {
    const pct = match[1] ? parseFloat(match[1]) : 15;
    return {
      valid: true,
      discountPercentage: pct,
      description: `Coupon ${normalizedCode} verified on page (${pct}% discount)`
    };
  }

  // Check rejection patterns
  const regexReject = new RegExp(
    `(?:code|coupon)\\s+['"]?${normalizedCode}['"]?\\s+(?:is\\s+invalid|expired|not\\s+found|cannot\\s+be\\s+applied)`,
    'i'
  );
  if (regexReject.test(html)) {
    return {
      valid: false,
      discountPercentage: 0,
      description: `Coupon ${normalizedCode} is expired or invalid`
    };
  }

  return {
    valid: false,
    discountPercentage: 0,
    description: `Coupon ${normalizedCode} status could not be verified non-destructively`
  };
}

/**
 * Evaluates composite temporal price and rating predicates against extracted state.
 */
export function evaluateCommercePredicate(
  extracted: ExtractedCommerceState,
  config: PricePredicateConfig
): PredicateEvaluationResult {
  const reasons: string[] = [];
  let satisfied = true;

  if (extracted.currentPrice === null) {
    return {
      satisfied: false,
      reasons: ['No price detected on target portal'],
      extracted,
      effectiveDropPercentage: null,
      savingsAmount: null
    };
  }

  // 1. Stock / Availability Guard
  if (extracted.availability === 'OutOfStock') {
    return {
      satisfied: false,
      reasons: ['Item is currently out of stock'],
      extracted,
      effectiveDropPercentage: null,
      savingsAmount: null
    };
  }

  // 2. Absolute Target Price Predicate: P <= P_target
  if (config.targetPrice !== undefined && config.targetPrice !== null) {
    const cur = extracted.currency || config.currency || '$';
    if (extracted.currentPrice <= config.targetPrice) {
      reasons.push(
        `Current price ${formatCurrencyAmount(extracted.currentPrice, cur)} is at or below target threshold ${formatCurrencyAmount(config.targetPrice, cur)}`
      );
    } else {
      satisfied = false;
      reasons.push(
        `Current price ${formatCurrencyAmount(extracted.currentPrice, cur)} exceeds target ${formatCurrencyAmount(config.targetPrice, cur)}`
      );
    }
  }

  // 3. Relative Percentage Drop Predicate: (P_ref - P) / P_ref >= delta
  let effectiveDropPercentage: number | null = null;
  let savingsAmount: number | null = null;
  const refPrice = config.referencePrice ?? extracted.listPrice;
  const requiredDropPct = config.maxDropPercentage ?? config.minDropPercentage;
  const cur = extracted.currency || config.currency || '$';

  if (refPrice && refPrice > extracted.currentPrice) {
    savingsAmount = Number((refPrice - extracted.currentPrice).toFixed(2));
    effectiveDropPercentage = Number((((refPrice - extracted.currentPrice) / refPrice) * 100).toFixed(1));

    if (requiredDropPct !== undefined && requiredDropPct !== null) {
      if (effectiveDropPercentage >= requiredDropPct) {
        reasons.push(
          `Price drop of ${effectiveDropPercentage}% exceeds requested threshold of ${requiredDropPct}% (Saved ${formatCurrencyAmount(savingsAmount, cur)})`
        );
      } else {
        satisfied = false;
        reasons.push(
          `Price drop of ${effectiveDropPercentage}% is below minimum required ${requiredDropPct}%`
        );
      }
    }
  } else if (requiredDropPct !== undefined && requiredDropPct !== null) {
    satisfied = false;
    reasons.push('No reference or list price available to verify percentage drop');
  }

  // 4. Wilson Score Rating Quality Filter: Wilson(R, N) >= minConfidence
  if (config.minRatingConfidence !== undefined && config.minRatingConfidence !== null) {
    const score = extracted.ratingConfidenceScore ?? 0;
    const minCount = config.minReviewCount ?? 5;

    if ((extracted.ratingCount ?? 0) < minCount) {
      satisfied = false;
      reasons.push(
        `Review sample size too small (${extracted.ratingCount ?? 0} reviews < minimum ${minCount}) to establish statistical credibility`
      );
    } else if (score >= config.minRatingConfidence) {
      reasons.push(
        `Rating quality verified: Wilson confidence score ${(score * 100).toFixed(1)}% satisfies threshold ${(config.minRatingConfidence * 100).toFixed(1)}% (${extracted.rawRatingValue}★ across ${extracted.ratingCount} reviews)`
      );
    } else {
      satisfied = false;
      reasons.push(
        `Rating confidence score ${(score * 100).toFixed(1)}% is below credibility threshold ${(config.minRatingConfidence * 100).toFixed(1)}%`
      );
    }
  }

  // 5. Promo code requirement
  if (config.requiredPromoCode) {
    if (extracted.promoCodeVerified === true) {
      reasons.push(`Required coupon ${config.requiredPromoCode} verified active`);
    } else {
      satisfied = false;
      reasons.push(`Required coupon ${config.requiredPromoCode} is not active or verified`);
    }
  }

  return {
    satisfied,
    reasons,
    extracted,
    effectiveDropPercentage,
    savingsAmount
  };
}

/**
 * Deterministically extracts numeric price-drop, percentage-discount, Wilson rating confidence,
 * and promo-code constraints from natural language prompts or condition text.
 */
export function extractCommercePredicateFromText(text: string): PricePredicateConfig | null {
  if (!text || !text.trim()) return null;

  const config: PricePredicateConfig = {};
  let matchedAny = false;

  // 1. Target price: "under ₦550,000", "below 450k", "under $1,500", "below $1600", "<= $299.99", "drops to $1200", "under 1.2m", "below N450k"
  const targetPriceMatch = text.match(
    /(?:under|below|less\s+than|at\s+or\s+below|<=|drops?\s+(?:to|under|below)|target(?:\s+price)?(?:\s+of)?)\s*(?:(₦|\bNGN\b|\bN(?=[0-9\s])|\$|\bUSD\b|€|\bEUR\b|£|\bGBP\b)\s*)?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kmKM])?\b/i
  );
  if (targetPriceMatch) {
    const rawCurrencyMarker = targetPriceMatch[1];
    const valRaw = parseFloat(targetPriceMatch[2].replace(/,/g, ''));
    const multToken = targetPriceMatch[3]?.toLowerCase();
    const mult = multToken === 'k' ? 1000 : multToken === 'm' ? 1000000 : 1;
    const val = Number((valRaw * mult).toFixed(2));

    if (!isNaN(val) && val > 0) {
      config.targetPrice = val;
      if (rawCurrencyMarker) {
        const upper = rawCurrencyMarker.toUpperCase();
        if (upper === '₦' || upper === 'NGN' || upper === 'N') {
          config.currency = 'NGN';
        } else if (upper === '€' || upper === 'EUR') {
          config.currency = 'EUR';
        } else if (upper === '£' || upper === 'GBP') {
          config.currency = 'GBP';
        } else {
          config.currency = 'USD';
        }
      } else if (multToken === 'k' || multToken === 'm') {
        config.currency = 'NGN';
      } else {
        config.currency = 'USD';
      }
      matchedAny = true;
    }
  }

  // 2. Reference / MSRP price: "(was ₦700,000)", "(was $1,999)", "from $2000", "reference price $3,499", "msrp $999", "was 600k"
  const refPriceMatch = text.match(
    /(?:was|from|msrp|list\s+price|reference\s+price)\s*(?:(₦|\bNGN\b|\bN(?=[0-9\s])|\$|\bUSD\b|€|\bEUR\b|£|\bGBP\b)\s*)?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kmKM])?\b/i
  );
  if (refPriceMatch) {
    const rawCurrencyMarker = refPriceMatch[1];
    const valRaw = parseFloat(refPriceMatch[2].replace(/,/g, ''));
    const multToken = refPriceMatch[3]?.toLowerCase();
    const mult = multToken === 'k' ? 1000 : multToken === 'm' ? 1000000 : 1;
    const val = Number((valRaw * mult).toFixed(2));
    if (!isNaN(val) && val > 0) {
      config.referencePrice = val;
      if (!config.currency) {
        if (rawCurrencyMarker) {
          const upper = rawCurrencyMarker.toUpperCase();
          if (upper === '₦' || upper === 'NGN' || upper === 'N') {
            config.currency = 'NGN';
          } else if (upper === '€' || upper === 'EUR') {
            config.currency = 'EUR';
          } else if (upper === '£' || upper === 'GBP') {
            config.currency = 'GBP';
          } else {
            config.currency = 'USD';
          }
        } else if (multToken === 'k' || multToken === 'm') {
          config.currency = 'NGN';
        }
      }
      matchedAny = true;
    }
  }

  // 3. Percentage drop: "at least 20% off", "25% discount", "drop of 15%"
  const dropPctMatch = text.match(
    /(?:at\s+least\s+|minimum\s+|drop\s+of\s+)?([0-9]{1,2}(?:\.[0-9]+)?)\s*%\s*(?:off|discount|drop|savings)/i
  );
  if (dropPctMatch) {
    const pct = parseFloat(dropPctMatch[1]);
    if (!isNaN(pct) && pct > 0 && pct < 100) {
      config.maxDropPercentage = pct;
      config.minDropPercentage = pct;
      matchedAny = true;
    }
  }

  // 4. Wilson rating confidence: "85% rating confidence", "min rating confidence 0.85", "wilson confidence 80%"
  const wilsonMatch = text.match(
    /(?:(?:wilson|rating)\s+confidence(?:\s+of|\s+at\s+least)?|([0-9]{1,2}(?:\.[0-9]+)?)\s*%\s+(?:wilson\s+|verified\s+)?rating\s+confidence)\s*([0-9.]+)?\s*(%)?/i
  );
  if (wilsonMatch) {
    const rawNum = wilsonMatch[1] || wilsonMatch[2];
    if (rawNum) {
      let num = parseFloat(rawNum);
      if (!isNaN(num) && num > 0) {
        if (num > 1) num = num / 100;
        config.minRatingConfidence = Number(num.toFixed(2));
        matchedAny = true;
      }
    }
  } else {
    // Also support star floor: "4.5+ stars", "at least 4.6 stars" -> map to Wilson lower bound
    const starMatch = text.match(/(?:at\s+least\s+|min(?:imum)?\s+)?([34](?:\.[0-9])?|5(?:\.0)?)\+?\s*(?:stars?|★)/i);
    if (starMatch) {
      const stars = parseFloat(starMatch[1]);
      if (!isNaN(stars) && stars >= 3.0 && stars <= 5.0) {
        config.minRatingConfidence = Number(calculateWilsonRatingConfidence(stars, 50, 5.0).toFixed(2));
        matchedAny = true;
      }
    }
  }

  // 5. Minimum review count: "at least 100 reviews", "50+ reviews"
  const reviewCountMatch = text.match(/(?:at\s+least\s+|min(?:imum)?\s+)?([0-9]+)\+?\s+reviews/i);
  if (reviewCountMatch) {
    const cnt = parseInt(reviewCountMatch[1], 10);
    if (!isNaN(cnt) && cnt > 0) {
      config.minReviewCount = cnt;
      matchedAny = true;
    }
  }

  // 6. Required promo code: "with promo code WELCOME12", "coupon code SAVE20", "with code TECH2026"
  const promoMatch = text.match(
    /(?:with\s+)?(?:promo\s+code|coupon\s+code|coupon|voucher|with\s+code)\s+['"]?([A-Za-z0-9_\-]{3,24})['"]?/i
  );
  if (promoMatch) {
    const rawToken = promoMatch[1];
    // Genuine promo code tokens are uppercase/alphanumeric codes (e.g. SAVE20, WELCOME12, VIPFALL), not lowercase prose words
    const hasDigitOrAllCaps = /[0-9]/.test(rawToken) || rawToken === rawToken.toUpperCase();
    const token = rawToken.toUpperCase();
    if (
      hasDigitOrAllCaps &&
      !['OPEN', 'CODE', 'CODES', 'VALID', 'ACTIVE', 'ONLY', 'WHEN', 'THAT', 'CHECKOUT'].includes(token)
    ) {
      config.requiredPromoCode = token;
      matchedAny = true;
    }
  }

  return matchedAny ? config : null;
}
