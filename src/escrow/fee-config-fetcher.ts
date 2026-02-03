/**
 * Fee Configuration Fetcher
 *
 * Fetches fee configuration from the Dome API and converts it to SDK format.
 * Includes caching to reduce API calls.
 *
 * Server Format (split-based):
 *   - orderFee.feeBps: Total fee in basis points
 *   - affiliate.orderFeeSplitBps: Affiliate's share of orderFee (out of 10000)
 *   - performanceFee.feeBps: Total performance fee in basis points
 *   - affiliate.performanceFeeSplitBps: Affiliate's share of performanceFee (out of 10000)
 *
 * SDK Format (independent fees):
 *   - orderFee.domeFeeBps: Dome's portion in basis points
 *   - orderFee.affiliateFeeBps: Affiliate's portion in basis points
 *   - performanceFee.domeFeeBps: Dome's portion in basis points
 *   - performanceFee.affiliateFeeBps: Affiliate's portion in basis points
 */

// ============ Types ============

/**
 * Server response format for /v1/fees endpoint
 */
export interface ServerFeeResponse {
  result: {
    orderFee: {
      enabled: boolean;
      feeBps: number;
      minFeeUsdc: string;
    };
    performanceFee: {
      enabled: boolean;
      feeBps: number;
      minFeeUsdc: string;
    };
    affiliate: {
      address: string;
      name?: string;
      orderFeeSplitBps: number;
      performanceFeeSplitBps: number;
    };
    domeAddress: string;
    escrowAddress: string;
    chainId: number;
  };
}

/**
 * SDK fee configuration format with independent dome/affiliate fees
 */
export interface SDKFeeConfig {
  orderFee: {
    enabled: boolean;
    domeFeeBps: number;
    affiliateFeeBps: number;
    minFeeUsdc: bigint;
  };
  performanceFee: {
    enabled: boolean;
    domeFeeBps: number;
    affiliateFeeBps: number;
    minFeeUsdc: bigint;
  };
  affiliate: {
    address: string;
    name?: string;
  };
  domeAddress: string;
  escrowAddress: string;
  chainId: number;
}

/**
 * Options for fetching fee configuration
 */
export interface FetchFeeConfigOptions {
  /** Dome API key for authentication */
  apiKey: string;
  /** API endpoint (default: https://api.domeapi.io/v1) */
  apiEndpoint?: string;
  /** Cache TTL in milliseconds (default: 300000 = 5 minutes, 0 to disable) */
  cacheTTL?: number;
}

// ============ Cache ============

interface CacheEntry {
  config: SDKFeeConfig;
  expiresAt: number;
}

// Cache keyed by API key
const configCache = new Map<string, CacheEntry>();

// Default cache TTL: 5 minutes
const DEFAULT_CACHE_TTL = 300000;
const DEFAULT_API_ENDPOINT = 'https://api.domeapi.io/v1';

// ============ Validation Helpers ============

/**
 * Parse a string to bigint with validation
 * @throws Error if value is not a valid non-negative integer string
 */
function parseMinFeeUsdc(value: unknown, fieldName: string): bigint {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid ${fieldName}: expected string, got ${typeof value}`
    );
  }
  // Only allow non-negative integer strings (no scientific notation, decimals, etc.)
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}" is not a valid non-negative integer string`
    );
  }
  return BigInt(value);
}

/**
 * Validate fee section structure
 */
function validateFeeSection(
  fee: unknown,
  sectionName: string
): asserts fee is { enabled: boolean; feeBps: number; minFeeUsdc: string } {
  if (!fee || typeof fee !== 'object') {
    throw new Error(`Invalid ${sectionName}: expected object`);
  }

  const f = fee as Record<string, unknown>;

  if (typeof f.enabled !== 'boolean') {
    throw new Error(
      `Invalid ${sectionName}.enabled: expected boolean, got ${typeof f.enabled}`
    );
  }
  if (
    typeof f.feeBps !== 'number' ||
    !Number.isFinite(f.feeBps) ||
    f.feeBps < 0
  ) {
    throw new Error(
      `Invalid ${sectionName}.feeBps: expected non-negative number, got ${f.feeBps}`
    );
  }
  if (typeof f.minFeeUsdc !== 'string') {
    throw new Error(
      `Invalid ${sectionName}.minFeeUsdc: expected string, got ${typeof f.minFeeUsdc}`
    );
  }
}

/**
 * Validate affiliate section structure
 */
function validateAffiliateSection(affiliate: unknown): asserts affiliate is {
  address: string;
  name?: string;
  orderFeeSplitBps: number;
  performanceFeeSplitBps: number;
} {
  if (!affiliate || typeof affiliate !== 'object') {
    throw new Error('Invalid affiliate: expected object');
  }

  const a = affiliate as Record<string, unknown>;

  if (typeof a.address !== 'string') {
    throw new Error(
      `Invalid affiliate.address: expected string, got ${typeof a.address}`
    );
  }
  if (a.name !== undefined && typeof a.name !== 'string') {
    throw new Error(
      `Invalid affiliate.name: expected string or undefined, got ${typeof a.name}`
    );
  }
  if (
    typeof a.orderFeeSplitBps !== 'number' ||
    !Number.isFinite(a.orderFeeSplitBps) ||
    a.orderFeeSplitBps < 0 ||
    a.orderFeeSplitBps > 10000
  ) {
    throw new Error(
      `Invalid affiliate.orderFeeSplitBps: expected number 0-10000, got ${a.orderFeeSplitBps}`
    );
  }
  if (
    typeof a.performanceFeeSplitBps !== 'number' ||
    !Number.isFinite(a.performanceFeeSplitBps) ||
    a.performanceFeeSplitBps < 0 ||
    a.performanceFeeSplitBps > 10000
  ) {
    throw new Error(
      `Invalid affiliate.performanceFeeSplitBps: expected number 0-10000, got ${a.performanceFeeSplitBps}`
    );
  }
}

// ============ Conversion ============

/**
 * Convert server's split-based format to SDK's independent fee format
 *
 * Server sends: feeBps (total) + splitBps (affiliate's share percentage)
 * SDK needs: domeFeeBps + affiliateFeeBps (independent amounts)
 *
 * Note: Math.round() is used for split conversion which can introduce
 * rounding of up to 0.5 BPS. For example, feeBps=33 with 33.33% split
 * yields affiliate=11, dome=22 (not exactly 1/3 each). This is acceptable
 * for basis point calculations where 1 BPS = 0.01%.
 *
 * @example
 * Server: feeBps=25, orderFeeSplitBps=2000 (20%)
 * SDK: affiliateFeeBps=5 (25 * 20%), domeFeeBps=20 (25 - 5)
 */
export function convertServerConfigToSDK(
  serverResponse: ServerFeeResponse
): SDKFeeConfig {
  const { result } = serverResponse;

  // Convert order fee split (affiliate gets percentage of total, dome gets remainder)
  const orderAffiliateBps = Math.round(
    (result.orderFee.feeBps * result.affiliate.orderFeeSplitBps) / 10000
  );
  const orderDomeBps = result.orderFee.feeBps - orderAffiliateBps;

  // Convert performance fee split
  const perfAffiliateBps = Math.round(
    (result.performanceFee.feeBps * result.affiliate.performanceFeeSplitBps) /
      10000
  );
  const perfDomeBps = result.performanceFee.feeBps - perfAffiliateBps;

  // Parse minFeeUsdc with validation
  const orderMinFee = parseMinFeeUsdc(
    result.orderFee.minFeeUsdc,
    'orderFee.minFeeUsdc'
  );
  const perfMinFee = parseMinFeeUsdc(
    result.performanceFee.minFeeUsdc,
    'performanceFee.minFeeUsdc'
  );

  const sdkConfig: SDKFeeConfig = {
    orderFee: {
      enabled: result.orderFee.enabled,
      domeFeeBps: orderDomeBps,
      affiliateFeeBps: orderAffiliateBps,
      minFeeUsdc: orderMinFee,
    },
    performanceFee: {
      enabled: result.performanceFee.enabled,
      domeFeeBps: perfDomeBps,
      affiliateFeeBps: perfAffiliateBps,
      minFeeUsdc: perfMinFee,
    },
    affiliate: {
      address: result.affiliate.address,
    },
    domeAddress: result.domeAddress,
    escrowAddress: result.escrowAddress,
    chainId: result.chainId,
  };

  // Only add name if it exists
  if (result.affiliate.name) {
    sdkConfig.affiliate.name = result.affiliate.name;
  }

  return sdkConfig;
}

// ============ Fetch ============

/**
 * Fetch fee configuration from Dome API
 *
 * Fetches from the /v1/fees endpoint, converts split-based server format
 * to independent fee format, and caches result locally.
 *
 * @param options Configuration options
 * @param options.apiKey DOME API key (required) - also used as cache key
 * @param options.apiEndpoint API endpoint (default: https://api.domeapi.io/v1)
 * @param options.cacheTTL Cache TTL in ms (default: 300000 = 5 min, 0 to disable)
 *
 * @returns SDK fee configuration (converted from server split format)
 *
 * @throws Error if:
 *   - Authentication fails (401 Unauthorized)
 *   - Server error (500 Internal Server Error)
 *   - Network error (fetch fails)
 *   - Invalid response structure (missing fields or wrong types)
 *   - Invalid minFeeUsdc value (not a valid integer string)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const config = await fetchFeeConfig({
 *   apiKey: 'your-dome-api-key',
 * });
 *
 * // With custom cache TTL
 * const config = await fetchFeeConfig({
 *   apiKey: 'your-dome-api-key',
 *   cacheTTL: 60000, // 1 minute
 * });
 *
 * // Disable caching
 * const config = await fetchFeeConfig({
 *   apiKey: 'your-dome-api-key',
 *   cacheTTL: 0,
 * });
 *
 * console.log(config.orderFee.domeFeeBps);      // e.g., 20
 * console.log(config.orderFee.affiliateFeeBps); // e.g., 5
 * ```
 */
export async function fetchFeeConfig(
  options: FetchFeeConfigOptions
): Promise<SDKFeeConfig> {
  const {
    apiKey,
    apiEndpoint = DEFAULT_API_ENDPOINT,
    cacheTTL = DEFAULT_CACHE_TTL,
  } = options;

  // Check cache first (if caching enabled)
  if (cacheTTL > 0) {
    const cached = configCache.get(apiKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.config;
    }
  }

  // Fetch from server
  const response = await fetch(`${apiEndpoint}/fees`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // Ignore parse errors
    }
    throw new Error(
      `Failed to fetch fee configuration: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`
    );
  }

  const data = await response.json();

  // Validate response structure
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid fee configuration response: expected object');
  }

  if (!data.result || typeof data.result !== 'object') {
    throw new Error('Invalid fee configuration response: missing result field');
  }

  const { result } = data;

  // Validate each section with detailed type checking
  validateFeeSection(result.orderFee, 'orderFee');
  validateFeeSection(result.performanceFee, 'performanceFee');
  validateAffiliateSection(result.affiliate);

  // Validate other required fields
  if (typeof result.domeAddress !== 'string') {
    throw new Error(
      `Invalid domeAddress: expected string, got ${typeof result.domeAddress}`
    );
  }
  if (typeof result.escrowAddress !== 'string') {
    throw new Error(
      `Invalid escrowAddress: expected string, got ${typeof result.escrowAddress}`
    );
  }
  if (typeof result.chainId !== 'number' || !Number.isInteger(result.chainId)) {
    throw new Error(`Invalid chainId: expected integer, got ${result.chainId}`);
  }

  // Convert to SDK format
  const sdkConfig = convertServerConfigToSDK(data as ServerFeeResponse);

  // Cache result (if caching enabled)
  if (cacheTTL > 0) {
    configCache.set(apiKey, {
      config: sdkConfig,
      expiresAt: Date.now() + cacheTTL,
    });
  }

  return sdkConfig;
}

/**
 * Clear the fee configuration cache
 *
 * Useful for testing or when you need to force a fresh fetch.
 *
 * @param apiKey - Optional API key to clear specific cache entry. If not provided, clears all.
 */
export function clearConfigCache(apiKey?: string): void {
  if (apiKey) {
    configCache.delete(apiKey);
  } else {
    configCache.clear();
  }
}

/**
 * Check if a cached config exists and is valid
 *
 * @param apiKey - API key to check
 * @returns true if valid cached config exists
 */
export function hasCachedConfig(apiKey: string): boolean {
  const cached = configCache.get(apiKey);
  return cached !== undefined && cached.expiresAt > Date.now();
}
