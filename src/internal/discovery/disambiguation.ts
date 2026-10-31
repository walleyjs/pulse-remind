import {
  extractCommercePredicateFromText,
  formatCurrencyAmount,
  type CommercePredicateConfig
} from '../resolution/predicates.ts';

export type ProductDomainClass = 'appliance' | 'computing' | 'electronics' | 'service' | 'general';
export type ProductCondition = 'brand_new' | 'uk_used' | 'refurbished' | 'any';
export type DestinationZone = 'lagos' | 'abuja' | 'interstate';

export interface ParsedDiscoveryIntent {
  rawQuery: string;
  canonicalProductPhrase: string;
  brand: string | null;
  modelTokens: string[];
  coreTokens: string[];
  domainClass: ProductDomainClass;
  targetCondition: ProductCondition;
  destinationZone?: DestinationZone;
  minPlausiblePriceFloor: number;
  negativeAccessoryTokens: string[];
  predicate: CommercePredicateConfig;
}

export interface ConformanceEvaluation {
  conformant: boolean;
  similarityScore: number;
  matchedTokens: string[];
  rejectionReason: string | null;
}

const KNOWN_BRANDS = [
  'lg',
  'samsung',
  'bosch',
  'whirlpool',
  'miele',
  'ge',
  'maytag',
  'electrolux',
  'haier',
  'hisense',
  'tcl',
  'bruhm',
  'scanfrost',
  'nexus',
  'polystar',
  'thermocool',
  'maxi',
  'skyrun',
  'century',
  'ox',
  'maxi',
  'airtel',
  'infinix',
  'tecno',
  'itel',
  'oraimo',
  'panasonic',
  'apple',
  'sony',
  'dell',
  'lenovo',
  'asus',
  'acer',
  'hp',
  'microsoft',
  'nvidia',
  'amd',
  'dyson',
  'bose',
  'garmin',
  'nintendo'
];

const DEFAULT_NEGATIVE_ACCESSORY_TOKENS = [
  'hose',
  'hoses',
  'drain',
  'filter',
  'filters',
  'cover',
  'covers',
  'dustcover',
  'toy',
  'miniature',
  'dollhouse',
  'pretend',
  'kids',
  'sleeve',
  'case',
  'pouch',
  'protector',
  'screenprotector',
  'skin',
  'sticker',
  'decal',
  'cable',
  'cord',
  'adapter',
  'charger',
  'mount',
  'bracket',
  'pedestal',
  'stacking',
  'gasket',
  'seal',
  'belt',
  'pump',
  'valve',
  'knob',
  'hinge',
  'bearing',
  'manual',
  'guide',
  'ebook',
  'replacement',
  'spare',
  'part',
  'parts',
  'kit',
  'detergent',
  'cleaner',
  'tablet',
  'tablets'
];

const STOP_WORDS = new Set([
  'i',
  'want',
  'to',
  'buy',
  'find',
  'me',
  'get',
  'search',
  'for',
  'a',
  'an',
  'the',
  'best',
  'cheapest',
  'deal',
  'deals',
  'price',
  'on',
  'from',
  'online',
  'shopping',
  'platforms',
  'stores',
  'with',
  'and',
  'or',
  'under',
  'below',
  'less',
  'than',
  'at',
  'least',
  'off',
  'discount',
  'promo',
  'coupon',
  'code',
  'verified',
  'rating',
  'confidence',
  'wilson',
  'stars',
  'star',
  'reviews',
  'alert',
  'when',
  'drops',
  'drop',
  'was',
  'msrp',
  'is',
  'in',
  'of',
  'tokunbo',
  'used',
  'brand',
  'new',
  'lagos',
  'abuja',
  'nigeria'
]);

/**
 * Detects whether text describes a product as brand_new, uk_used (or Tokunbo / fairly used), or refurbished.
 */
export function detectProductCondition(text: string): ProductCondition {
  if (/\b(uk\s+used|london\s+used|tokunbo|fairly\s+used|second\s+hand|pre-?owned)\b/i.test(text)) {
    return 'uk_used';
  }
  if (/\b(refurbished|renewed|open\s*box|b-stock)\b/i.test(text)) {
    return 'refurbished';
  }
  return 'brand_new';
}

export const SYNONYM_MAP: Record<string, string[]> = {
  washer: ['washing', 'machine', 'washer'],
  washing: ['washing', 'washer'],
  fridge: ['refrigerator', 'fridge'],
  refrigerator: ['refrigerator', 'fridge'],
  laptop: ['laptop', 'notebook', 'macbook'],
  macbook: ['macbook', 'laptop'],
  tv: ['television', 'tv', 'oled', 'tvr'],
  tvr: ['television', 'tv', 'oled'],
  fan: ['fan', 'standing', 'satnding'],
  standing: ['standing', 'satnding', 'fan'],
  satnding: ['standing', 'fan'],
  cooker: ['cooker', 'cooke', 'stove'],
  cooke: ['cooker', 'stove'],
  gas: ['gas'],
  router: ['router', 'mifi', 'modem'],
  airtel: ['airtel'],
  internet: ['internet', 'broadband', 'wifi'],
  microwave: ['microwave', 'oven'],
  headphones: ['headphones', 'headset', 'earbuds'],
  tokunbo: ['used', 'uk', 'tokunbo']
};

export function tokenizeNormalized(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9.\-+]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((t) => t.length >= 2);
}

function inferDomainClass(tokens: string[]): {
  domainClass: ProductDomainClass;
  minPlausiblePriceFloor: number;
} {
  const joined = tokens.join(' ');
  if (
    /\b(washing\s+machine|washer|dryer|refrigerator|fridge|dishwasher|oven|range|air\s+conditioner|freezer|cooker|cooke|stove|microwave)\b/i.test(
      joined
    )
  ) {
    return { domainClass: 'appliance', minPlausiblePriceFloor: 140 };
  }
  if (/\b(fan|satnding|standing\s+fan)\b/i.test(joined)) {
    return { domainClass: 'appliance', minPlausiblePriceFloor: 25 };
  }
  if (/\b(router|mifi|modem|airtel)\b/i.test(joined)) {
    return { domainClass: 'electronics', minPlausiblePriceFloor: 20 };
  }
  if (/\b(macbook|laptop|thinkpad|xps|desktop|gpu|rtx|iphone|ipad|galaxy\s+s2\d)\b/i.test(joined)) {
    return { domainClass: 'computing', minPlausiblePriceFloor: 180 };
  }
  if (/\b(tv|television|oled|tvr|smart\s+tv|playstation|ps5|ps6|xbox|camera|headphones|vacuum|dyson)\b/i.test(joined)) {
    return { domainClass: 'electronics', minPlausiblePriceFloor: 60 };
  }
  if (/\b(vpn|hosting|saas|subscription|cloud|plan|insurance|service)\b/i.test(joined)) {
    return { domainClass: 'service', minPlausiblePriceFloor: 5 };
  }
  return { domainClass: 'general', minPlausiblePriceFloor: 10 };
}

/**
 * Parses an unstructured user product query into a normalized SKU discovery intent,
 * extracting price/rating/promo predicates, brand/model identifiers, and anti-accessory guards.
 */
export function parseDiscoveryQuery(
  rawQuery: string,
  explicitPredicate?: Partial<CommercePredicateConfig>
): ParsedDiscoveryIntent {
  const extractedPred = extractCommercePredicateFromText(rawQuery) || {};
  const mergedPredicate: CommercePredicateConfig = {
    ...extractedPred,
    ...(explicitPredicate || {})
  };

  // Default a statistical credibility floor of 0.70 Wilson score during multi-store discovery if unspecified
  if (mergedPredicate.minRatingConfidence === undefined) {
    mergedPredicate.minRatingConfidence = 0.7;
  }
  if (mergedPredicate.minReviewCount === undefined) {
    mergedPredicate.minReviewCount = 10;
  }

  // Strip pricing, rating, promo clauses, conditions, and locations to isolate the product phrase
  const stripped = rawQuery
    .replace(
      /(?:under|below|less\s+than|<=|drops?\s+(?:to|under|below)|target(?:\s+price)?)\s*(?:₦|\bNGN\b|\bN(?=[0-9\s])|\$|\bUSD\b|€|\bEUR\b|£|\bGBP\b)?\s*[0-9,]+(?:\.[0-9]{1,2})?\s*([kmKM])?\b/gi,
      ' '
    )
    .replace(
      /\(?(?:was|from|msrp|list\s+price)\s*(?:₦|\bNGN\b|\bN(?=[0-9\s])|\$|\bUSD\b|€|\bEUR\b|£|\bGBP\b)?\s*[0-9,]+(?:\.[0-9]{1,2})?\s*([kmKM])?\b\)?/gi,
      ' '
    )
    .replace(/(?:at\s+least\s+)?[0-9]{1,2}(?:\.[0-9]+)?\s*%\s*(?:off|discount|drop|rating\s+confidence)/gi, ' ')
    .replace(/(?:with\s+)?(?:promo|coupon|voucher)(?:\s+code)?\s+['"]?[A-Z0-9_\-]{3,24}['"]?/gi, ' ')
    .replace(/(?:with\s+)?[0-9]{1,2}(?:\.[0-9]+)?%?\s*(?:wilson|verified)?\s*rating\s*confidence/gi, ' ')
    .replace(/[0-9.]+\+?\s*(?:stars?|★|reviews)/gi, ' ')
    .replace(/\b(brand\s+new|sealed|box\s+new|uk\s+used|london\s+used|tokunbo|fairly\s+used|second\s+hand|refurbished|renewed|open\s*box)\b/gi, ' ')
    .replace(/\b(in\s+lagos|in\s+abuja|to\s+lagos|to\s+abuja|interstate|lagos|abuja)\b/gi, ' ');

  // Condition classification: brand_new, uk_used, refurbished, any
  let targetCondition: ProductCondition = 'brand_new';
  if (/\b(uk\s+used|london\s+used|tokunbo|fairly\s+used|second\s+hand|pre-?owned)\b/i.test(rawQuery)) {
    targetCondition = 'uk_used';
  } else if (/\b(refurbished|renewed|open\s*box|b-stock)\b/i.test(rawQuery)) {
    targetCondition = 'refurbished';
  } else if (/\b(any\s+condition|all\s+conditions)\b/i.test(rawQuery)) {
    targetCondition = 'any';
  }

  // Destination zone modeling: lagos, abuja, interstate
  let destinationZone: DestinationZone | undefined;
  if (/\b(in\s+abuja|to\s+abuja|\babuja\b)\b/i.test(rawQuery)) {
    destinationZone = 'abuja';
  } else if (/\b(interstate|outside\s+lagos|upcountry)\b/i.test(rawQuery)) {
    destinationZone = 'interstate';
  } else if (/\b(in\s+lagos|to\s+lagos|\blagos\b)\b/i.test(rawQuery)) {
    destinationZone = 'lagos';
  }

  if (destinationZone && !mergedPredicate.currency) {
    mergedPredicate.currency = 'NGN';
  }

  const rawTokens = tokenizeNormalized(stripped);
  const rawQueryLowerTokens = new Set(tokenizeNormalized(rawQuery));

  const coreTokens = rawTokens.filter(
    (t) => !STOP_WORDS.has(t) && !/^[0-9]+$/.test(t)
  );

  let brand: string | null = null;
  for (const t of coreTokens) {
    if (KNOWN_BRANDS.includes(t)) {
      brand = t.toUpperCase() === 'LG' || t.toUpperCase() === 'GE' || t.toUpperCase() === 'HP' || t.toUpperCase() === 'TCL'
        ? t.toUpperCase()
        : t.charAt(0).toUpperCase() + t.slice(1);
      break;
    }
  }

  // Model tokens contain both letters and digits (e.g. wm4000hwa, m4, 16-inch, rtx5090)
  const modelTokens = coreTokens.filter(
    (t) => /[a-z]/i.test(t) && /[0-9]/.test(t)
  );

  // Exclude any negative accessory token that the user explicitly asked for!
  const userAskedForAccessory = DEFAULT_NEGATIVE_ACCESSORY_TOKENS.some((neg) =>
    rawQueryLowerTokens.has(neg)
  );
  const negativeAccessoryTokens = DEFAULT_NEGATIVE_ACCESSORY_TOKENS.filter(
    (neg) => !rawQueryLowerTokens.has(neg)
  );

  const { domainClass, minPlausiblePriceFloor } = inferDomainClass(coreTokens);
  let effectiveFloor = userAskedForAccessory ? 1 : minPlausiblePriceFloor;
  if (mergedPredicate.currency === 'NGN') {
    effectiveFloor = userAskedForAccessory ? 1000 : minPlausiblePriceFloor * 1000;
  }
  if (mergedPredicate.targetPrice !== undefined && mergedPredicate.targetPrice > 0) {
    effectiveFloor = Math.min(effectiveFloor, mergedPredicate.targetPrice * 0.22);
  }

  const canonicalProductPhrase =
    coreTokens.length > 0 ? coreTokens.join(' ') : rawQuery.trim();

  return {
    rawQuery,
    canonicalProductPhrase,
    brand,
    modelTokens,
    coreTokens,
    domainClass,
    targetCondition,
    destinationZone,
    minPlausiblePriceFloor: Number(effectiveFloor.toFixed(2)),
    negativeAccessoryTokens,
    predicate: mergedPredicate
  };
}

/**
 * Evaluates whether a candidate merchant listing represents the requested core SKU/category,
 * filtering out accessories, spare parts, toys/miniatures, condition mismatches (UK Used / Tokunbo / Refurbished),
 * and mismatched brands/models.
 */
export function evaluateCandidateConformance(
  intent: ParsedDiscoveryIntent,
  candidateTitle: string,
  candidateLandedPrice: number,
  candidateConditionHint?: ProductCondition
): ConformanceEvaluation {
  const candidateTokens = tokenizeNormalized(candidateTitle);
  const candidateSet = new Set(candidateTokens);

  // 1. Condition Classifier & "UK Used / Tokunbo" Guard
  const detectedCondition = detectProductCondition(candidateTitle);
  const effectiveCondition = candidateConditionHint || detectedCondition;
  if (intent.targetCondition === 'brand_new' && effectiveCondition !== 'brand_new') {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Condition mismatch: listing is ${effectiveCondition === 'uk_used' ? 'UK Used / Tokunbo' : 'Refurbished'} (query target: brand_new)`
    };
  }

  // 2. Negative Anti-Accessory & Toy Trap Filter
  for (const neg of intent.negativeAccessoryTokens) {
    if (candidateSet.has(neg)) {
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Accessory/part/toy mismatch: listing contains excluded token "${neg}"`
      };
    }
  }

  // Check multi-word accessory / miniature / part phrases
  if (
    intent.negativeAccessoryTokens.length > 10 &&
    /\b(?:for\s+washing\s+machine|compatible\s+with|fits\s+lg|fits\s+samsung|1:12\s+scale|mini\s+portable\s+usb|ultrasonic\s+turbine)\b/i.test(
      candidateTitle
    )
  ) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: 'Accessory or miniature USB/scale item detected ("compatible with" / miniature)'
    };
  }

  // 3. Plausible Category Price Floor Guard
  if (candidateLandedPrice < intent.minPlausiblePriceFloor) {
    const cur = intent.predicate.currency || 'USD';
    const formattedPrice = formatCurrencyAmount(candidateLandedPrice, cur);
    const formattedFloor = formatCurrencyAmount(intent.minPlausiblePriceFloor, cur);
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Implausible price (${formattedPrice} < category floor ${formattedFloor}) — likely accessory or deposit`
    };
  }

  // 3. Explicit Brand Guard (if user specified a brand like "LG" or "Apple", listing must include it)
  if (intent.brand && !candidateSet.has(intent.brand.toLowerCase())) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Brand mismatch: query requires "${intent.brand}"`
    };
  }

  // 4. Explicit Model Code Guard (if user specified model codes like "M4" or "WM4000HWA")
  for (const modelTok of intent.modelTokens) {
    if (!candidateSet.has(modelTok.toLowerCase())) {
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Model specification mismatch: missing "${modelTok}"`
      };
    }
  }

  // 5. Synonym-Expanded Token Overlap & Jaccard Conformance Score
  const expandedCandidateSet = new Set<string>(candidateTokens);
  for (const tok of candidateTokens) {
    const syns = SYNONYM_MAP[tok];
    if (syns) {
      for (const s of syns) expandedCandidateSet.add(s);
    }
  }

  const matchedTokens: string[] = [];
  for (const qTok of intent.coreTokens) {
    const qSyns = SYNONYM_MAP[qTok] || [qTok];
    if (qSyns.some((s) => expandedCandidateSet.has(s))) {
      matchedTokens.push(qTok);
    }
  }

  if (intent.coreTokens.length > 0 && matchedTokens.length === 0) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: 'Zero semantic token overlap with query'
    };
  }

  const recall =
    intent.coreTokens.length > 0 ? matchedTokens.length / intent.coreTokens.length : 1;
  if (recall < 0.5) {
    return {
      conformant: false,
      similarityScore: Number(recall.toFixed(3)),
      matchedTokens,
      rejectionReason: `Insufficient category token recall (${Math.round(recall * 100)}% < 50%)`
    };
  }

  const unionSize = new Set([...intent.coreTokens, ...candidateTokens]).size || 1;
  const jaccard = matchedTokens.length / unionSize;
  const similarityScore = Number((0.65 * recall + 0.35 * jaccard).toFixed(4));

  return {
    conformant: true,
    similarityScore,
    matchedTokens,
    rejectionReason: null
  };
}
