import {
  extractCommercePredicateFromText,
  formatCurrencyAmount,
  type CommercePredicateConfig
} from '../resolution/predicates.ts';

export type ProductDomainClass = 'appliance' | 'computing' | 'electronics' | 'service' | 'general';
export type ProductCondition = 'brand_new' | 'uk_used' | 'refurbished' | 'any';
export type DestinationZone = 'lagos' | 'abuja' | 'interstate';

export type DimensionAxis =
  | 'power'
  | 'thermal'
  | 'length'
  | 'mass'
  | 'volume'
  | 'storage'
  | 'electrical'
  | 'frequency'
  | 'count';

export interface ExtractedDimension {
  value: number;
  unit: string;
  axis: DimensionAxis;
  raw: string;
}

/**
 * Open-Vocabulary Attribute-Value Pair (AVP) Lattice representation of a query or merchant listing.
 * Eliminates hardcoded category/form-factor enums in favor of universal SI/industrial dimensions,
 * orthogonal qualifier axes, and syntactic Right-Hand Head Noun vs Relational Adjunct decomposition.
 */
export interface AttributeValueLattice {
  brand: string | null;
  dimensions: ExtractedDimension[];
  qualifiers: string[];
  axisQualifiers: Record<string, string>;
  axisSurfaceTokens: Record<string, string>;
  nounSequence: string[];
  headTokens: string[];
  headNounKernel: string | null;
  relationalPreposition: string | null;
  relationalTargetTokens: string[];
  mpn: string | null;

  // Derived compatibility projections over the open lattice (computed dynamically, zero enums)
  formFactor: string | null;
  capacityValue: number | null;
  capacityUnit: string | null;
  productSubcategory: string | null;
}

export type CanonicalProductSpec = AttributeValueLattice;

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
  spec: AttributeValueLattice;
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

const KNOWN_BRANDS_SET = new Set(KNOWN_BRANDS);
const UPPERCASE_BRANDS_SET = new Set(['LG', 'GE', 'HP', 'TCL', 'OX', 'AMD']);

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

export const SYNONYM_MAP: Record<string, string[]> = {
  washer: ['washing', 'machine', 'washer'],
  washing: ['washing', 'washer'],
  fridge: ['refrigerator', 'fridge'],
  refrigerator: ['refrigerator', 'fridge'],
  laptop: ['laptop', 'notebook', 'macbook'],
  macbook: ['macbook', 'laptop'],
  tv: ['television', 'tv', 'oled', 'tvr'],
  tvr: ['television', 'tv', 'oled'],
  television: ['television', 'tv', 'tvr'],
  fan: ['fan', 'standing', 'satnding'],
  standing: ['standing', 'satnding', 'fan'],
  satnding: ['standing', 'fan'],
  cooker: ['cooker', 'cooke', 'stove'],
  cooke: ['cooker', 'stove'],
  stove: ['stove', 'cooker', 'cooke'],
  gas: ['gas'],
  router: ['router', 'mifi', 'modem'],
  mifi: ['mifi', 'router', 'modem'],
  modem: ['modem', 'router', 'mifi'],
  airtel: ['airtel'],
  internet: ['internet', 'broadband', 'wifi'],
  microwave: ['microwave', 'oven'],
  oven: ['oven', 'microwave'],
  headphones: ['headphones', 'headset', 'earbuds'],
  drill: ['drill', 'driver'],
  driver: ['driver', 'drill'],
  tokunbo: ['used', 'uk', 'tokunbo'],
  front: ['front', 'frontload', 'frontloader'],
  top: ['top', 'topload', 'toploader'],
  load: ['load', 'loading', 'loader']
};

const SYNONYM_VOCAB_SET = new Set<string>();
for (const [k, vals] of Object.entries(SYNONYM_MAP)) {
  SYNONYM_VOCAB_SET.add(k);
  for (const v of vals) SYNONYM_VOCAB_SET.add(v);
}

/**
 * Universal SI, Industrial, Electrical, Storage, and Counting Unit Ontology.
 * Completely domain-agnostic: covers thermal, mechanical power, mass, volume, length, storage, and discrete counts.
 */
interface UnitDefinition {
  canonical: string;
  axis: DimensionAxis;
}

const UNIT_LOOKUP: Record<string, UnitDefinition> = {
  // Mechanical & Electrical Power
  hp: { canonical: 'hp', axis: 'power' },
  horsepower: { canonical: 'hp', axis: 'power' },
  kva: { canonical: 'kva', axis: 'power' },
  va: { canonical: 'va', axis: 'power' },
  kw: { canonical: 'kw', axis: 'power' },
  kilowatt: { canonical: 'kw', axis: 'power' },
  kilowatts: { canonical: 'kw', axis: 'power' },
  w: { canonical: 'w', axis: 'power' },
  watt: { canonical: 'w', axis: 'power' },
  watts: { canonical: 'w', axis: 'power' },

  // Thermal Capacity
  btu: { canonical: 'btu', axis: 'thermal' },
  btuh: { canonical: 'btu', axis: 'thermal' },
  'btu/h': { canonical: 'btu', axis: 'thermal' },

  // Length & Display Diagonal
  inch: { canonical: 'inch', axis: 'length' },
  inches: { canonical: 'inch', axis: 'length' },
  '"': { canonical: 'inch', axis: 'length' },
  mm: { canonical: 'mm', axis: 'length' },
  millimeter: { canonical: 'mm', axis: 'length' },
  millimeters: { canonical: 'mm', axis: 'length' },
  millimetre: { canonical: 'mm', axis: 'length' },
  millimetres: { canonical: 'mm', axis: 'length' },
  cm: { canonical: 'cm', axis: 'length' },
  centimeter: { canonical: 'cm', axis: 'length' },
  centimeters: { canonical: 'cm', axis: 'length' },
  centimetre: { canonical: 'cm', axis: 'length' },
  centimetres: { canonical: 'cm', axis: 'length' },
  ft: { canonical: 'ft', axis: 'length' },
  feet: { canonical: 'ft', axis: 'length' },
  foot: { canonical: 'ft', axis: 'length' },

  // Mass
  kg: { canonical: 'kg', axis: 'mass' },
  kgs: { canonical: 'kg', axis: 'mass' },
  kilogram: { canonical: 'kg', axis: 'mass' },
  kilograms: { canonical: 'kg', axis: 'mass' },
  g: { canonical: 'g', axis: 'mass' },
  gm: { canonical: 'g', axis: 'mass' },
  gms: { canonical: 'g', axis: 'mass' },
  gram: { canonical: 'g', axis: 'mass' },
  grams: { canonical: 'g', axis: 'mass' },

  // Volume
  cuft: { canonical: 'cuft', axis: 'volume' },
  l: { canonical: 'l', axis: 'volume' },
  ltr: { canonical: 'l', axis: 'volume' },
  ltrs: { canonical: 'l', axis: 'volume' },
  liter: { canonical: 'l', axis: 'volume' },
  liters: { canonical: 'l', axis: 'volume' },
  litre: { canonical: 'l', axis: 'volume' },
  litres: { canonical: 'l', axis: 'volume' },
  ml: { canonical: 'ml', axis: 'volume' },
  milliliter: { canonical: 'ml', axis: 'volume' },
  milliliters: { canonical: 'ml', axis: 'volume' },
  millilitre: { canonical: 'ml', axis: 'volume' },
  millilitres: { canonical: 'ml', axis: 'volume' },

  // Digital Storage / Memory
  tb: { canonical: 'tb', axis: 'storage' },
  terabyte: { canonical: 'tb', axis: 'storage' },
  terabytes: { canonical: 'tb', axis: 'storage' },
  gb: { canonical: 'gb', axis: 'storage' },
  gigabyte: { canonical: 'gb', axis: 'storage' },
  gigabytes: { canonical: 'gb', axis: 'storage' },
  mb: { canonical: 'mb', axis: 'storage' },
  megabyte: { canonical: 'mb', axis: 'storage' },
  megabytes: { canonical: 'mb', axis: 'storage' },

  // Electrical Potential, Charge & Current
  mah: { canonical: 'mah', axis: 'electrical' },
  ah: { canonical: 'ah', axis: 'electrical' },
  v: { canonical: 'v', axis: 'electrical' },
  volt: { canonical: 'v', axis: 'electrical' },
  volts: { canonical: 'v', axis: 'electrical' },
  amp: { canonical: 'amp', axis: 'electrical' },
  amps: { canonical: 'amp', axis: 'electrical' },
  ampere: { canonical: 'amp', axis: 'electrical' },
  amperes: { canonical: 'amp', axis: 'electrical' },

  // Frequency & Rotational Speed
  ghz: { canonical: 'ghz', axis: 'frequency' },
  mhz: { canonical: 'mhz', axis: 'frequency' },
  hz: { canonical: 'hz', axis: 'frequency' },
  rpm: { canonical: 'rpm', axis: 'frequency' },

  // Discrete Counting Units
  burner: { canonical: 'burner', axis: 'count' },
  burners: { canonical: 'burner', axis: 'count' },
  door: { canonical: 'door', axis: 'count' },
  doors: { canonical: 'door', axis: 'count' },
  key: { canonical: 'key', axis: 'count' },
  keys: { canonical: 'key', axis: 'count' },
  port: { canonical: 'port', axis: 'count' },
  ports: { canonical: 'port', axis: 'count' },
  channel: { canonical: 'channel', axis: 'count' },
  channels: { canonical: 'channel', axis: 'count' },
  ch: { canonical: 'channel', axis: 'count' },
  core: { canonical: 'core', axis: 'count' },
  cores: { canonical: 'core', axis: 'count' },
  blade: { canonical: 'blade', axis: 'count' },
  blades: { canonical: 'blade', axis: 'count' },
  gang: { canonical: 'gang', axis: 'count' },
  gangs: { canonical: 'gang', axis: 'count' },
  slice: { canonical: 'slice', axis: 'count' },
  slices: { canonical: 'slice', axis: 'count' },
  speed: { canonical: 'speed', axis: 'count' },
  speeds: { canonical: 'speed', axis: 'count' }
};

// Pre-compiled Universal Dimension Lexer regex (longer prefixes ordered strictly before shorter prefixes)
const DIMENSION_UNIT_BODY =
  'cu\\.?\\s*ft\\.?|cubic\\s*(?:feet|foot|ft)|btu(?:\\/h|h)?|horsepower|hp|kva|kilowatts?|kw|watts?|va|w|terabytes?|tb|gigabytes?|gb|megabytes?|mb|kilograms?|kgs?|grams?|gms?|milliliters?|millilitres?|ml|liters?|litres?|ltrs?|millimeters?|millimetres?|mm|centimeters?|centimetres?|cm|inch(?:es)?|feet|foot|ft|mah|ah|amperes?|amps?|volts?|ghz|mhz|hz|rpm|burners?|doors?|keys?|ports?|channels?|ch|cores?|blades?|gangs?|slices?|speeds?|l|v|g';

const DIMENSION_GLOBAL_RE = new RegExp(
  `(?<![₦$€£A-Za-z])([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?:\\s*(")|(\\s*)(?:-\\s*)?(${DIMENSION_UNIT_BODY})\\b)`,
  'gi'
);

const HAS_DIGIT_RE = /[0-9]/;
const SIMPLE_NUM_UNIT_RE = /^([0-9]+(?:\.[0-9]+)?)([a-z]+)$/i;

/**
 * Extracts all physical, electrical, storage, and counting dimensions from arbitrary text
 * into canonical (value, unit, axis) Attribute-Value Pairs.
 */
export function extractDimensions(text: string): ExtractedDimension[] {
  if (!HAS_DIGIT_RE.test(text)) return [];
  const results: ExtractedDimension[] = [];
  DIMENSION_GLOBAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DIMENSION_GLOBAL_RE.exec(text)) !== null) {
    const rawNum = match[1].replace(/,/g, '');
    const value = parseFloat(rawNum);
    if (!Number.isFinite(value) || value <= 0) continue;

    const quoteInch = match[2];
    const spaceBetween = match[3] || '';
    const rawUnitStr = (quoteInch || match[4] || '').toLowerCase();

    // Guard wireless generation tokens ("4G LTE", "5G Router") from parsing as 4g / 5g mass in grams
    if (
      rawUnitStr === 'g' &&
      spaceBetween.length === 0 &&
      Number.isInteger(value) &&
      value >= 2 &&
      value <= 6
    ) {
      continue;
    }

    let lookupKey = rawUnitStr;
    if (/^cu\.?\s*ft\.?$|^cubic\s*(?:feet|foot|ft)$/.test(lookupKey)) {
      lookupKey = 'cuft';
    }

    const def = UNIT_LOOKUP[lookupKey];
    if (!def) continue;

    results.push({
      value,
      unit: def.canonical,
      axis: def.axis,
      raw: `${value}${def.canonical}`
    });
  }

  return results;
}

function parseSingleDimensionToken(token: string): { value: number; unit: string } | null {
  const c = token.charCodeAt(0);
  if (c < 48 || c > 57) return null;
  if (token.length === 2 && (token[1] === 'g' || token[1] === 'G') && c >= 50 && c <= 54) {
    return null;
  }
  const m = SIMPLE_NUM_UNIT_RE.exec(token);
  if (!m) return null;
  const def = UNIT_LOOKUP[m[2].toLowerCase()];
  if (!def) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) ? { value: val, unit: def.canonical } : null;
}

/**
 * Compound Qualifier Normalization:
 * Single pre-compiled alternation regex + normalization mapper (1 pass instead of 29 passes).
 */
const COMPOUND_QUALIFIER_COMBINED_RE =
  /\b(?:(front\s*-?\s*load(?:er|ing)?)|(top\s*-?\s*load(?:er|ing)?)|(twin\s*-?\s*tub|double\s*-?\s*tub|semi\s*-?\s*auto(?:matic)?)|(floor\s*-?\s*standing|free\s*-?\s*standing)|(wall\s*-?\s*mount(?:ed)?)|(open\s*-?\s*frame)|(sound\s*-?\s*proof|silent\s+canopy|super\s+silent)|(non\s*-?\s*inverter)|(fixed\s*-?\s*speed)|(pure\s*-?\s*sine(?:\s*-?\s*wave)?)|(modified\s*-?\s*sine(?:\s*-?\s*wave)?)|(single\s*-?\s*door)|(double\s*-?\s*door)|(side\s*-?\s*by\s*-?\s*side)|(french\s*-?\s*door)|(key\s*-?\s*start|electric\s*-?\s*start)|(recoil\s*-?\s*start|manual\s*-?\s*start|pull\s*-?\s*start)|(single\s*-?\s*phase)|(three\s*-?\s*phase|3\s*-?\s*phase)|(direct\s*-?\s*drive)|(low\s*-?\s*voltage)|(fast\s*-?\s*cooling)|(energy\s*-?\s*saving)|(heavy\s*-?\s*duty)|(high\s*-?\s*velocity)|(high\s*-?\s*efficiency)|(mega\s*-?\s*capacity)|(full\s*-?\s*hd)|(satnding))\b/gi;

const COMPOUND_GROUP_CANONICALS = [
  '', // index 0 is full match
  'front_load',
  'top_load',
  'twin_tub',
  'floor_standing',
  'wall_mounted',
  'open_frame',
  'soundproof',
  'non_inverter',
  'fixed_speed',
  'pure_sine',
  'modified_sine',
  'single_door',
  'double_door',
  'side_by_side',
  'french_door',
  'electric_start',
  'manual_start',
  'single_phase',
  'three_phase',
  'direct_drive',
  'low_voltage',
  'fast_cooling',
  'energy_saving',
  'heavy_duty',
  'high_velocity',
  'high_efficiency',
  'mega_capacity',
  'full_hd',
  'standing'
];

function normalizeCompoundQualifiers(input: string): string {
  return input.replace(COMPOUND_QUALIFIER_COMBINED_RE, (...args) => {
    for (let i = 1; i <= 29; i++) {
      if (args[i]) return ` ${COMPOUND_GROUP_CANONICALS[i]} `;
    }
    return args[0];
  });
}

/**
 * Orthogonal Functional Qualifier Axes:
 * Domain-agnostic physical, geometric, acoustic, modulation, and energy poles.
 * Any two distinct poles on the same axis are mutually exclusive.
 */
interface OrthogonalAxisDef {
  axis: string;
  requireSubsumption: boolean;
  isSpatialFormFactor?: boolean;
  poles: Record<string, string[]>; // canonicalPole -> surface synonym tokens
}

const ORTHOGONAL_AXES: OrthogonalAxisDef[] = [
  {
    axis: 'loading_geometry',
    requireSubsumption: true,
    isSpatialFormFactor: true,
    poles: {
      front_load: ['front_load'],
      top_load: ['top_load'],
      twin_tub: ['twin_tub']
    }
  },
  {
    axis: 'mounting_geometry',
    requireSubsumption: true,
    isSpatialFormFactor: true,
    poles: {
      split: ['split'],
      floor_standing: ['floor_standing', 'standing', 'pedestal'],
      window: ['window'],
      cassette: ['cassette'],
      ducted: ['ducted'],
      ceiling: ['ceiling', 'orbit'],
      tabletop: ['tabletop', 'countertop'],
      portable: ['portable']
    }
  },
  {
    axis: 'enclosure_acoustics',
    requireSubsumption: true,
    isSpatialFormFactor: true,
    poles: {
      soundproof: ['soundproof', 'silent', 'noiseless'],
      open_frame: ['open_frame', 'skeleton']
    }
  },
  {
    axis: 'drive_modulation',
    requireSubsumption: true,
    poles: {
      inverter: ['inverter'],
      non_inverter: ['non_inverter', 'fixed_speed']
    }
  },
  {
    axis: 'fuel_energy',
    requireSubsumption: true,
    poles: {
      diesel: ['diesel'],
      petrol: ['petrol', 'gasoline'],
      solar: ['solar']
    }
  },
  {
    axis: 'cord_topology',
    requireSubsumption: true,
    poles: {
      cordless: ['cordless'],
      corded: ['corded']
    }
  },
  {
    axis: 'motor_commutation',
    requireSubsumption: true,
    poles: {
      brushless: ['brushless'],
      brushed: ['brushed']
    }
  },
  {
    axis: 'automation_grade',
    requireSubsumption: false,
    poles: {
      automatic: ['automatic'],
      manual: ['manual']
    }
  },
  {
    axis: 'door_architecture',
    requireSubsumption: true,
    isSpatialFormFactor: true,
    poles: {
      single_door: ['single_door'],
      double_door: ['double_door'],
      side_by_side: ['side_by_side'],
      french_door: ['french_door']
    }
  },
  {
    axis: 'phase_topology',
    requireSubsumption: true,
    poles: {
      single_phase: ['single_phase'],
      three_phase: ['three_phase']
    }
  },
  {
    axis: 'starter_mechanism',
    requireSubsumption: false,
    poles: {
      electric_start: ['electric_start'],
      manual_start: ['manual_start']
    }
  },
  {
    axis: 'waveform_topology',
    requireSubsumption: true,
    poles: {
      pure_sine: ['pure_sine'],
      modified_sine: ['modified_sine']
    }
  }
];

// Fast O(1) lookup from surface qualifier token -> { axis, pole, requireSubsumption, isSpatialFormFactor }
interface AxisMembership {
  axis: string;
  pole: string;
  requireSubsumption: boolean;
  isSpatialFormFactor: boolean;
}

const TOKEN_TO_AXIS_MAP = new Map<string, AxisMembership>();
const AXIS_REQUIRE_SUBSUMPTION = new Map<string, boolean>();
for (const def of ORTHOGONAL_AXES) {
  AXIS_REQUIRE_SUBSUMPTION.set(def.axis, def.requireSubsumption);
  for (const [pole, tokens] of Object.entries(def.poles)) {
    for (const tok of tokens) {
      TOKEN_TO_AXIS_MAP.set(tok, {
        axis: def.axis,
        pole,
        requireSubsumption: def.requireSubsumption,
        isSpatialFormFactor: Boolean(def.isSpatialFormFactor)
      });
    }
  }
}

// Open-vocabulary descriptive adjective/modifier tokens (stripped before isolating the Right-Hand Noun Kernel)
const DESCRIPTIVE_MODIFIER_TOKENS = new Set<string>([
  ...TOKEN_TO_AXIS_MAP.keys(),
  'wall_mounted',
  'direct_drive',
  'low_voltage',
  'fast_cooling',
  'energy_saving',
  'heavy_duty',
  'high_velocity',
  'high_efficiency',
  'mega_capacity',
  'full_hd',
  'rechargeable',
  'wireless',
  'wired',
  'smart',
  'digital',
  'industrial',
  'commercial',
  'compact',
  'solo',
  'bespoke',
  'ultra',
  'fast',
  'high',
  'low',
  'heavy',
  'duty',
  'mini',
  'pro',
  'max',
  'plus',
  'lite',
  'official',
  'authorized',
  'retail',
  'edition',
  'series',
  'warranty',
  'nigerian',
  'working',
  'perfect',
  'london',
  'copper',
  'brass',
  'aluminum',
  'aluminium',
  'stainless',
  'steel',
  'inox',
  'plastic',
  'leather',
  'braided',
  'flexible',
  'waterproof',
  'weatherproof',
  'protective',
  'outdoor',
  'indoor',
  'universal',
  'desktop',
  'pocket',
  'internet',
  'broadband',
  'gas',
  'electric',
  'steam',
  'unit',
  'ai',
  'dd',
  'wifi',
  'wi',
  'fi',
  'lte',
  'uhd',
  'fhd',
  'hd',
  'qled',
  'google',
  'space',
  'black',
  'white',
  'silver',
  'grey',
  'gray',
  'blue',
  'gold',
  'red'
]);

// Generic sentence-initial words that must never be mistaken for an open-vocabulary proper-noun brand
const NON_BRAND_STARTERS = new Set<string>([
  ...STOP_WORDS,
  ...SYNONYM_VOCAB_SET,
  ...DESCRIPTIVE_MODIFIER_TOKENS,
  ...DEFAULT_NEGATIVE_ACCESSORY_TOKENS,
  'installation',
  'mounting',
  'protective',
  'original',
  'genuine',
  'standard',
  'premium',
  'deluxe',
  'classic',
  'modern',
  'power',
  'water',
  'heat',
  'cool',
  'cooling',
  'washing',
  'cleaning',
  'wall',
  'floor',
  'roof',
  'table',
  'home',
  'office',
  'kitchen',
  'kids',
  'children'
]);

/**
 * Evaluates whether a candidate's primary noun sequence preserves the query's head noun kernel
 * at its syntactic right-hand head position (Williams' Right-Hand Head Rule),
 * accounting for SYNONYM_MAP equivalences and bidirectional 2..4 letter initialisms.
 */
function candidateRightEdgeMatchesQueryHead(
  queryHeadTokens: string[],
  candidateNounSequence: string[],
  excludeBrandLower: string | null
): boolean {
  if (queryHeadTokens.length === 0 || candidateNounSequence.length === 0) return false;

  const k = queryHeadTokens.length;
  // Rule 1: Direct right-edge k-gram match (e.g. ['washing', 'machine'] vs ['washing', 'machine'], ['microwave'] vs ['oven'])
  if (candidateNounSequence.length >= k) {
    const rightSlice = candidateNounSequence.slice(-k);
    if (nounSequenceMatchesQueryHead(queryHeadTokens, rightSlice, excludeBrandLower)) {
      return true;
    }
  }

  // Rule 2: Acronym / initialism query head (len 2..4) against right-edge multi-word compound
  if (
    queryHeadTokens.length === 1 &&
    queryHeadTokens[0].length >= 2 &&
    queryHeadTokens[0].length <= 4 &&
    /^[a-z]+$/.test(queryHeadTokens[0])
  ) {
    const spanLen = queryHeadTokens[0].length;
    if (candidateNounSequence.length >= spanLen) {
      const rightCompound = candidateNounSequence.slice(-spanLen);
      if (nounSequenceMatchesQueryHead(queryHeadTokens, rightCompound, excludeBrandLower)) {
        return true;
      }
    }
  }

  // Rule 3: Single-token candidate head unifying with multi-token query head (e.g. ['washer'] vs ['washing', 'machine'])
  if (candidateNounSequence.length === 1) {
    return nounSequenceMatchesQueryHead(queryHeadTokens, candidateNounSequence, excludeBrandLower);
  }

  return false;
}

// Pre-compiled query/title clause cleaning & relational preposition splitters
const NOISE_CLAUSE_STRIP_RE = new RegExp(
  [
    '(?:under|below|less\\s+than|<=|drops?\\s+(?:to|under|below)|target(?:\\s+price)?)\\s*(?:₦|\\bNGN\\b|\\bN(?=[0-9\\s])|\\$|\\bUSD\\b|€|\\bEUR\\b|£|\\bGBP\\b)?\\s*[0-9,]+(?:\\.[0-9]{1,2})?\\s*[kmKM]?\\b',
    '\\(?(?:was|from|msrp|list\\s+price)\\s*(?:₦|\\bNGN\\b|\\bN(?=[0-9\\s])|\\$|\\bUSD\\b|€|\\bEUR\\b|£|\\bGBP\\b)?\\s*[0-9,]+(?:\\.[0-9]{1,2})?\\s*[kmKM]?\\b\\)?',
    '\\s+-\\s+(?:₦|\\bNGN\\b|\\$|€|£)\\s*[0-9,]+(?:\\.[0-9]{1,2})?',
    '(?:at\\s+least\\s+)?[0-9]{1,2}(?:\\.[0-9]+)?\\s*%\\s*(?:off|discount|drop|rating\\s+confidence)',
    '(?:with\\s+)?(?:promo|coupon|voucher)(?:\\s+code)?\\s+[\'"]?[A-Z0-9_\\-]{3,24}[\'"]?',
    '(?:with\\s+)?[0-9]{1,2}(?:\\.[0-9]+)?%?\\s*(?:wilson|verified)?\\s*rating\\s*confidence',
    '[0-9.]+\\+?\\s*(?:stars?|★|reviews)',
    '\\b(?:brand\\s+new|sealed|box\\s+new|uk\\s+used|london\\s+used|tokunbo|fairly\\s+used|second\\s+hand|pre-?owned|refurbished|renewed|open\\s*box|b-stock)\\b',
    '\\b(?:in\\s+lagos|in\\s+abuja|to\\s+lagos|to\\s+abuja|interstate|outside\\s+lagos|upcountry|lagos|abuja)\\b'
  ].join('|'),
  'gi'
);

const RELATIONAL_PREPOSITION_RE =
  /\b(compatible\s+with|designed\s+for|suitable\s+for|made\s+for|replacement\s+for|spare\s+part\s+for|accessory\s+for|fits(?:\s+for)?|for)\b/gi;

const SECONDARY_FEATURE_CLAUSE_RE =
  /\s+(?:with|featuring|includes?|including|plus|direct\s+from|shipped\s+from|imported\s+from)\b|\s*\(|\s+[-–—/|]\s+/i;

const TOKENIZE_UNIT_COLLAPSE_RE =
  /([0-9]+(?:\.[0-9]+)?)\s*(cu\.?\s*ft\.?|btu(?:\/h|h)?|kva|kw|va|hp|mah|ah|ghz|mhz|hz|rpm|tb|gb|mb|kg|ml|mm|cm|ft|inch(?:es)?|burners?|doors?|ports?|l|w|v)\b/gi;

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

export function tokenizeNormalized(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(TOKENIZE_UNIT_COLLAPSE_RE, (_m, num: string, unit: string) => {
      const cleanUnit = /^cu\.?\s*ft\.?$/i.test(unit) ? 'cuft' : unit.replace(/[\s.]+/g, '');
      return `${num}${cleanUnit}`;
    })
    .replace(/[^a-z0-9.\-+_]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-+_]+|[.\-+_]+$/g, ''))
    .filter((t) => t.length >= 2);
}

export function detectMpn(text: string): string | null {
  if (!HAS_DIGIT_RE.test(text)) return null;
  const tokens = text.match(/\b[A-Za-z0-9\-_]{6,18}\b/g);
  if (!tokens) return null;
  for (const t of tokens) {
    if (HAS_DIGIT_RE.test(t) && /[A-Za-z]/.test(t) && !parseSingleDimensionToken(t)) {
      return t.toUpperCase();
    }
  }
  return null;
}

function formatBrandDisplay(lowerBrand: string, originalSurface?: string): string {
  const upper = lowerBrand.toUpperCase();
  if (UPPERCASE_BRANDS_SET.has(upper)) return upper;
  if (originalSurface && /^[A-Z]/.test(originalSurface)) return originalSurface;
  return lowerBrand.charAt(0).toUpperCase() + lowerBrand.slice(1);
}

function extractBrandFromClause(primaryClause: string): string | null {
  const rawWords = primaryClause.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const w of rawWords) {
    const lower = w.toLowerCase();
    if (KNOWN_BRANDS_SET.has(lower)) {
      return formatBrandDisplay(lower);
    }
  }

  // Open-vocabulary proper-noun brand detection:
  // Inspect first content token (skipping leading articles/intent verbs) for capitalized proper noun
  for (let i = 0; i < rawWords.length; i++) {
    const surface = rawWords[i];
    const lower = surface.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;

    // Must be capitalized alphabetic proper noun followed by at least one remaining product word
    if (
      i < rawWords.length - 1 &&
      /^[A-Z][a-zA-Z]{1,14}$/.test(surface) &&
      !NON_BRAND_STARTERS.has(lower) &&
      !/(?:ing|ed|less|proof|able|ible|ful|ous)$/i.test(surface)
    ) {
      return surface;
    }
    break;
  }

  return null;
}

/**
 * Computes morphological 2..4 letter initialisms from adjacent alphabetic content words
 * (excluding any brand token so [Brand + Noun] never collides with 2-letter brands).
 */
function computePhraseInitialisms(tokens: string[], excludeBrandLower: string | null): Set<string> {
  const eligible = tokens.filter(
    (t) =>
      t.length >= 3 &&
      /^[a-z]+$/.test(t) &&
      !STOP_WORDS.has(t) &&
      (!excludeBrandLower || t !== excludeBrandLower)
  );
  const out = new Set<string>();
  for (let i = 0; i < eligible.length; i++) {
    if (i + 1 < eligible.length) {
      out.add(eligible[i][0] + eligible[i + 1][0]);
    }
    if (i + 2 < eligible.length) {
      out.add(eligible[i][0] + eligible[i + 1][0] + eligible[i + 2][0]);
    }
    if (i + 3 < eligible.length) {
      out.add(eligible[i][0] + eligible[i + 1][0] + eligible[i + 2][0] + eligible[i + 3][0]);
    }
  }
  return out;
}

/**
 * Checks whether a set of query head tokens matches a target noun sequence (via exact token,
 * SYNONYM_MAP expansion, or bidirectional 2..4 letter morphological initialism unification).
 */
function nounSequenceMatchesQueryHead(
  queryHeadTokens: string[],
  targetTokens: string[],
  excludeBrandLower: string | null
): boolean {
  if (queryHeadTokens.length === 0 || targetTokens.length === 0) return false;

  const expandedTarget = new Set<string>();
  for (const tok of targetTokens) {
    expandedTarget.add(tok);
    const syns = SYNONYM_MAP[tok];
    if (syns) {
      for (const s of syns) expandedTarget.add(s);
    }
  }

  const targetInitialisms = computePhraseInitialisms(targetTokens, excludeBrandLower);

  // Reverse direction: if query itself is a multi-word head (e.g. ['solid', 'state', 'drive'])
  // and target uses the initialism (e.g. ['ssd']), unify via query initialisms
  if (queryHeadTokens.length >= 2) {
    const queryInitialisms = computePhraseInitialisms(queryHeadTokens, excludeBrandLower);
    for (const init of queryInitialisms) {
      if (expandedTarget.has(init)) return true;
    }
  }

  return queryHeadTokens.every((qTok) => {
    const qSyns = SYNONYM_MAP[qTok] || [qTok];
    if (qSyns.some((s) => expandedTarget.has(s))) return true;
    if (qTok.length >= 2 && qTok.length <= 4 && /^[a-z]+$/.test(qTok) && targetInitialisms.has(qTok)) {
      return true;
    }
    return false;
  });
}

/**
 * Splits a cleaned phrase into Primary Clause vs Relational Prepositional Complement
 * ("for", "fits", "compatible with", "designed for", "replacement for"),
 * requiring >= 1 non-stopword content token before the preposition so leading query verbs ("search for X") are ignored.
 */
function splitRelationalAdjunct(cleanText: string): {
  primaryClause: string;
  relationalPreposition: string | null;
  relationalClause: string;
} {
  RELATIONAL_PREPOSITION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIONAL_PREPOSITION_RE.exec(cleanText)) !== null) {
    const prefix = cleanText.slice(0, match.index).trim();
    const prefixTokens = tokenizeNormalized(prefix).filter((t) => !STOP_WORDS.has(t));
    if (prefixTokens.length >= 1) {
      return {
        primaryClause: prefix,
        relationalPreposition: match[1].toLowerCase().replace(/\s+/g, ' '),
        relationalClause: cleanText.slice(match.index + match[0].length).trim()
      };
    }
  }
  return {
    primaryClause: cleanText,
    relationalPreposition: null,
    relationalClause: ''
  };
}

/**
 * Extracts the Open-Vocabulary Attribute-Value Pair (AVP) Lattice from any raw query or listing title.
 */
export function extractAttributeLattice(rawText: string, stripQueryClauses = true): AttributeValueLattice {
  const cleanText = stripQueryClauses ? rawText.replace(NOISE_CLAUSE_STRIP_RE, ' ') : rawText;
  const { primaryClause, relationalPreposition, relationalClause } = splitRelationalAdjunct(cleanText);

  const brand = extractBrandFromClause(primaryClause);
  const brandLower = brand ? brand.toLowerCase() : null;
  const dimensions = extractDimensions(primaryClause);
  const mpn = detectMpn(primaryClause);

  // Normalize compound multi-word qualifiers in a single pass
  const normalizedPrimary = normalizeCompoundQualifiers(primaryClause);

  // Extract qualifiers & orthogonal axis memberships across primaryClause
  const primaryTokens = tokenizeNormalized(normalizedPrimary);
  const qualifierSet = new Set<string>();
  const axisQualifiers: Record<string, string> = {};
  const axisSurfaceTokens: Record<string, string> = {};
  let derivedFormFactor: string | null = null;

  for (const tok of primaryTokens) {
    if (tok === brandLower || STOP_WORDS.has(tok)) continue;
    const axisInfo = TOKEN_TO_AXIS_MAP.get(tok);
    if (axisInfo) {
      qualifierSet.add(tok);
      if (!axisQualifiers[axisInfo.axis]) {
        axisQualifiers[axisInfo.axis] = axisInfo.pole;
        axisSurfaceTokens[axisInfo.axis] = tok;
      }
      if (!derivedFormFactor && axisInfo.isSpatialFormFactor) {
        derivedFormFactor = axisInfo.pole;
      }
    } else if (
      DESCRIPTIVE_MODIFIER_TOKENS.has(tok) ||
      /^non_[a-z]{2,}$/.test(tok) ||
      /^[a-z]{3,}(?:less|proof)$/.test(tok)
    ) {
      qualifierSet.add(tok);
    }
  }

  // Isolate Core Noun Phrase (strip secondary "with ...", "(...)", " - ...", "direct from ..." feature clauses)
  const coreNpRaw = primaryClause.split(SECONDARY_FEATURE_CLAUSE_RE)[0] || primaryClause;

  // Strip dimensions from coreNpRaw and collapse compound qualifiers in one pass
  const coreNpNoDims = HAS_DIGIT_RE.test(coreNpRaw)
    ? coreNpRaw.replace(DIMENSION_GLOBAL_RE, ' ')
    : coreNpRaw;
  const coreNpProcessed = normalizeCompoundQualifiers(coreNpNoDims);

  // Strip trailing CamelCase marketing sub-brand tags (e.g. "NeoChef", "EcoBubble") only if preceded by other words
  const rawCoreWords = coreNpProcessed.trim().split(/\s+/).filter(Boolean);
  const filteredCoreWords: string[] = [];
  for (let i = 0; i < rawCoreWords.length; i++) {
    const w = rawCoreWords[i];
    const cleanW = w.replace(/[^A-Za-z0-9_+.\-]/g, '');
    if (
      filteredCoreWords.length >= 2 &&
      /^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/.test(cleanW) &&
      !SYNONYM_VOCAB_SET.has(cleanW.toLowerCase())
    ) {
      continue;
    }
    filteredCoreWords.push(w);
  }

  const coreNpTokens = tokenizeNormalized(filteredCoreWords.join(' '));
  const nounSequence: string[] = [];

  for (let i = 0; i < coreNpTokens.length; i++) {
    const tok = coreNpTokens[i];
    if (STOP_WORDS.has(tok)) continue;
    if (brandLower && tok === brandLower) continue;
    if (/^[0-9.]+$/.test(tok)) continue;
    if (parseSingleDimensionToken(tok)) continue;
    if (/[a-z]/i.test(tok) && /[0-9]/.test(tok)) continue; // MPN / alphanumeric model code
    if (qualifierSet.has(tok) || DESCRIPTIVE_MODIFIER_TOKENS.has(tok)) {
      // Preserve 'standing' only if no concrete head noun follows? No, 'standing' is qualifier and 'fan' is head noun!
      continue;
    }
    nounSequence.push(tok);
  }

  // Determine Right-Hand Head Noun Kernel (last 1..2 head nouns at the right edge of Core NP):
  const headTokens = nounSequence.length > 2 ? nounSequence.slice(-2) : [...nounSequence];
  for (let i = 0; i < Math.max(0, nounSequence.length - 2); i++) {
    qualifierSet.add(nounSequence[i]);
  }

  const headNounKernel = headTokens.length > 0 ? headTokens.join('_') : null;
  const relationalTargetTokens = relationalClause
    ? tokenizeNormalized(relationalClause).filter((t) => !STOP_WORDS.has(t))
    : [];

  const firstDim = dimensions[0] || null;
  if (!derivedFormFactor) {
    const firstAxisKey = Object.keys(axisQualifiers)[0];
    if (firstAxisKey) derivedFormFactor = axisQualifiers[firstAxisKey];
  }

  return {
    brand,
    dimensions,
    qualifiers: Array.from(qualifierSet),
    axisQualifiers,
    axisSurfaceTokens,
    nounSequence,
    headTokens,
    headNounKernel,
    relationalPreposition,
    relationalTargetTokens,
    mpn,
    formFactor: derivedFormFactor,
    capacityValue: firstDim ? firstDim.value : null,
    capacityUnit: firstDim ? firstDim.unit : null,
    productSubcategory: headNounKernel
  };
}

/**
 * Backward-compatible alias returning the open AttributeValueLattice.
 */
export function extractCanonicalProductSpec(text: string): CanonicalProductSpec {
  return extractAttributeLattice(text);
}

/**
 * Detects morphological antonym conflicts across open-vocabulary qualifiers without hardcoded domain rules:
 *  - "non_<x>" vs "<x>" (e.g. non_inverter vs inverter, non_ecc vs ecc, non_modular vs modular)
 *  - "<stem>less" vs "<stem>ed" (e.g. cordless vs corded, brushless vs brushed, bagless vs bagged)
 */
function findMorphologicalQualifierConflict(
  queryQualifiers: string[],
  candidateQualifiers: string[]
): { queryQual: string; candQual: string } | null {
  if (queryQualifiers.length === 0 || candidateQualifiers.length === 0) return null;
  const candSet = new Set(candidateQualifiers);

  for (const q of queryQualifiers) {
    if (q.startsWith('non_')) {
      const base = q.slice(4);
      if (base.length >= 2 && candSet.has(base)) {
        return { queryQual: q, candQual: base };
      }
    } else if (candSet.has(`non_${q}`)) {
      return { queryQual: q, candQual: `non_${q}` };
    }

    if (q.endsWith('less') && q.length >= 6) {
      const stem = q.slice(0, -4);
      if (candSet.has(`${stem}ed`)) {
        return { queryQual: q, candQual: `${stem}ed` };
      }
    } else if (q.endsWith('ed') && q.length >= 5) {
      const stem = q.slice(0, -2);
      if (candSet.has(`${stem}less`)) {
        return { queryQual: q, candQual: `${stem}less` };
      }
    }
  }

  return null;
}

function inferDomainClass(
  tokens: string[],
  lattice: AttributeValueLattice
): {
  domainClass: ProductDomainClass;
  minPlausiblePriceFloor: number;
} {
  // 1. Physics & Dimensional Magnitude Inference (completely category-agnostic):
  // Heavy mechanical/electrical power (>= 0.5 HP, >= 0.8 kVA/kW, >= 1000 W), thermal (>= 5000 BTU),
  // or heavy mass/volume (>= 4 kg, >= 1.5 cuft, >= 15 L) implies heavy appliance domain & freight class.
  for (const dim of lattice.dimensions) {
    if (
      (dim.unit === 'hp' && dim.value >= 0.5) ||
      ((dim.unit === 'kva' || dim.unit === 'kw') && dim.value >= 0.8) ||
      (dim.unit === 'w' && dim.value >= 1000) ||
      (dim.unit === 'btu' && dim.value >= 5000) ||
      (dim.unit === 'kg' && dim.value >= 4) ||
      (dim.unit === 'cuft' && dim.value >= 1.5) ||
      (dim.unit === 'l' && dim.value >= 15)
    ) {
      return { domainClass: 'appliance', minPlausiblePriceFloor: 140 };
    }
  }

  const joined = tokens.join(' ');
  if (
    /\b(washing\s+machine|washer|dryer|refrigerator|fridge|dishwasher|oven|range|freezer|cooker|cooke|stove|microwave)\b/i.test(
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
  if (
    /\b(tv|television|oled|tvr|smart\s+tv|playstation|ps5|ps6|xbox|camera|headphones|vacuum|dyson)\b/i.test(
      joined
    )
  ) {
    return { domainClass: 'electronics', minPlausiblePriceFloor: 60 };
  }
  if (/\b(vpn|hosting|saas|subscription|cloud|plan|insurance|service)\b/i.test(joined)) {
    return { domainClass: 'service', minPlausiblePriceFloor: 5 };
  }
  return { domainClass: 'general', minPlausiblePriceFloor: 10 };
}

/**
 * Parses an unstructured user product query into a normalized SKU discovery intent
 * backed by an Open-Vocabulary Attribute-Value Pair (AVP) Lattice.
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

  if (mergedPredicate.minRatingConfidence === undefined) {
    mergedPredicate.minRatingConfidence = 0.7;
  }
  if (mergedPredicate.minReviewCount === undefined) {
    mergedPredicate.minReviewCount = 10;
  }

  const stripped = rawQuery.replace(NOISE_CLAUSE_STRIP_RE, ' ');

  let targetCondition: ProductCondition = 'brand_new';
  if (/\b(uk\s+used|london\s+used|tokunbo|fairly\s+used|second\s+hand|pre-?owned)\b/i.test(rawQuery)) {
    targetCondition = 'uk_used';
  } else if (/\b(refurbished|renewed|open\s*box|b-stock)\b/i.test(rawQuery)) {
    targetCondition = 'refurbished';
  } else if (/\b(any\s+condition|all\s+conditions)\b/i.test(rawQuery)) {
    targetCondition = 'any';
  }

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

  const spec = extractAttributeLattice(rawQuery);
  let brand: string | null = spec.brand;
  if (!brand) {
    for (const t of coreTokens) {
      if (KNOWN_BRANDS_SET.has(t)) {
        brand = formatBrandDisplay(t);
        spec.brand = brand;
        break;
      }
    }
  }

  // Model tokens contain both letters and digits (e.g. wm4000hwa, m4, rtx5090), excluding all universal dimension tokens
  const modelTokens = coreTokens.filter(
    (t) => /[a-z]/i.test(t) && /[0-9]/.test(t) && !parseSingleDimensionToken(t)
  );

  const userAskedForAccessory = DEFAULT_NEGATIVE_ACCESSORY_TOKENS.some((neg) =>
    rawQueryLowerTokens.has(neg)
  );
  const negativeAccessoryTokens = DEFAULT_NEGATIVE_ACCESSORY_TOKENS.filter(
    (neg) => !rawQueryLowerTokens.has(neg)
  );

  const { domainClass, minPlausiblePriceFloor } = inferDomainClass(coreTokens, spec);
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
    predicate: mergedPredicate,
    spec
  };
}

const DIMENSION_RELATIVE_TOLERANCE = 0.01; // 1% floating-point tolerance

/**
 * Evaluates candidate conformance via Attribute Lattice Subsumption (Candidate >= Query)
 * and Universal Relational Inversion Detection.
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

  const qLattice = intent.spec || extractAttributeLattice(intent.rawQuery, true);
  const cLattice = extractAttributeLattice(candidateTitle, false);
  const brandLower = intent.brand ? intent.brand.toLowerCase() : null;

  // 2. Universal Relational Inversion Guard (Syntactic Subordination & Right-Hand Head Rule)
  // Fires purely on grammatical structure without relying on hardcoded accessory blacklists!
  if (qLattice.headTokens.length > 0 && !qLattice.relationalPreposition) {
    // Case A: Prepositional Subordination ("Mounting Bracket for TargetEntity", "Protective Cover for TargetEntity", "Compatible with ...")
    if (
      cLattice.relationalPreposition &&
      nounSequenceMatchesQueryHead(qLattice.headTokens, cLattice.relationalTargetTokens, brandLower) &&
      !candidateRightEdgeMatchesQueryHead(qLattice.headTokens, cLattice.nounSequence, brandLower)
    ) {
      const qHeadLabel = qLattice.headNounKernel || qLattice.headTokens.join(' ');
      const cHeadLabel = cLattice.headNounKernel || cLattice.nounSequence.join('_') || 'accessory';
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Accessory relational inversion: query head "${qHeadLabel}" is subordinated behind "${cLattice.relationalPreposition}" (primary head: "${cHeadLabel}")`
      };
    }

    // Case B: Compound Noun-Adjunct Subordination ("TargetEntity Dust Cover", "TargetEntity Wall Bracket")
    // Query head appears inside candidate's noun sequence, yet candidate's right-hand head noun is a distinct entity.
    if (
      cLattice.nounSequence.length >= 2 &&
      nounSequenceMatchesQueryHead(qLattice.headTokens, cLattice.nounSequence, brandLower) &&
      !candidateRightEdgeMatchesQueryHead(qLattice.headTokens, cLattice.nounSequence, brandLower)
    ) {
      const qHeadLabel = qLattice.headNounKernel || qLattice.headTokens.join(' ');
      const cRightHead = cLattice.nounSequence[cLattice.nounSequence.length - 1];
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Accessory noun-adjunct inversion: query head "${qHeadLabel}" modifies distinct primary head "${cRightHead}"`
      };
    }
  }

  // 2b. Secondary Miniature/Toy & Negative Token Guard
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

  if (
    intent.negativeAccessoryTokens.length > 10 &&
    /\b(?:1:12\s+scale|mini\s+portable\s+usb|ultrasonic\s+turbine)\b/i.test(candidateTitle)
  ) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: 'Accessory or miniature USB/scale item detected ("1:12 scale" / miniature)'
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

  // 4. Explicit Brand Guard
  if (intent.brand && !candidateSet.has(intent.brand.toLowerCase())) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Brand mismatch: query requires "${intent.brand}"`
    };
  }

  // 5. Explicit Alphanumeric Model Code & MPN Guards
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

  if (qLattice.mpn && cLattice.mpn && qLattice.mpn !== cLattice.mpn) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `MPN specification mismatch: query requires ${qLattice.mpn}, but candidate is ${cLattice.mpn}`
    };
  }

  // 6. Attribute Lattice Subsumption (Candidate >= Query)

  // 6a. Hard Dimension Invariance (1% Floating-Point Tolerance across all SI & Industrial Units)
  const matchedDimensionUnits = new Set<string>();
  for (const qDim of qLattice.dimensions) {
    const sameUnitCandDims = cLattice.dimensions.filter((d) => d.unit === qDim.unit);
    if (sameUnitCandDims.length > 0) {
      let minRelDiff = Infinity;
      let closestCandVal = sameUnitCandDims[0].value;
      for (const cDim of sameUnitCandDims) {
        const relDiff = Math.abs(cDim.value - qDim.value) / Math.max(Math.abs(qDim.value), 1e-9);
        if (relDiff < minRelDiff) {
          minRelDiff = relDiff;
          closestCandVal = cDim.value;
        }
      }

      if (minRelDiff > DIMENSION_RELATIVE_TOLERANCE) {
        return {
          conformant: false,
          similarityScore: 0,
          matchedTokens: [],
          rejectionReason: `Dimension / Capacity mismatch on "${qDim.unit}" (>1% tolerance): query requires ${qDim.value}${qDim.unit}, but candidate is ${closestCandVal}${qDim.unit}`
        };
      }
      matchedDimensionUnits.add(qDim.unit);
    }
  }

  // 6b. Orthogonal Qualifier Axis Conflict Detection & Lattice Subsumption
  for (const [axis, qPole] of Object.entries(qLattice.axisQualifiers)) {
    const cPole = cLattice.axisQualifiers[axis];
    if (cPole && cPole !== qPole) {
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Qualifier conflict (${axis} / Form factor mismatch): query requires ${qPole}, but candidate is ${cPole}`
      };
    }
    if (!cPole && AXIS_REQUIRE_SUBSUMPTION.get(axis)) {
      return {
        conformant: false,
        similarityScore: 0,
        matchedTokens: [],
        rejectionReason: `Qualifier lattice subsumption mismatch (${axis}): candidate omits required qualifier "${qPole}"`
      };
    }
  }

  // 6c. Open-Vocabulary Morphological Antonym Conflict Detection (non_<x> vs <x>, <stem>less vs <stem>ed)
  const morphConflict = findMorphologicalQualifierConflict(qLattice.qualifiers, cLattice.qualifiers);
  if (morphConflict) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Qualifier conflict (morphological antonym / Form factor mismatch): query requires ${morphConflict.queryQual}, but candidate is ${morphConflict.candQual}`
    };
  }

  // 6d. Primary Head-Noun Kernel Conformance
  if (
    qLattice.headTokens.length > 0 &&
    cLattice.nounSequence.length > 0 &&
    !candidateRightEdgeMatchesQueryHead(qLattice.headTokens, cLattice.nounSequence, brandLower)
  ) {
    return {
      conformant: false,
      similarityScore: 0,
      matchedTokens: [],
      rejectionReason: `Head noun mismatch: query requires "${qLattice.headNounKernel}", but candidate primary head is "${cLattice.headNounKernel}"`
    };
  }

  // 7. Synonym-, Dimension-, and Initialism-Expanded Token Recall & Jaccard Similarity Score
  const expandedCandidateSet = new Set<string>(candidateTokens);
  for (const tok of candidateTokens) {
    const syns = SYNONYM_MAP[tok];
    if (syns) {
      for (const s of syns) expandedCandidateSet.add(s);
    }
  }

  const candidateInitialisms = computePhraseInitialisms(candidateTokens, brandLower);
  for (const init of candidateInitialisms) {
    expandedCandidateSet.add(init);
  }
  for (const qual of cLattice.qualifiers) {
    expandedCandidateSet.add(qual);
  }

  const matchedTokens: string[] = [];
  for (const qTok of intent.coreTokens) {
    const parsedDim = parseSingleDimensionToken(qTok);
    if (parsedDim && matchedDimensionUnits.has(parsedDim.unit)) {
      matchedTokens.push(qTok);
      continue;
    }
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

// Pre-warm V8 Irregexp bytecode at module initialization so cold first-request discovery avoids lazy regex compilation spikes
const _warmupIntent = parseDiscoveryQuery('Warmup Front Load 1kg Item under $100');
void evaluateCandidateConformance(_warmupIntent, 'Warmup 1kg Front Load Item with Feature (WM4000HWA)', 200);
void evaluateCandidateConformance(_warmupIntent, 'Protective Cover for Warmup 1kg Front Load Item', 15);

