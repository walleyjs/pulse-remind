import crypto from 'node:crypto';
import { config } from '../../config/index.ts';
import { isDisallowedAmbientEmail } from '../../pkg/privacy/minimizer.ts';
import { DEFAULT_TENANT_ID } from '../../pkg/tenant/tenant.ts';
import type { CommercePredicateConfig } from '../resolution/predicates.ts';
import type { NotificationChannelType, WatchRecord } from '../watch/model.ts';
import { watchService, WatchService } from '../watch/service.ts';
import { parseDiscoveryQuery, type ParsedDiscoveryIntent } from './disambiguation.ts';
import {
  discoveryProviderRegistry,
  DiscoveryProviderRegistry,
  type DiscoverySearchOptions
} from './provider.ts';
import {
  rankDiscoveredCandidates,
  type RankedDealCandidate,
  type RejectedDealCandidate
} from './ranker.ts';

export interface DealDiscoveryRequest {
  query: string;
  tenantId?: string;
  baseUrl?: string;
  predicateOverrides?: Partial<CommercePredicateConfig>;
  autoWatchIfAboveTarget?: boolean;
  alwaysCreateWatch?: boolean;
  maxClusterWatches?: number;
  recipientEmail?: string | null;
  notifyChannels?: NotificationChannelType[];
  searchOptions?: DiscoverySearchOptions;
}

export interface DealDiscoveryResponse {
  query: string;
  parsed_intent: ParsedDiscoveryIntent;
  resolution_mode: 'immediate_winner' | 'cluster_watch_armed' | 'no_verified_candidates';
  winning_deal: RankedDealCandidate | null;
  leaderboard: RankedDealCandidate[];
  rejected_count: number;
  rejected_candidates: RejectedDealCandidate[];
  cluster_group_id: string | null;
  created_cluster_watches: WatchRecord[];
  elapsed_ms: number;
}

export class DealDiscoveryService {
  private readonly providers: DiscoveryProviderRegistry;
  private readonly watches: WatchService;

  constructor(
    providers: DiscoveryProviderRegistry = discoveryProviderRegistry,
    watches: WatchService = watchService
  ) {
    this.providers = providers;
    this.watches = watches;
  }

  async discoverAndWatch(req: DealDiscoveryRequest): Promise<DealDiscoveryResponse> {
    const t0 = performance.now();
    const tenantId = req.tenantId || DEFAULT_TENANT_ID;
    const baseUrl = (req.baseUrl || config.cloud.renderExternalUrl || 'http://localhost:3456').replace(
      /\/$/,
      ''
    );

    const intent = parseDiscoveryQuery(req.query, req.predicateOverrides);
    const rawCandidates = await this.providers.searchAll(intent, {
      baseUrl,
      ...(req.searchOptions || {})
    });

    const ranking = rankDiscoveredCandidates(intent, rawCandidates);
    const { rankedDeals, immediateWinners, rejectedCandidates } = ranking;

    const cleanEmail =
      req.recipientEmail &&
      req.recipientEmail.includes('@') &&
      !isDisallowedAmbientEmail(req.recipientEmail.trim())
        ? req.recipientEmail.trim()
        : undefined;

    if (rankedDeals.length === 0) {
      return {
        query: req.query,
        parsed_intent: intent,
        resolution_mode: 'no_verified_candidates',
        winning_deal: null,
        leaderboard: [],
        rejected_count: rejectedCandidates.length,
        rejected_candidates: rejectedCandidates,
        cluster_group_id: null,
        created_cluster_watches: [],
        elapsed_ms: Number((performance.now() - t0).toFixed(2))
      };
    }

    // State 1: Immediate Verified Winner Found
    if (immediateWinners.length > 0 && !req.alwaysCreateWatch) {
      return {
        query: req.query,
        parsed_intent: intent,
        resolution_mode: 'immediate_winner',
        winning_deal: immediateWinners[0],
        leaderboard: rankedDeals,
        rejected_count: rejectedCandidates.length,
        rejected_candidates: rejectedCandidates,
        cluster_group_id: null,
        created_cluster_watches: [],
        elapsed_ms: Number((performance.now() - t0).toFixed(2))
      };
    }

    // State 2: Competitive Multi-Store Cluster Watch (1-to-N Race Watchdog)
    const shouldArmCluster = req.autoWatchIfAboveTarget !== false || req.alwaysCreateWatch === true;
    const createdWatches: WatchRecord[] = [];
    let clusterGroupId: string | null = null;

    if (shouldArmCluster) {
      const maxCluster = Math.max(1, Math.min(5, req.maxClusterWatches ?? 3));
      const seenUrls = new Set<string>();
      const contenders: RankedDealCandidate[] = [];

      for (const candidate of rankedDeals) {
        if (!seenUrls.has(candidate.listing.url)) {
          seenUrls.add(candidate.listing.url);
          contenders.push(candidate);
          if (contenders.length >= maxCluster) break;
        }
      }

      if (contenders.length > 0) {
        clusterGroupId = 'cluster_' + crypto.randomUUID().slice(0, 8);
        const targetText =
          intent.predicate.targetPrice != null
            ? `$${intent.predicate.targetPrice.toFixed(2)}`
            : intent.predicate.maxDropPercentage != null
              ? `${intent.predicate.maxDropPercentage}% off`
              : 'target drop';

        for (const contender of contenders) {
          const item = contender.listing;
          const wilsonPct = (contender.wilsonConfidence * 100).toFixed(1);
          const checklist = [
            `Compare ${item.seller} current landed price ($${contender.landedPrice.toFixed(2)}) against ${targetText} threshold`,
            item.promoCode
              ? `Apply verified promo code ${item.promoCode} at checkout`
              : 'Check merchant checkout for stackable promo codes',
            `Verify seller trust (${wilsonPct}% Wilson confidence across ${item.reviewCount} reviews) before payment`
          ].join('\n');

          const watch = this.watches.createWatch(
            {
              title: `${item.title} [${item.seller}]`,
              tenant_id: tenantId,
              category: 'deal_or_promo',
              chat_context: checklist,
              source_chat_client: 'Multi-Store Deal Discovery Engine',
              target_url: item.url,
              trigger_type: 'web_monitor',
              condition_text: `Landed price drops to ${targetText} with >= ${Math.round((intent.predicate.minRatingConfidence ?? 0.7) * 100)}% Wilson rating confidence`,
              notify_channels: req.notifyChannels || ['in_app', 'email'],
              recipient_email: cleanEmail,
              commerce_predicate: intent.predicate,
              cluster_group_id: clusterGroupId,
              resolution_config: {
                primary_source_name: item.seller,
                primary_source_url: item.url,
                oracle_api: 'web_portal',
                dynamic_condition: 'commerce_threshold',
                is_auto_resolve: true,
                entity_must_match: true,
                provider_metadata: {
                  cluster_group_id: clusterGroupId,
                  discovery_query: req.query,
                  initial_landed_price: String(contender.landedPrice),
                  wilson_confidence: String(contender.wilsonConfidence)
                }
              }
            },
            tenantId
          );
          createdWatches.push(watch);
        }
      }
    }

    return {
      query: req.query,
      parsed_intent: intent,
      resolution_mode: immediateWinners.length > 0 ? 'immediate_winner' : 'cluster_watch_armed',
      winning_deal: immediateWinners[0] || null,
      leaderboard: rankedDeals,
      rejected_count: rejectedCandidates.length,
      rejected_candidates: rejectedCandidates,
      cluster_group_id: clusterGroupId,
      created_cluster_watches: createdWatches,
      elapsed_ms: Number((performance.now() - t0).toFixed(2))
    };
  }
}

export const dealDiscoveryService = new DealDiscoveryService();
