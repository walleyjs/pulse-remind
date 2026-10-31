import { config } from '../../config/index.ts';
import type { ParsedDiscoveryIntent } from './disambiguation.ts';

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
}

export interface DiscoverySearchOptions {
  baseUrl?: string;
  syndicatedFeedPayloads?: Array<{ sourceName: string; format: 'rss' | 'json'; content: string }>;
  syndicatedFeedUrls?: string[];
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
        promoDiscountAmount: null
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
      return intent.coreTokens.some((tok) => lower.includes(tok));
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

export class DiscoveryProviderRegistry {
  private readonly providers: DiscoveryProvider[] = [];

  constructor(initialProviders?: DiscoveryProvider[]) {
    if (initialProviders) {
      this.providers.push(...initialProviders);
    } else {
      this.providers.push(new SyndicatedDealAdapter(), new SimulatedMultiStoreAdapter());
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
