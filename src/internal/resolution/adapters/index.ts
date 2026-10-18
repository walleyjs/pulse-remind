import type { WatchRecord } from '../../watch/model.ts';
import type { DecisionMakerAdapter } from '../types.ts';
import { webPortalOracleAdapter } from './web-portal.adapter.ts';
import { jsonApiOracleAdapter } from './json-api.adapter.ts';

/**
 * Adapter Registry modeled on Octopus `ResolutionEngine::get_adapter_for_market`
 * (`src/internal/resolution/engine.rs:228-255`)
 */
export function getAdapterForWatch(watch: WatchRecord): DecisionMakerAdapter {
  const oracleType = watch.resolution_config?.oracle_api;
  if (oracleType === 'json_api') {
    return jsonApiOracleAdapter;
  }
  return webPortalOracleAdapter;
}
