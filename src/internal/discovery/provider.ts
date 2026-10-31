import { config } from '../../config/index.ts';
import {
  SYNONYM_MAP,
  type ParsedDiscoveryIntent,
  type ProductCondition,
  type DestinationZone
} from './disambiguation.ts';

export type MerchantTier =
  | 'official_store'
  | 'platform_fulfilled'
  | 'vetted_3p'
  | 'unverified_classified';

export type { DestinationZone };

export interface DiscoveredCandidateListing {
  id: string;
  providerName: string;
  title: string;
  price: number;
  shippingCost: number;
  listPrice: number | null;
  currency: string;
  url: string;
  seller: string;
  rating: number | null;
  reviewCount: number | null;
  inStock: boolean;
  promoCode: string | null;
  promoDiscountPercent: number | null;
  promoDiscountAmount: number | null;
  merchantTier?: MerchantTier;
  condition?: ProductCondition;
  warranty?: string;
  shippingByZone?: Record<DestinationZone, number>;
}

export interface DiscoverySearchOptions {
  baseUrl?: string;
  syndicatedFeedPayloads?: Array<{ sourceName: string; format: 'rss' | 'json'; content: string }>;
  syndicatedFeedUrls?: string[];
  destinationZone?: DestinationZone;
}

export interface DiscoveryProvider {
  readonly providerName: string;
  search(
    intent: ParsedDiscoveryIntent,
    options?: DiscoverySearchOptions
  ): Promise<DiscoveredCandidateListing[]>;
}

/**
 * Parses open Syndicated Deal Feeds (RSS 2.0 / Atom XML, Reddit/Deal JSON streams, and Shopify /products.json)
 * with zero external XML/DOM dependencies.
 */
export class SyndicatedDealAdapter implements DiscoveryProvider {
  readonly providerName = 'syndicated_deal_feeds';

  parseRssOrAtomXml(xml: string, sourceName = 'Syndicated RSS'): DiscoveredCandidateListing[] {
    const listings: DiscoveredCandidateListing[] = [];
    const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    let m: RegExpExecArray | null;
    let idx = 0;

    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkMatch =
        block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i) ||
        block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
      const descMatch = block.match(
        /<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i
      );

      const rawTitle = (titleMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();
      const rawUrl = (linkMatch?.[1] || '').trim();
      const rawDesc = (descMatch?.[1] || '').replace(/<[^>]+>/g, ' ').trim();
      if (!rawTitle || !rawUrl) continue;

      const combined = `${rawTitle} ${rawDesc}`;
      const priceMatch = combined.match(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
      if (!priceMatch) continue;
      const price = parseFloat(priceMatch[1].replace(/,/g, ''));
      if (isNaN(price) || price <= 0) continue;

      const listMatch = combined.match(
        /(?:was|msrp|list|reg\.?)\s*\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i
      );
      const listPrice = listMatch ? parseFloat(listMatch[1].replace(/,/g, '')) : null;

      const shippingMatch = combined.match(/\+\s*\$([0-9]+(?:\.[0-9]{1,2})?)\s*shipping/i);
      const shippingCost = shippingMatch ? parseFloat(shippingMatch[1]) : 0;

      const ratingMatch = combined.match(/([1-4]\.[0-9]|5\.0|5)\s*(?:★|stars?)/i);
      const reviewsMatch = combined.match(/\(?([0-9]{1,6})\s*reviews?\)?/i);

      const promoMatch = combined.match(
        /(?:code|coupon|promo)\s+['"]?([A-Z0-9_\-]{3,20})['"]?(?:\s*\(([0-9]{1,2})%\s*off\))?/i
      );

      listings.push({
        id: `rss_${idx++}`,
        providerName: this.providerName,
        title: rawTitle,
        price,
        shippingCost,
        listPrice,
        currency: 'USD',
        url: rawUrl,
        seller: sourceName,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : 4.6,
        reviewCount: reviewsMatch ? parseInt(reviewsMatch[1], 10) : 85,
        inStock: !/\b(?:expired|sold\s+out|out\s+of\s+stock|oos)\b/i.test(combined),
        promoCode: promoMatch ? promoMatch[1].toUpperCase() : null,
        promoDiscountPercent: promoMatch?.[2] ? parseFloat(promoMatch[2]) : null,
        promoDiscountAmount: null
      });
    }

    return listings;
  }

  parseJsonFeed(rawJson: string, sourceName = 'Open Merchant Feed'): DiscoveredCandidateListing[] {
    const listings: DiscoveredCandidateListing[] = [];
    try {
      const parsed = JSON.parse(rawJson);
      const items: Array<Record<string, any>> = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.products)
          ? parsed.products
          : Array.isArray(parsed.items)
            ? parsed.items
            : Array.isArray(parsed.itemListElement)
              ? parsed.itemListElement.map((el: any) => el.item || el)
              : Array.isArray(parsed.data?.children)
                ? parsed.data.children.map((c: any) => c.data)
                : [];

      items.forEach((item, idx) => {
        const title = String(item.title || item.name || '').trim();
        const url = String(item.url || item.href || '').trim();
        const rawPrice =
          item.price ?? item.offers?.price ?? item.variants?.[0]?.price ?? null;
        if (!title || !url || rawPrice === null) return;
        const price = parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
        if (isNaN(price)) return;

        listings.push({
          id: `json_${idx}`,
          providerName: this.providerName,
          title,
          price,
          shippingCost: Number(item.shippingCost || item.shipping || 0),
          listPrice: item.listPrice ? Number(item.listPrice) : item.msrp ? Number(item.msrp) : null,
          currency: String(item.currency || item.offers?.priceCurrency || 'USD'),
          url,
          seller: String(item.seller || item.vendor || sourceName),
          rating: item.rating != null ? Number(item.rating) : item.aggregateRating?.ratingValue ? Number(item.aggregateRating.ratingValue) : null,
          reviewCount: item.reviewCount != null ? Number(item.reviewCount) : item.aggregateRating?.reviewCount ? Number(item.aggregateRating.reviewCount) : null,
          inStock: item.inStock !== false && !String(item.offers?.availability || '').includes('OutOfStock'),
          promoCode: item.promoCode ? String(item.promoCode).toUpperCase() : null,
          promoDiscountPercent: item.promoDiscountPercent != null ? Number(item.promoDiscountPercent) : null,
          promoDiscountAmount: item.promoDiscountAmount != null ? Number(item.promoDiscountAmount) : null
        });
      });
    } catch {
      // Ignore malformed JSON stream
    }
    return listings;
  }

  async search(
    _intent: ParsedDiscoveryIntent,
    options: DiscoverySearchOptions = {}
  ): Promise<DiscoveredCandidateListing[]> {
    const out: DiscoveredCandidateListing[] = [];

    if (options.syndicatedFeedPayloads) {
      for (const feed of options.syndicatedFeedPayloads) {
        if (feed.format === 'rss') {
          out.push(...this.parseRssOrAtomXml(feed.content, feed.sourceName));
        } else {
          out.push(...this.parseJsonFeed(feed.content, feed.sourceName));
        }
      }
    }

    if (options.syndicatedFeedUrls && options.syndicatedFeedUrls.length > 0) {
      for (const feedUrl of options.syndicatedFeedUrls) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.min(4000, config.resolution.httpTimeoutMs));
          const resp = await fetch(feedUrl, {
            headers: {
              'User-Agent': 'PulseRemind-DealDiscovery/1.0',
              Accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9'
            },
            signal: controller.signal
          });
          clearTimeout(timer);
          if (!resp.ok) continue;
          const body = await resp.text();
          if (body.trim().startsWith('<')) {
            out.push(...this.parseRssOrAtomXml(body, new URL(feedUrl).hostname));
          } else {
            out.push(...this.parseJsonFeed(body, new URL(feedUrl).hostname));
          }
        } catch {
          // Non-fatal: continue across remaining federated sources
        }
      }
    }

    return out;
  }
}

/**
 * Multi-Merchant Local Storefront Catalog simulating competing retailers with realistic pricing,
 * freight shipping traps, promo codes, shill 1-review listings, and accessory/toy noise.
 * Every candidate URL points to `/demo/deal-portal?...` so PulseRemind's ResolutionEngine can poll it live.
 */
export class SimulatedMultiStoreAdapter implements DiscoveryProvider {
  readonly providerName = 'multi_store_catalog';

  async search(
    intent: ParsedDiscoveryIntent,
    options: DiscoverySearchOptions = {}
  ): Promise<DiscoveredCandidateListing[]> {
    if (
      intent.predicate.currency === 'NGN' ||
      options.destinationZone !== undefined ||
      intent.destinationZone !== undefined ||
      /\b(jumia|konga|slot|kara|fouani|jiji|lagos|abuja|tokunbo|₦|ngn)\b/i.test(intent.rawQuery)
    ) {
      return [];
    }

    const baseUrl = (options.baseUrl || config.cloud.renderExternalUrl || 'http://localhost:3456').replace(
      /\/$/,
      ''
    );

    const buildDemoUrl = (params: {
      store: string;
      title: string;
      price: number;
      listPrice: number;
      rating: number;
      reviews: number;
      promo?: string;
      stock?: 'in' | 'out';
    }) => {
      const q = new URLSearchParams({
        store: params.store,
        title: params.title,
        price: params.price.toFixed(2),
        list_price: params.listPrice.toFixed(2),
        rating: String(params.rating),
        reviews: String(params.reviews),
        promo: params.promo || 'NONE',
        stock: params.stock || 'in'
      });
      return `${baseUrl}/demo/deal-portal?${q.toString()}`;
    };

    const catalog: DiscoveredCandidateListing[] = [
      // --- Washing Machine Ecosystem (Genuine Appliances + Accessory/Toy/Shill Traps) ---
      {
        id: 'wm_hose_trap',
        providerName: this.providerName,
        title: 'Universal 6ft Stainless Braided Washing Machine Drain Hose Replacement Kit',
        price: 18.99,
        shippingCost: 0,
        listPrice: 29.99,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'AccessoryDepot',
          title: 'Washing Machine Drain Hose Kit',
          price: 18.99,
          listPrice: 29.99,
          rating: 4.7,
          reviews: 890
        }),
        seller: 'AccessoryDepot',
        rating: 4.7,
        reviewCount: 890,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'wm_toy_trap',
        providerName: this.providerName,
        title: 'Kids Pretend Play Miniature Toy Washing Machine with Spin Basket',
        price: 39.5,
        shippingCost: 0,
        listPrice: 49.99,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'ToyWorld',
          title: 'Kids Miniature Toy Washing Machine',
          price: 39.5,
          listPrice: 49.99,
          rating: 4.8,
          reviews: 410
        }),
        seller: 'ToyWorld',
        rating: 4.8,
        reviewCount: 410,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'wm_shill_trap',
        providerName: this.providerName,
        title: 'LG WM4000HWA 4.5 cu. ft. Ultra Large Smart Front Load Washing Machine',
        price: 465.0,
        shippingCost: 0,
        listPrice: 899.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'ShillBargainMart',
          title: 'LG WM4000HWA Front Load Washing Machine',
          price: 465.0,
          listPrice: 899.0,
          rating: 5.0,
          reviews: 1
        }),
        seller: 'ShillBargainMart (Unverified)',
        rating: 5.0,
        reviewCount: 1,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'wm_shipping_trap',
        providerName: this.providerName,
        title: 'Samsung Bespoke 5.3 cu. ft. High-Efficiency Front Load Washing Machine',
        price: 480.0,
        shippingCost: 165.0, // Landed cost = $645!
        listPrice: 899.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'FreightLiquidators',
          title: 'Samsung Bespoke 5.3 cu ft Front Load Washing Machine',
          price: 645.0,
          listPrice: 899.0,
          rating: 4.5,
          reviews: 190
        }),
        seller: 'FreightLiquidators',
        rating: 4.5,
        reviewCount: 190,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'wm_lg_promo_winner',
        providerName: this.providerName,
        title: 'LG WM4000HWA 4.5 cu. ft. Smart Wi-Fi Front Load Washing Machine (TurboWash 360)',
        price: 620.0,
        shippingCost: 0,
        listPrice: 899.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'ApplianceDirect',
          title: 'LG WM4000HWA Front Load Washing Machine',
          price: 496.0,
          listPrice: 899.0,
          rating: 4.8,
          reviews: 640,
          promo: 'SAVE20'
        }),
        seller: 'ApplianceDirect Official',
        rating: 4.8,
        reviewCount: 640,
        inStock: true,
        promoCode: 'SAVE20',
        promoDiscountPercent: 20, // Net landed = $496.00!
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new'
      },
      {
        id: 'wm_bosch_runnerup',
        providerName: this.providerName,
        title: 'Bosch 300 Series 2.2 cu. ft. Compact Front Load Washing Machine',
        price: 540.0,
        shippingCost: 0,
        listPrice: 799.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'VerifiedOutlet',
          title: 'Bosch 300 Series Front Load Washing Machine',
          price: 540.0,
          listPrice: 799.0,
          rating: 4.7,
          reviews: 310
        }),
        seller: 'VerifiedOutlet',
        rating: 4.7,
        reviewCount: 310,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'wm_lg_megastore',
        providerName: this.providerName,
        title: 'LG 5.0 cu. ft. Mega Capacity Smart Front Load Washer with Steam',
        price: 579.0,
        shippingCost: 0,
        listPrice: 949.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'MegaHomeStore',
          title: 'LG 5.0 cu ft Smart Front Load Washer',
          price: 579.0,
          listPrice: 949.0,
          rating: 4.7,
          reviews: 425
        }),
        seller: 'MegaHomeStore',
        rating: 4.7,
        reviewCount: 425,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },

      // --- Computing Ecosystem (MacBook Pro M4 + Sleeve Trap) ---
      {
        id: 'mbp_sleeve_trap',
        providerName: this.providerName,
        title: 'Waterproof Leather Laptop Sleeve Case for MacBook Pro M4 16-inch',
        price: 24.99,
        shippingCost: 0,
        listPrice: 39.99,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'CaseWorld',
          title: 'Laptop Sleeve Case for MacBook Pro 16-inch',
          price: 24.99,
          listPrice: 39.99,
          rating: 4.8,
          reviews: 1200
        }),
        seller: 'CaseWorld',
        rating: 4.8,
        reviewCount: 1200,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      },
      {
        id: 'mbp_m4_direct',
        providerName: this.providerName,
        title: 'Apple MacBook Pro M4 Max 16-inch Laptop (36GB RAM, 1TB SSD)',
        price: 2899.0,
        shippingCost: 0,
        listPrice: 3499.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'TechDirectPro',
          title: 'Apple MacBook Pro M4 Max 16-inch',
          price: 2609.1,
          listPrice: 3499.0,
          rating: 4.9,
          reviews: 512,
          promo: 'PRO10'
        }),
        seller: 'TechDirectPro Authorized',
        rating: 4.9,
        reviewCount: 512,
        inStock: true,
        promoCode: 'PRO10',
        promoDiscountPercent: 10,
        promoDiscountAmount: null
      },
      {
        id: 'mbp_m4_megatech',
        providerName: this.providerName,
        title: 'Apple MacBook Pro M4 Max 16-inch Space Black (36GB Unified Memory)',
        price: 2749.0,
        shippingCost: 0,
        listPrice: 3499.0,
        currency: 'USD',
        url: buildDemoUrl({
          store: 'MegaTechStore',
          title: 'Apple MacBook Pro M4 Max 16-inch Space Black',
          price: 2749.0,
          listPrice: 3499.0,
          rating: 4.8,
          reviews: 285
        }),
        seller: 'MegaTechStore',
        rating: 4.8,
        reviewCount: 285,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null
      }
    ];

    // If query is for an arbitrary product not in the static catalog, synthesize 3 realistic competing store listings
    // so users testing ANY product name in local/demo mode get realistic multi-store comparison & cluster watches!
    const hasOverlap = catalog.some((item) => {
      const lower = item.title.toLowerCase();
      return intent.coreTokens.some((tok) => {
        if (lower.includes(tok)) return true;
        const syns = SYNONYM_MAP[tok];
        return Boolean(syns && syns.some((s) => lower.includes(s)));
      });
    });

    if (!hasOverlap && intent.coreTokens.length > 0) {
      const displayTitle = intent.canonicalProductPhrase
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const baseRef = intent.predicate.targetPrice
        ? Math.round(intent.predicate.targetPrice * 1.25)
        : 499;

      catalog.push(
        {
          id: 'dyn_store_a',
          providerName: this.providerName,
          title: `${displayTitle} (Official Retail Edition)`,
          price: Math.round(baseRef * 0.88),
          shippingCost: 0,
          listPrice: baseRef,
          currency: 'USD',
          url: buildDemoUrl({
            store: 'VerifiedDirect',
            title: `${displayTitle} Official Edition`,
            price: Math.round(baseRef * 0.88 * 0.9),
            listPrice: baseRef,
            rating: 4.8,
            reviews: 340,
            promo: 'WELCOME10'
          }),
          seller: 'VerifiedDirect Store',
          rating: 4.8,
          reviewCount: 340,
          inStock: true,
          promoCode: 'WELCOME10',
          promoDiscountPercent: 10,
          promoDiscountAmount: null
        },
        {
          id: 'dyn_store_b',
          providerName: this.providerName,
          title: `${displayTitle} — Bundle & Warranty Pack`,
          price: Math.round(baseRef * 0.84),
          shippingCost: 0,
          listPrice: baseRef,
          currency: 'USD',
          url: buildDemoUrl({
            store: 'MegaMarketplace',
            title: `${displayTitle} Bundle`,
            price: Math.round(baseRef * 0.84),
            listPrice: baseRef,
            rating: 4.6,
            reviews: 185
          }),
          seller: 'MegaMarketplace',
          rating: 4.6,
          reviewCount: 185,
          inStock: true,
          promoCode: null,
          promoDiscountPercent: null,
          promoDiscountAmount: null
        },
        {
          id: 'dyn_store_shill',
          providerName: this.providerName,
          title: `${displayTitle} Clearance Listing`,
          price: Math.round(baseRef * 0.65),
          shippingCost: 0,
          listPrice: baseRef,
          currency: 'USD',
          url: buildDemoUrl({
            store: 'UnverifiedSeller99',
            title: `${displayTitle} Clearance`,
            price: Math.round(baseRef * 0.65),
            listPrice: baseRef,
            rating: 5.0,
            reviews: 1
          }),
          seller: 'UnverifiedSeller99',
          rating: 5.0,
          reviewCount: 1,
          inStock: true,
          promoCode: null,
          promoDiscountPercent: null,
          promoDiscountAmount: null
        }
      );
    }

    return catalog;
  }
}

/**
 * Nigerian Multi-Store Commerce Adapter
 * Models major Nigerian e-commerce ecosystems (Jumia Nigeria, Konga, Fouani Nigeria, Slot.ng, Kara)
 * as well as adversarial Classifieds traps (Jiji London Used / Tokunbo listings & unverified classified fraud).
 */
export class NigerianCommerceAdapter implements DiscoveryProvider {
  readonly providerName = 'nigerian_commerce_catalog';

  async search(
    intent: ParsedDiscoveryIntent,
    options: DiscoverySearchOptions = {}
  ): Promise<DiscoveredCandidateListing[]> {
    const isExplicitNonNgn =
      intent.predicate.currency &&
      intent.predicate.currency !== 'NGN' &&
      !/\b(jumia|konga|slot|kara|fouani|jiji|lagos|abuja|nigeria|tokunbo|₦|ngn)\b/i.test(intent.rawQuery);

    if (isExplicitNonNgn) {
      return [];
    }

    const baseUrl = (options.baseUrl || config.cloud.renderExternalUrl || 'http://localhost:3456').replace(
      /\/$/,
      ''
    );

    const buildDemoUrl = (params: {
      store: string;
      title: string;
      price: number;
      listPrice: number;
      rating: number;
      reviews: number;
      promo?: string;
      stock?: 'in' | 'out';
      currency?: string;
    }) => {
      const q = new URLSearchParams({
        store: params.store,
        title: params.title,
        price: params.price.toFixed(2),
        list_price: params.listPrice.toFixed(2),
        rating: String(params.rating),
        reviews: String(params.reviews),
        promo: params.promo || 'NONE',
        stock: params.stock || 'in',
        currency: params.currency || 'NGN'
      });
      return `${baseUrl}/demo/deal-portal?${q.toString()}`;
    };

    const targetZone: DestinationZone = options.destinationZone || intent.destinationZone || 'lagos';

    const catalog: DiscoveredCandidateListing[] = [
      // 1. Jumia Official Store (Fouani/LG) - Official Store with 10% promo JUMIA10
      // Base: ₦560,000 -> With JUMIA10 (10% off) = ₦504,000 landed in Lagos (Free shipping)
      {
        id: 'jumia_lg_official',
        providerName: this.providerName,
        title: 'LG 8kg Front Load Washing Machine with Inverter Direct Drive & Steam',
        price: 560000,
        shippingCost: 0,
        listPrice: 720000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Official Store (Fouani/LG)',
          title: 'LG 8kg Front Load Washing Machine',
          price: 504000,
          listPrice: 720000,
          rating: 4.8,
          reviews: 240,
          promo: 'JUMIA10',
          currency: 'NGN'
        }),
        seller: 'Jumia Official Store (Fouani/LG)',
        rating: 4.8,
        reviewCount: 240,
        inStock: true,
        promoCode: 'JUMIA10',
        promoDiscountPercent: 10,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        warranty: '2 Years Manufacturer Warranty',
        shippingByZone: {
          lagos: 0,
          abuja: 15000,
          interstate: 35000
        }
      },

      // 2. Fouani Nigeria Official (Direct exclusive distributor)
      // Base: ₦525,000 -> Free Lagos shipping, 2-year warranty, 4.9★ across 420 reviews
      {
        id: 'fouani_lg_direct',
        providerName: this.providerName,
        title: 'LG AI DD 8.5kg Front Load Washing Machine (TurboWash 360)',
        price: 525000,
        shippingCost: 0,
        listPrice: 690000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Fouani Nigeria Official',
          title: 'LG AI DD 8.5kg Front Load Washing Machine',
          price: 525000,
          listPrice: 690000,
          rating: 4.9,
          reviews: 420,
          currency: 'NGN'
        }),
        seller: 'Fouani Nigeria Official',
        rating: 4.9,
        reviewCount: 420,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        warranty: '2 Years Official Fouani LG Warranty',
        shippingByZone: {
          lagos: 0,
          abuja: 10000,
          interstate: 28000
        }
      },

      // 3. Konga Retail (Platform Fulfilled)
      // Base: ₦540,000 -> With KONGA5 (5% off) = ₦513,000, shipping ₦3,500 Lagos
      {
        id: 'konga_samsung_retail',
        providerName: this.providerName,
        title: 'Samsung 8kg EcoBubble Front Load Washing Machine with Hygiene Steam',
        price: 540000,
        shippingCost: 3500,
        listPrice: 680000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Konga Retail',
          title: 'Samsung 8kg EcoBubble Front Load Washing Machine',
          price: 513000,
          listPrice: 680000,
          rating: 4.7,
          reviews: 310,
          promo: 'KONGA5',
          currency: 'NGN'
        }),
        seller: 'Konga Retail',
        rating: 4.7,
        reviewCount: 310,
        inStock: true,
        promoCode: 'KONGA5',
        promoDiscountPercent: 5,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 3500,
          abuja: 14000,
          interstate: 30000
        }
      },

      // 4. Jumia Express (Hisense Top Loader)
      {
        id: 'jumia_hisense_express',
        providerName: this.providerName,
        title: 'Hisense 7kg Top Load Automatic Washing Machine with Smart Water Control',
        price: 380000,
        shippingCost: 4000,
        listPrice: 450000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Express',
          title: 'Hisense 7kg Top Load Automatic Washing Machine',
          price: 380000,
          listPrice: 450000,
          rating: 4.6,
          reviews: 150,
          currency: 'NGN'
        }),
        seller: 'Jumia Express',
        rating: 4.6,
        reviewCount: 150,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 4000,
          abuja: 12000,
          interstate: 25000
        }
      },

      // 5. Kara Appliance Store (Vetted 3P Merchant)
      // Base: ₦510,000, shipping: Lagos ₦5,000, Abuja ₦16,000, Interstate ₦35,000
      {
        id: 'kara_appliance_direct',
        providerName: this.providerName,
        title: 'LG 8kg Front Load Washing Machine Smart Inverter',
        price: 510000,
        shippingCost: 5000,
        listPrice: 620000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Kara Appliance Store',
          title: 'LG 8kg Front Load Washing Machine Smart Inverter',
          price: 510000,
          listPrice: 620000,
          rating: 4.5,
          reviews: 95,
          currency: 'NGN'
        }),
        seller: 'Kara Appliance Store',
        rating: 4.5,
        reviewCount: 95,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'vetted_3p',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 5000,
          abuja: 16000,
          interstate: 35000
        }
      },

      // 6. Classifieds London Used / Tokunbo Trap (Jiji Seller)
      // Price: ₦210,000 (Looks artificially cheap compared to ₦550k new units!)
      {
        id: 'jiji_london_used_trap',
        providerName: this.providerName,
        title: 'LG 7kg Front Load Washing Machine London Used / Tokunbo Working Perfect',
        price: 210000,
        shippingCost: 8000,
        listPrice: 500000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Alaba Seller on Classifieds',
          title: 'LG 7kg Front Load Washing Machine London Used',
          price: 210000,
          listPrice: 500000,
          rating: 4.9,
          reviews: 12,
          currency: 'NGN'
        }),
        seller: 'Alaba Seller on Classifieds',
        rating: 4.9,
        reviewCount: 12,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'unverified_classified',
        condition: 'uk_used',
        shippingByZone: {
          lagos: 8000,
          abuja: 25000,
          interstate: 40000
        }
      },

      // 7. High-Ticket Unverified Classifieds Fraud Trap (Jiji Shady Seller)
      // Price: ₦185,000 (> ₦50,000 threshold for unverified classifieds fraud mitigation!)
      {
        id: 'jiji_high_ticket_fraud_trap',
        providerName: this.providerName,
        title: 'Brand New LG Inverter Smart Front Load Washing Machine Direct From Wharf',
        price: 185000,
        shippingCost: 5000,
        listPrice: 600000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'QuickDeals99 on Classifieds',
          title: 'Brand New LG Inverter Smart Washer Direct Wharf',
          price: 185000,
          listPrice: 600000,
          rating: 5.0,
          reviews: 2,
          currency: 'NGN'
        }),
        seller: 'QuickDeals99 on Classifieds',
        rating: 5.0,
        reviewCount: 2,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'unverified_classified',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 5000,
          abuja: 15000,
          interstate: 25000
        }
      },

      // 8. Nigerian Accessory Hose Trap (₦6,500)
      {
        id: 'ng_hose_trap',
        providerName: this.providerName,
        title: 'Universal 3m Flexible Inlet and Drain Hose for Washing Machine',
        price: 6500,
        shippingCost: 1500,
        listPrice: 10000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'PartsDepot Lagos',
          title: 'Flexible Hose for Washing Machine',
          price: 6500,
          listPrice: 10000,
          rating: 4.7,
          reviews: 180,
          currency: 'NGN'
        }),
        seller: 'PartsDepot Lagos',
        rating: 4.7,
        reviewCount: 180,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'vetted_3p',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 1500,
          abuja: 3000,
          interstate: 4500
        }
      },

      // --- Standing Fan Ecosystem ---
      {
        id: 'jumia_ox_standing_fan',
        providerName: this.providerName,
        title: 'Ox 18-inch High-Velocity Industrial Standing Fan with Heavy Duty Motor',
        price: 34500,
        shippingCost: 2000,
        listPrice: 45000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Express',
          title: 'Ox 18-inch Industrial Standing Fan',
          price: 34500,
          listPrice: 45000,
          rating: 4.7,
          reviews: 380,
          currency: 'NGN'
        }),
        seller: 'Jumia Express',
        rating: 4.7,
        reviewCount: 380,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 2000,
          abuja: 5000,
          interstate: 8000
        }
      },
      {
        id: 'konga_century_fan',
        providerName: this.providerName,
        title: 'Century 18-inch Rechargeable Standing Fan with Remote & LED Light',
        price: 38000,
        shippingCost: 2500,
        listPrice: 48000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Konga Retail',
          title: 'Century 18-inch Rechargeable Standing Fan',
          price: 36100,
          listPrice: 48000,
          rating: 4.8,
          reviews: 510,
          promo: 'FANSAVE5',
          currency: 'NGN'
        }),
        seller: 'Konga Retail',
        rating: 4.8,
        reviewCount: 510,
        inStock: true,
        promoCode: 'FANSAVE5',
        promoDiscountPercent: 5,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 2500,
          abuja: 6000,
          interstate: 9000
        }
      },
      {
        id: 'fan_blade_trap',
        providerName: this.providerName,
        title: 'Universal 18-inch Plastic Blade Replacement for Standing Fan',
        price: 3500,
        shippingCost: 1000,
        listPrice: 5000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'FanSpares Lagos',
          title: 'Plastic Blade Replacement for Standing Fan',
          price: 3500,
          listPrice: 5000,
          rating: 4.6,
          reviews: 95,
          currency: 'NGN'
        }),
        seller: 'FanSpares Lagos',
        rating: 4.6,
        reviewCount: 95,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'vetted_3p',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 1000,
          abuja: 2500,
          interstate: 4000
        }
      },

      // --- Internet Airtel Router Ecosystem ---
      {
        id: 'konga_airtel_4g_router',
        providerName: this.providerName,
        title: 'Airtel 4G LTE Smart Desktop Broadband Router (Includes 50GB Bonus Data)',
        price: 32000,
        shippingCost: 1500,
        listPrice: 38000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Konga Official Store',
          title: 'Airtel 4G LTE Smart Broadband Router',
          price: 32000,
          listPrice: 38000,
          rating: 4.8,
          reviews: 290,
          currency: 'NGN'
        }),
        seller: 'Konga Official Store',
        rating: 4.8,
        reviewCount: 290,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 1500,
          abuja: 4000,
          interstate: 6000
        }
      },
      {
        id: 'jumia_airtel_5g_router',
        providerName: this.providerName,
        title: 'Airtel 5G Ultra-Fast Portable MiFi Router with High Capacity Battery',
        price: 28000,
        shippingCost: 1200,
        listPrice: 35000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Express',
          title: 'Airtel 5G Ultra-Fast Portable MiFi Router',
          price: 25200,
          listPrice: 35000,
          rating: 4.7,
          reviews: 340,
          promo: 'NET10',
          currency: 'NGN'
        }),
        seller: 'Jumia Express',
        rating: 4.7,
        reviewCount: 340,
        inStock: true,
        promoCode: 'NET10',
        promoDiscountPercent: 10,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 1200,
          abuja: 3500,
          interstate: 5500
        }
      },

      // --- Microwave Oven Ecosystem ---
      {
        id: 'fouani_lg_microwave',
        providerName: this.providerName,
        title: 'LG 20L Solo Microwave Oven NeoChef with Smart Inverter & EasyClean',
        price: 85000,
        shippingCost: 0,
        listPrice: 110000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Fouani Nigeria Official',
          title: 'LG 20L Solo Microwave Oven NeoChef',
          price: 85000,
          listPrice: 110000,
          rating: 4.9,
          reviews: 280,
          currency: 'NGN'
        }),
        seller: 'Fouani Nigeria Official',
        rating: 4.9,
        reviewCount: 280,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        warranty: '2 Years Official Fouani LG Warranty',
        shippingByZone: {
          lagos: 0,
          abuja: 5000,
          interstate: 10000
        }
      },
      {
        id: 'jumia_hisense_microwave',
        providerName: this.providerName,
        title: 'Hisense 20L Digital Solo Microwave Oven with Defrost Function',
        price: 72000,
        shippingCost: 2000,
        listPrice: 90000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Official Store',
          title: 'Hisense 20L Digital Solo Microwave Oven',
          price: 68400,
          listPrice: 90000,
          rating: 4.8,
          reviews: 410,
          promo: 'KITCHEN5',
          currency: 'NGN'
        }),
        seller: 'Jumia Official Store',
        rating: 4.8,
        reviewCount: 410,
        inStock: true,
        promoCode: 'KITCHEN5',
        promoDiscountPercent: 5,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 2000,
          abuja: 6000,
          interstate: 12000
        }
      },

      // --- Gas Cooker Ecosystem ---
      {
        id: 'jumia_scanfrost_cooker',
        providerName: this.providerName,
        title: 'Scanfrost 4-Burner Gas Cooker with Oven and Grill (Inox Finish)',
        price: 145000,
        shippingCost: 0,
        listPrice: 180000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Official Store',
          title: 'Scanfrost 4-Burner Gas Cooker with Oven',
          price: 130500,
          listPrice: 180000,
          rating: 4.8,
          reviews: 195,
          promo: 'CHEF10',
          currency: 'NGN'
        }),
        seller: 'Jumia Official Store',
        rating: 4.8,
        reviewCount: 195,
        inStock: true,
        promoCode: 'CHEF10',
        promoDiscountPercent: 10,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 0,
          abuja: 12000,
          interstate: 24000
        }
      },
      {
        id: 'konga_maxi_cooker',
        providerName: this.providerName,
        title: 'Maxi 4-Burner Stainless Steel Gas Cooker with Gas Oven',
        price: 138000,
        shippingCost: 3000,
        listPrice: 165000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Konga Retail',
          title: 'Maxi 4-Burner Stainless Steel Gas Cooker',
          price: 138000,
          listPrice: 165000,
          rating: 4.7,
          reviews: 220,
          currency: 'NGN'
        }),
        seller: 'Konga Retail',
        rating: 4.7,
        reviewCount: 220,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'platform_fulfilled',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 3000,
          abuja: 11000,
          interstate: 22000
        }
      },

      // --- Television (TV) Ecosystem ---
      {
        id: 'fouani_hisense_tv',
        providerName: this.providerName,
        title: 'Hisense 43-inch Full HD Smart Google TV with Voice Remote & Bluetooth',
        price: 245000,
        shippingCost: 0,
        listPrice: 310000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Fouani Nigeria Official',
          title: 'Hisense 43-inch Full HD Smart Google TV',
          price: 245000,
          listPrice: 310000,
          rating: 4.9,
          reviews: 480,
          currency: 'NGN'
        }),
        seller: 'Fouani Nigeria Official',
        rating: 4.9,
        reviewCount: 480,
        inStock: true,
        promoCode: null,
        promoDiscountPercent: null,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        warranty: '2 Years Official Fouani Warranty',
        shippingByZone: {
          lagos: 0,
          abuja: 8000,
          interstate: 18000
        }
      },
      {
        id: 'jumia_tcl_tv',
        providerName: this.providerName,
        title: 'TCL 43-inch 4K UHD Smart Google TV with Dolby Audio & HDR10',
        price: 255000,
        shippingCost: 2500,
        listPrice: 330000,
        currency: 'NGN',
        url: buildDemoUrl({
          store: 'Jumia Official Store',
          title: 'TCL 43-inch 4K UHD Smart Google TV',
          price: 229500,
          listPrice: 330000,
          rating: 4.8,
          reviews: 360,
          promo: 'VISION10',
          currency: 'NGN'
        }),
        seller: 'Jumia Official Store',
        rating: 4.8,
        reviewCount: 360,
        inStock: true,
        promoCode: 'VISION10',
        promoDiscountPercent: 10,
        promoDiscountAmount: null,
        merchantTier: 'official_store',
        condition: 'brand_new',
        shippingByZone: {
          lagos: 2500,
          abuja: 9000,
          interstate: 20000
        }
      }
    ];

    // Compute zone-adjusted shipping cost for each catalog item
    for (const item of catalog) {
      if (item.shippingByZone) {
        item.shippingCost = item.shippingByZone[targetZone] ?? item.shippingCost;
      }
    }

    const hasOverlap = catalog.some((item) => {
      const lower = item.title.toLowerCase();
      return intent.coreTokens.some((tok) => {
        if (lower.includes(tok)) return true;
        const syns = SYNONYM_MAP[tok];
        return Boolean(syns && syns.some((s) => lower.includes(s)));
      });
    });

    if (!hasOverlap && intent.coreTokens.length > 0) {
      const displayTitle = intent.canonicalProductPhrase
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const baseRef = intent.predicate.targetPrice
        ? Math.round(intent.predicate.targetPrice * 1.25)
        : 250000;

      catalog.push(
        {
          id: 'dyn_ng_jumia',
          providerName: this.providerName,
          title: `${displayTitle} (Official Nigerian Warranty)`,
          price: Math.round(baseRef * 0.88),
          shippingCost: targetZone === 'lagos' ? 0 : targetZone === 'abuja' ? 8000 : 15000,
          listPrice: baseRef,
          currency: 'NGN',
          url: buildDemoUrl({
            store: 'Jumia Official Store',
            title: `${displayTitle} Official Nigerian Edition`,
            price: Math.round(baseRef * 0.88 * 0.9),
            listPrice: baseRef,
            rating: 4.8,
            reviews: 320,
            promo: 'JUMIA10',
            currency: 'NGN'
          }),
          seller: 'Jumia Official Store',
          rating: 4.8,
          reviewCount: 320,
          inStock: true,
          promoCode: 'JUMIA10',
          promoDiscountPercent: 10,
          promoDiscountAmount: null,
          merchantTier: 'official_store',
          condition: 'brand_new',
          shippingByZone: {
            lagos: 0,
            abuja: 8000,
            interstate: 15000
          }
        },
        {
          id: 'dyn_ng_konga',
          providerName: this.providerName,
          title: `${displayTitle} — Konga Retail Fulfilled`,
          price: Math.round(baseRef * 0.85),
          shippingCost: targetZone === 'lagos' ? 3000 : targetZone === 'abuja' ? 9000 : 18000,
          listPrice: baseRef,
          currency: 'NGN',
          url: buildDemoUrl({
            store: 'Konga Retail',
            title: `${displayTitle} Konga Fulfilled`,
            price: Math.round(baseRef * 0.85),
            listPrice: baseRef,
            rating: 4.7,
            reviews: 195,
            currency: 'NGN'
          }),
          seller: 'Konga Retail',
          rating: 4.7,
          reviewCount: 195,
          inStock: true,
          promoCode: null,
          promoDiscountPercent: null,
          promoDiscountAmount: null,
          merchantTier: 'platform_fulfilled',
          condition: 'brand_new',
          shippingByZone: {
            lagos: 3000,
            abuja: 9000,
            interstate: 18000
          }
        }
      );
    }

    return catalog;
  }
}

export class DiscoveryProviderRegistry {
  private readonly providers: DiscoveryProvider[] = [];

  constructor(initialProviders?: DiscoveryProvider[]) {
    if (initialProviders) {
      this.providers.push(...initialProviders);
    } else {
      this.providers.push(
        new SyndicatedDealAdapter(),
        new SimulatedMultiStoreAdapter(),
        new NigerianCommerceAdapter()
      );
    }
  }

  register(provider: DiscoveryProvider): void {
    this.providers.push(provider);
  }

  async searchAll(
    intent: ParsedDiscoveryIntent,
    options?: DiscoverySearchOptions
  ): Promise<DiscoveredCandidateListing[]> {
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.search(intent, options))
    );
    const merged: DiscoveredCandidateListing[] = [];
    for (const res of settled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        merged.push(...res.value);
      }
    }
    return merged;
  }
}

export const discoveryProviderRegistry = new DiscoveryProviderRegistry();
