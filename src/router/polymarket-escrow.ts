/**
 * Polymarket Router with Fee Escrow
 *
 * Drop-in replacement for PolymarketRouter that automatically handles
 * fee escrow for every order. Users simply swap the class name:
 *
 * Before: const router = new PolymarketRouter({ apiKey });
 * After:  const router = new PolymarketRouterWithEscrow({ apiKey, escrow: { ... } });
 *
 * The router will:
 * 1. Generate a unique orderId for each order
 * 2. Create and sign a fee authorization (EIP-712)
 * 3. Include the signed fee auth in the order request
 * 4. The Dome server then pulls the fee to escrow before placing the order
 */

import * as crypto from 'crypto';
import { ethers, Wallet } from 'ethers';
import { PolymarketRouter } from './polymarket.js';
import {
  PlaceOrderParams,
  PolymarketCredentials,
  PolymarketRouterConfig,
  ServerPlaceOrderRequest,
  ServerPlaceOrderResponse,
  SignedPolymarketOrder,
} from '../types.js';
import {
  generateOrderId,
  parseUsdc,
  calculateFee,
  ESCROW_CONTRACT_V2_POLYGON,
  ORDER_FEE_TYPES,
  createDomeFeeEscrowEIP712Domain,
  MIN_ORDER_FEE,
  MIN_PERFORMANCE_FEE,
} from '../escrow/index.js';
import {
  fetchFeeConfig,
  type FetchFeeConfigOptions,
} from '../escrow/fee-config-fetcher.js';

// Dome API endpoint
const DOME_API_ENDPOINT = 'https://api.domeapi.io/v1';

/**
 * Escrow configuration for the router
 */
export interface EscrowConfig {
  /** Dome fee in basis points (e.g., 20 = 0.20%). Default: 20 */
  domeFeeBps?: number;
  /** Affiliate fee in basis points (e.g., 5 = 0.05%). Default: 0 */
  affiliateFeeBps?: number;
  /** Affiliate wallet address (required if affiliateFeeBps > 0) */
  affiliate?: string;
  /** Escrow contract address. Default: Polygon mainnet contract */
  escrowAddress?: string;
  /** Chain ID. Default: 137 (Polygon) */
  chainId?: number;
  /** Deadline for fee authorization in seconds. Default: 3600 (1 hour) */
  deadlineSeconds?: number;
  /** Performance fee - Dome fee in basis points. Default: same as domeFeeBps */
  performanceDomeFeeBps?: number;
  /** Performance fee - Affiliate fee in basis points. Default: same as affiliateFeeBps */
  performanceAffiliateFeeBps?: number;
  /** Minimum order fee in USDC (6 decimals). Default: MIN_ORDER_FEE (10000 = $0.01) */
  minOrderFeeUsdc?: bigint;
  /** Minimum performance fee in USDC (6 decimals). Default: MIN_PERFORMANCE_FEE (100000 = $0.10) */
  minPerformanceFeeUsdc?: bigint;
}

/**
 * Extended router config with escrow settings
 */
export interface PolymarketRouterWithEscrowConfig extends PolymarketRouterConfig {
  escrow?: EscrowConfig;
  /** Fetch fee configuration from Dome API server instead of using local defaults */
  fetchConfigFromServer?: boolean;
  /** Cache TTL for server-fetched config in milliseconds. Default: 300000 (5 min). Set to 0 to disable caching. */
  configCacheTTL?: number;
}

/**
 * Extended place order params with escrow options
 */
export interface PlaceOrderWithEscrowParams extends PlaceOrderParams {
  /** Override Dome fee for this order (basis points) */
  domeFeeBps?: number;
  /** Override affiliate fee for this order (basis points) */
  affiliateFeeBps?: number;
  /** Override affiliate address for this order */
  affiliate?: string;
  /** Skip fee escrow for this order */
  skipEscrow?: boolean;
}

/**
 * Internal resolved escrow configuration with all values set
 */
interface ResolvedEscrowConfig {
  domeFeeBps: number;
  affiliateFeeBps: number;
  affiliate: string;
  escrowAddress: string;
  chainId: number;
  deadlineSeconds: number;
  performanceDomeFeeBps: number;
  performanceAffiliateFeeBps: number;
  minOrderFeeUsdc: bigint;
  minPerformanceFeeUsdc: bigint;
}

/**
 * Performance fee split result
 */
export interface PerformanceFeeSplitResult {
  totalFee: bigint;
  domeAmount: bigint;
  affiliateAmount: bigint;
}

/**
 * Polymarket Router with automatic fee escrow
 *
 * Extends PolymarketRouter to automatically generate and sign fee
 * authorizations for every order placed.
 */
export class PolymarketRouterWithEscrow extends PolymarketRouter {
  private readonly escrowConfig: ResolvedEscrowConfig;

  /**
   * Create a new router instance, optionally fetching config from server
   *
   * This static factory method supports both synchronous (local config) and
   * asynchronous (server-fetched config) initialization patterns.
   *
   * @param config - Router configuration
   * @returns Promise resolving to configured router instance
   *
   * @example
   * ```typescript
   * // Fetch config from server
   * const router = await PolymarketRouterWithEscrow.create({
   *   apiKey: 'your-dome-api-key',
   *   fetchConfigFromServer: true,
   * });
   *
   * // Use local config (same as constructor)
   * const router = await PolymarketRouterWithEscrow.create({
   *   apiKey: 'your-dome-api-key',
   *   escrow: { domeFeeBps: 20, affiliateFeeBps: 5 },
   * });
   * ```
   */
  static async create(
    config: PolymarketRouterWithEscrowConfig = {}
  ): Promise<PolymarketRouterWithEscrow> {
    if (config.fetchConfigFromServer) {
      const apiKey = config.apiKey;
      if (!apiKey) {
        throw new Error(
          'apiKey is required when fetchConfigFromServer is true'
        );
      }

      // Fetch config from server
      const fetchOptions: FetchFeeConfigOptions = { apiKey };
      if (config.configCacheTTL !== undefined) {
        fetchOptions.cacheTTL = config.configCacheTTL;
      }
      const sdkConfig = await fetchFeeConfig(fetchOptions);

      // Convert server config to escrow config
      const escrowConfig: EscrowConfig = {
        domeFeeBps: sdkConfig.orderFee.domeFeeBps,
        affiliateFeeBps: sdkConfig.orderFee.affiliateFeeBps,
        affiliate: sdkConfig.affiliate.address,
        escrowAddress: sdkConfig.escrowAddress,
        chainId: sdkConfig.chainId,
        performanceDomeFeeBps: sdkConfig.performanceFee.domeFeeBps,
        performanceAffiliateFeeBps: sdkConfig.performanceFee.affiliateFeeBps,
        minOrderFeeUsdc: sdkConfig.orderFee.minFeeUsdc,
        minPerformanceFeeUsdc: sdkConfig.performanceFee.minFeeUsdc,
      };

      return new PolymarketRouterWithEscrow({
        ...config,
        escrow: escrowConfig,
        fetchConfigFromServer: false, // Already fetched
      });
    }

    // Use local config (synchronous path)
    return new PolymarketRouterWithEscrow(config);
  }

  constructor(config: PolymarketRouterWithEscrowConfig = {}) {
    super(config);

    // Default: 20 BPS to Dome, 0 to affiliate
    const domeFeeBps = config.escrow?.domeFeeBps ?? 20;
    const affiliateFeeBps = config.escrow?.affiliateFeeBps ?? 0;

    // Validate affiliate address if affiliate fee is set
    if (affiliateFeeBps > 0 && !config.escrow?.affiliate) {
      throw new Error('affiliate address is required when affiliateFeeBps > 0');
    }

    // Performance fees default to order fee values if not specified
    const performanceDomeFeeBps =
      config.escrow?.performanceDomeFeeBps ?? domeFeeBps;
    const performanceAffiliateFeeBps =
      config.escrow?.performanceAffiliateFeeBps ?? affiliateFeeBps;

    // Min fees default to hardcoded constants if not provided
    const minOrderFeeUsdc = config.escrow?.minOrderFeeUsdc ?? MIN_ORDER_FEE;
    const minPerformanceFeeUsdc =
      config.escrow?.minPerformanceFeeUsdc ?? MIN_PERFORMANCE_FEE;

    // Set escrow configuration
    this.escrowConfig = {
      domeFeeBps,
      affiliateFeeBps,
      affiliate: config.escrow?.affiliate ?? ethers.constants.AddressZero,
      escrowAddress: config.escrow?.escrowAddress ?? ESCROW_CONTRACT_V2_POLYGON,
      chainId: config.escrow?.chainId ?? 137,
      deadlineSeconds: config.escrow?.deadlineSeconds ?? 3600,
      performanceDomeFeeBps,
      performanceAffiliateFeeBps,
      minOrderFeeUsdc,
      minPerformanceFeeUsdc,
    };
  }

  /**
   * Places an order on Polymarket with automatic fee escrow
   *
   * This method:
   * 1. Generates a unique orderId from order parameters
   * 2. Creates and signs a fee authorization (EIP-712)
   * 3. Submits the order with fee auth to Dome server
   * 4. Server pulls fee to escrow, then places the order
   *
   * On fill: Server distributes fee to Dome + affiliate
   * On cancel: Server refunds remaining fee to user
   */
  async placeOrder(
    params: PlaceOrderWithEscrowParams,
    credentials?: PolymarketCredentials
  ): Promise<any> {
    // If skipEscrow is true, use parent implementation
    if (params.skipEscrow) {
      return super.placeOrder(params, credentials);
    }

    // We need to override the entire placeOrder to inject fee auth
    // This duplicates some logic from parent, but is necessary for the integration

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Dome API key not set. Pass apiKey to router constructor to use placeOrder.'
      );
    }

    const {
      userId,
      marketId,
      side,
      size,
      price,
      signer,
      walletType = 'eoa',
      funderAddress,
      privyWalletId,
      walletAddress,
      negRisk = false,
      orderType = 'GTC',
      domeFeeBps = this.escrowConfig.domeFeeBps,
      affiliateFeeBps = this.escrowConfig.affiliateFeeBps,
      affiliate = this.escrowConfig.affiliate,
    } = params;

    // Get or create signer
    const actualSigner = this.getOrCreateSigner(params);
    if (!actualSigner) {
      throw new Error(
        'Either provide a signer or Privy wallet info (privyWalletId + walletAddress)'
      );
    }

    // Get credentials
    const creds = credentials || this.getCredentials(userId);
    if (!creds) {
      throw new Error(
        `No credentials found for user ${userId}. Call linkUser() first.`
      );
    }

    const signerAddress = await actualSigner.getAddress();

    // Determine funder (payer for escrow)
    let payerAddress: string;
    if (walletType === 'safe') {
      payerAddress =
        funderAddress || this.getSafeAddress(userId) || signerAddress;
      if (!funderAddress && !this.getSafeAddress(userId)) {
        throw new Error('funderAddress is required for Safe wallet orders.');
      }
    } else {
      payerAddress = signerAddress;
    }

    // Calculate order size in USDC (6 decimals)
    // Size is in shares, price is 0-1, so USDC cost = size * price
    const orderSizeUsdc = parseUsdc(size * price);

    // Calculate independent fees using configured BPS values
    let domeAmount = (orderSizeUsdc * BigInt(domeFeeBps)) / BigInt(10000);
    let affiliateAmount =
      (orderSizeUsdc * BigInt(affiliateFeeBps)) / BigInt(10000);
    let totalFee = domeAmount + affiliateAmount;

    // Ensure minimum fee is met with proportional scaling
    if (totalFee < MIN_ORDER_FEE && totalFee > BigInt(0)) {
      const scale = (MIN_ORDER_FEE * BigInt(10000)) / totalFee;
      domeAmount = (domeAmount * scale) / BigInt(10000);
      affiliateAmount = MIN_ORDER_FEE - domeAmount;
      totalFee = MIN_ORDER_FEE;
    } else if (totalFee === BigInt(0)) {
      // If both rates are 0, apply minimum to dome only
      domeAmount = MIN_ORDER_FEE;
      affiliateAmount = BigInt(0);
      totalFee = MIN_ORDER_FEE;
    }

    // Generate unique orderId
    const timestamp = Date.now();
    const orderId = generateOrderId({
      chainId: this.escrowConfig.chainId,
      userAddress: payerAddress,
      marketId,
      side,
      size: orderSizeUsdc,
      price,
      timestamp,
    });

    // Create V2 order fee authorization
    const deadline =
      Math.floor(Date.now() / 1000) + this.escrowConfig.deadlineSeconds;

    const orderFeeAuth = {
      orderId,
      payer: payerAddress,
      domeAmount,
      affiliateAmount,
      chainId: this.escrowConfig.chainId,
      deadline,
    };

    // Sign V2 fee authorization using EIP-712
    const domain = createDomeFeeEscrowEIP712Domain(
      this.escrowConfig.escrowAddress,
      this.escrowConfig.chainId
    );

    const signature = await actualSigner.signTypedData({
      domain,
      types: ORDER_FEE_TYPES,
      primaryType: 'OrderFeeAuthorization',
      message: {
        orderId: orderFeeAuth.orderId,
        payer: orderFeeAuth.payer,
        domeAmount: orderFeeAuth.domeAmount.toString(),
        affiliateAmount: orderFeeAuth.affiliateAmount.toString(),
        chainId: orderFeeAuth.chainId,
        deadline: orderFeeAuth.deadline,
      },
    });

    // Create signed order using parent's CLOB client logic
    const signedOrder = await this.createSignedOrder(params, creds);

    // Build request with fee auth
    // clientOrderId must be a valid UUID per Dome API requirements
    const clientOrderId = crypto.randomUUID();

    const request: ServerPlaceOrderRequest = {
      jsonrpc: '2.0',
      method: 'placeOrder',
      id: clientOrderId,
      params: {
        // Required for escrow: identify payer and signer
        payerAddress,
        signerAddress,
        signedOrder,
        orderType,
        credentials: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        clientOrderId,
        feeAuth: {
          orderId: orderFeeAuth.orderId,
          payer: orderFeeAuth.payer,
          feeAmount: (
            orderFeeAuth.domeAmount + orderFeeAuth.affiliateAmount
          ).toString(),
          domeAmount: orderFeeAuth.domeAmount.toString(),
          affiliateAmount: orderFeeAuth.affiliateAmount.toString(),
          chainId: orderFeeAuth.chainId,
          deadline: orderFeeAuth.deadline,
          signature,
        },
        ...(affiliate !== ethers.constants.AddressZero && { affiliate }),
      },
    };

    // Submit to Dome server
    const response = await fetch(`${DOME_API_ENDPOINT}/polymarket/placeOrder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // Ignore
      }
      throw new Error(
        `Server request failed: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`
      );
    }

    const serverResponse: ServerPlaceOrderResponse = await response.json();

    if (serverResponse.error) {
      const reason =
        serverResponse.error.data?.reason || serverResponse.error.message;
      throw new Error(
        `Order placement failed: ${reason} (code: ${serverResponse.error.code})`
      );
    }

    if (!serverResponse.result) {
      throw new Error('Server returned empty result');
    }

    // Check for Polymarket HTTP error
    const result = serverResponse.result as any;
    if (typeof result.status === 'number' && result.status >= 400) {
      const errorMessage =
        result.errorMessage ||
        result.error ||
        `Polymarket returned HTTP ${result.status}`;
      throw new Error(`Order rejected by Polymarket: ${errorMessage}`);
    }

    return serverResponse.result;
  }

  /**
   * Get the escrow configuration
   */
  getEscrowConfig(): Readonly<ResolvedEscrowConfig> {
    return { ...this.escrowConfig };
  }

  /**
   * Calculate the fee for an order (dome + affiliate combined)
   *
   * Uses the router's configured minimum fee (from server or local default).
   */
  calculateOrderFee(
    size: number,
    price: number,
    domeFeeBps?: number,
    affiliateFeeBps?: number
  ): bigint {
    const orderSizeUsdc = parseUsdc(size * price);
    const dBps = domeFeeBps ?? this.escrowConfig.domeFeeBps;
    const aBps = affiliateFeeBps ?? this.escrowConfig.affiliateFeeBps;
    const minFee = this.escrowConfig.minOrderFeeUsdc;

    let domeAmount = (orderSizeUsdc * BigInt(dBps)) / BigInt(10000);
    let affiliateAmount = (orderSizeUsdc * BigInt(aBps)) / BigInt(10000);
    let totalFee = domeAmount + affiliateAmount;

    // Ensure minimum fee with proportional scaling
    if (totalFee < minFee && totalFee > BigInt(0)) {
      const scale = (minFee * BigInt(10000)) / totalFee;
      domeAmount = (domeAmount * scale) / BigInt(10000);
      affiliateAmount = minFee - domeAmount;
      totalFee = minFee;
    } else if (totalFee === BigInt(0)) {
      totalFee = minFee;
    }

    return totalFee;
  }

  /**
   * Calculate performance fee for winnings (dome + affiliate combined)
   *
   * Performance fees are charged only when claiming winning positions.
   * Uses the router's configured performance fee rates and minimum fee.
   *
   * @param winnings - Total winnings amount in USDC (6 decimals)
   * @param domeFeeBps - Override Dome fee BPS (optional)
   * @param affiliateFeeBps - Override affiliate fee BPS (optional)
   * @returns Total fee amount in USDC (6 decimals)
   *
   * @example
   * ```typescript
   * // $1000 winnings with default config (e.g., 4% dome + 1% affiliate)
   * const fee = router.calculatePerformanceFee(1000_000_000n);
   * // fee = 50_000_000n ($50)
   * ```
   */
  calculatePerformanceFee(
    winnings: bigint,
    domeFeeBps?: number,
    affiliateFeeBps?: number
  ): bigint {
    const dBps = domeFeeBps ?? this.escrowConfig.performanceDomeFeeBps;
    const aBps =
      affiliateFeeBps ?? this.escrowConfig.performanceAffiliateFeeBps;
    const minFee = this.escrowConfig.minPerformanceFeeUsdc;

    let domeAmount = (winnings * BigInt(dBps)) / BigInt(10000);
    let affiliateAmount = (winnings * BigInt(aBps)) / BigInt(10000);
    let totalFee = domeAmount + affiliateAmount;

    // Ensure minimum fee with proportional scaling
    if (totalFee < minFee && totalFee > BigInt(0)) {
      const scale = (minFee * BigInt(10000)) / totalFee;
      domeAmount = (domeAmount * scale) / BigInt(10000);
      affiliateAmount = minFee - domeAmount;
      totalFee = minFee;
    } else if (totalFee === BigInt(0)) {
      totalFee = minFee;
    }

    return totalFee;
  }

  /**
   * Get performance fee split breakdown
   *
   * Returns detailed breakdown of Dome and affiliate portions of the fee.
   * Useful when you need to know the individual amounts for payment.
   *
   * @param winnings - Total winnings amount in USDC (6 decimals)
   * @param domeFeeBps - Override Dome fee BPS (optional)
   * @param affiliateFeeBps - Override affiliate fee BPS (optional)
   * @returns Fee split with total, dome, and affiliate amounts
   *
   * @example
   * ```typescript
   * const split = router.getPerformanceFeeSplit(1000_000_000n);
   * console.log(split.domeAmount);      // Dome's share
   * console.log(split.affiliateAmount); // Affiliate's share
   * console.log(split.totalFee);        // Total fee
   * ```
   */
  getPerformanceFeeSplit(
    winnings: bigint,
    domeFeeBps?: number,
    affiliateFeeBps?: number
  ): PerformanceFeeSplitResult {
    const dBps = domeFeeBps ?? this.escrowConfig.performanceDomeFeeBps;
    const aBps =
      affiliateFeeBps ?? this.escrowConfig.performanceAffiliateFeeBps;
    const minFee = this.escrowConfig.minPerformanceFeeUsdc;

    let domeAmount = (winnings * BigInt(dBps)) / BigInt(10000);
    let affiliateAmount = (winnings * BigInt(aBps)) / BigInt(10000);
    let totalFee = domeAmount + affiliateAmount;

    // Ensure minimum fee with proportional scaling
    if (totalFee < minFee && totalFee > BigInt(0)) {
      const scale = (minFee * BigInt(10000)) / totalFee;
      domeAmount = (domeAmount * scale) / BigInt(10000);
      affiliateAmount = minFee - domeAmount;
      totalFee = minFee;
    } else if (totalFee === BigInt(0)) {
      domeAmount = minFee;
      affiliateAmount = BigInt(0);
      totalFee = minFee;
    }

    return {
      totalFee,
      domeAmount,
      affiliateAmount,
    };
  }

  // Protected helper methods that need to be accessible

  protected getApiKey(): string | undefined {
    // Access the private apiKey from parent
    // TypeScript doesn't allow direct access, so we use a workaround
    return (this as any).apiKey;
  }

  protected getOrCreateSigner(params: PlaceOrderParams): any {
    const { signer, privyWalletId, walletAddress } = params;
    if (signer) return signer;
    if (privyWalletId && walletAddress) {
      return (this as any).createPrivySignerFromWallet(
        privyWalletId,
        walletAddress
      );
    }
    return undefined;
  }

  protected async createSignedOrder(
    params: PlaceOrderParams,
    creds: PolymarketCredentials
  ): Promise<SignedPolymarketOrder> {
    const {
      marketId,
      side,
      size,
      price,
      walletType = 'eoa',
      funderAddress,
      userId,
      negRisk = false,
    } = params;

    const actualSigner = this.getOrCreateSigner(params);
    const signerAddress = await actualSigner.getAddress();

    // Determine signature type and funder
    let signatureType: number;
    let funder: string;

    if (walletType === 'safe') {
      signatureType = 2;
      funder = funderAddress || this.getSafeAddress(userId) || signerAddress;
    } else {
      signatureType = 0;
      funder = signerAddress;
    }

    // Create ethers adapter
    const ethersAdapter = {
      getAddress: async () => signerAddress,
      _signTypedData: async (domain: any, types: any, value: any) => {
        return await actualSigner.signTypedData({
          domain,
          types,
          primaryType:
            Object.keys(types).find(key => key !== 'EIP712Domain') || '',
          message: value,
        });
      },
    };

    const apiKeyCreds = {
      key: creds.apiKey,
      secret: creds.apiSecret,
      passphrase: creds.apiPassphrase,
    };

    // Import ClobClient dynamically to avoid circular deps
    const { ClobClient } = await import('@polymarket/clob-client');
    const { BuilderConfig } = await import('@polymarket/builder-signing-sdk');

    const builderConfig = new BuilderConfig({
      remoteBuilderConfig: {
        url: 'https://builder-signer.domeapi.io/builder-signer/sign',
      },
    });

    const userClobClient = new ClobClient(
      'https://clob.polymarket.com',
      this.escrowConfig.chainId,
      ethersAdapter as any,
      apiKeyCreds,
      signatureType,
      funder,
      undefined,
      false,
      builderConfig
    );

    const orderSide = side.toLowerCase() === 'buy' ? 'BUY' : 'SELL';

    const signedOrder = await userClobClient.createOrder(
      {
        tokenID: marketId,
        price,
        size,
        side: orderSide as any,
      },
      { negRisk }
    );

    return {
      salt: signedOrder.salt,
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      taker: signedOrder.taker,
      tokenId: signedOrder.tokenId,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      expiration: signedOrder.expiration,
      nonce: signedOrder.nonce,
      feeRateBps: signedOrder.feeRateBps,
      side: orderSide as 'BUY' | 'SELL',
      signatureType: signedOrder.signatureType,
      signature: signedOrder.signature,
    };
  }
}
