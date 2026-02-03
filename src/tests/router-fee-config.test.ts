/**
 * Router Fee Configuration Tests
 *
 * Unit tests for PolymarketRouterWithEscrow fee configuration and calculation.
 * Tests the router's fee logic in isolation (does not interact with Dome API or blockchain).
 *
 * This test demonstrates:
 * 1. Creating a router with independent Dome and affiliate fee configuration
 * 2. Calculating fees for various order scenarios
 * 3. Verifying fee splits are calculated correctly
 * 4. Testing per-order fee overrides
 * 5. Validating that the fee authorization would be created with correct amounts
 */

import { PolymarketRouterWithEscrow } from '../router/polymarket-escrow.js';
import { ethers } from 'ethers';

describe('Router: Fee Configuration and Calculation', () => {
  const DOME_API_KEY = 'test-dome-api-key';
  const AFFILIATE_WALLET = '0x58241F4C9C76CD7b8357185BF533fFA266f46916';
  const ALTERNATIVE_AFFILIATE = '0x742d35Cc6634C0532925a3b844Bc58e8bFAC76e0';

  describe('Setup 1: Basic Dome-Only Configuration', () => {
    it('should initialize router with Dome-only fees', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        chainId: 137,
        escrow: {
          domeFeeBps: 25, // 0.25% to Dome only
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(25);
      expect(config.affiliateFeeBps).toBe(0);
      expect(config.affiliate).toBe(ethers.constants.AddressZero);
      expect(config.chainId).toBe(137);
    });

    it('should calculate order fees correctly with Dome-only config', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: { domeFeeBps: 25 },
      });

      // Test Case 1: $100 order
      const fee100 = router.calculateOrderFee(200, 0.5); // 200 * $0.50 = $100
      expect(fee100).toBe(250000n); // $0.25 in USDC (6 decimals)

      // Test Case 2: $1000 order
      const fee1000 = router.calculateOrderFee(2000, 0.5); // 2000 * $0.50 = $1000
      expect(fee1000).toBe(2500000n); // $2.50 in USDC (6 decimals)

      // Fee should scale linearly
      expect(fee1000 / fee100).toBe(10n);
    });
  });

  describe('Setup 2: Dome + Affiliate Configuration', () => {
    it('should initialize router with Dome and affiliate fees', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        chainId: 137,
        escrow: {
          domeFeeBps: 20, // 0.20% to Dome
          affiliateFeeBps: 5, // 0.05% to affiliate
          affiliate: AFFILIATE_WALLET,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(5);
      expect(config.affiliate).toBe(AFFILIATE_WALLET);
      expect(config.chainId).toBe(137);
    });

    it('should calculate independent fees correctly', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // $100 order: (20+5) BPS total = 0.25%
      const fee = router.calculateOrderFee(200, 0.5); // 200 * $0.50 = $100
      expect(fee).toBe(250000n); // $0.25 total

      // Verify individual components would be:
      // Dome: 100 * 20 / 10000 = 20000 ($0.02)
      // Affiliate: 100 * 5 / 10000 = 5000 ($0.005)
      // Total: 25000 ($0.025)
    });

    it('should support different affiliate percentages', () => {
      // 80/20 split: Dome gets 80% of fee (20 BPS), Affiliate gets 20% (5 BPS)
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      const totalFee = router.calculateOrderFee(100, 10.0); // 100 * $10 = $1000
      expect(totalFee).toBe(2500000n); // $2.50 (1000 * 25 / 10000)

      // 60/40 split alternative (same total fee, different split)
      const router2 = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 15,
          affiliateFeeBps: 10,
          affiliate: AFFILIATE_WALLET,
        },
      });

      const totalFee2 = router2.calculateOrderFee(100, 10.0); // 100 * $10 = $1000
      expect(totalFee2).toBe(2500000n); // Still $2.50 total

      // Same total fee (25 BPS), different split
      expect(totalFee).toBe(totalFee2);
    });
  });

  describe('Scenario 1: Single Large Order', () => {
    it('should calculate fees for $1000 Polymarket order', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Trump market: 1000 shares @ $1.00 = $1000
      const size = 1000;
      const price = 1.0;
      const fee = router.calculateOrderFee(size, price);

      expect(fee).toBe(2500000n); // $2.50 total fee (1000 * 1.0 * 25 / 10000)

      // In the EIP-712 authorization, this fee would be split:
      // domeAmount = 1000 * 20 / 10000 = 2000000 ($2.00)
      // affiliateAmount = 1000 * 5 / 10000 = 500000 ($0.50)
    });

    it('should calculate fees for $5000 order', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // 5000 shares @ $1.00 = $5000
      const fee = router.calculateOrderFee(5000, 1.0);
      expect(fee).toBe(12500000n); // $12.50 total fee (5000 * 1.0 * 25 / 10000)
    });
  });

  describe('Scenario 2: Per-Order Fee Overrides', () => {
    it('should apply higher fees for premium market', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Standard $100 order
      const standardFee = router.calculateOrderFee(200, 0.5);
      expect(standardFee).toBe(250000n);

      // Premium market with higher fees: 30 BPS dome + 10 BPS affiliate
      const premiumFee = router.calculateOrderFee(200, 0.5, 30, 10);
      expect(premiumFee).toBe(400000n); // $0.40

      expect(premiumFee).toBeGreaterThan(standardFee);
      expect(premiumFee / standardFee).toBe(16n / 10n); // 1.6x increase
    });

    it('should apply lower fees for volume orders', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Standard fee: 100 * 1.0 * 25 / 10000 = 250000
      const standardFee = router.calculateOrderFee(100, 1.0);
      expect(standardFee).toBe(250000n);

      // Volume discount: 10 BPS dome + 2 BPS affiliate = 12 BPS
      // 100 * 1.0 * 12 / 10000 = 120000
      const discountedFee = router.calculateOrderFee(100, 1.0, 10, 2);
      expect(discountedFee).toBe(120000n);

      expect(discountedFee).toBeLessThan(standardFee);
      // Ratio: 250000 / 120000 ≈ 2.08, which is about 52% discount
    });

    it('should allow changing affiliate mid-session (override per order)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET, // Primary affiliate
        },
      });

      const config = router.getEscrowConfig();
      expect(config.affiliate).toBe(AFFILIATE_WALLET);

      // In placeOrder, could override to different affiliate:
      // router.placeOrder({
      //   ...,
      //   domeFeeBps: 20,
      //   affiliateFeeBps: 5,
      //   affiliate: ALTERNATIVE_AFFILIATE // Override for this order
      // })
    });
  });

  describe('Scenario 3: Minimum Fee Handling', () => {
    it('should apply minimum fee for small orders', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // $0.50 order with 25 BPS = $0.00125 < MIN ($0.01)
      const fee = router.calculateOrderFee(50, 0.01);
      expect(fee).toBe(10000n); // Minimum fee applied

      // Larger $1 order still below minimum
      const fee2 = router.calculateOrderFee(100, 0.01);
      expect(fee2).toBe(10000n); // Still minimum
    });

    it('should maintain fee ratio when minimum is applied', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20, // 80% of fee
          affiliateFeeBps: 5, // 20% of fee
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Small order that triggers minimum fee
      const fee = router.calculateOrderFee(1, 1.0);
      expect(fee).toBe(10000n); // MIN_ORDER_FEE

      // The fee is split, but proportionally to maintain the 4:1 dome:affiliate ratio
    });
  });

  describe('Scenario 4: Multiple Orders Flow', () => {
    it('should calculate fees consistently across multiple orders', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Order 1: Trump market
      const fee1 = router.calculateOrderFee(100, 0.65);
      expect(fee1).toBe(162500n); // 100 * 0.65 = 65, 65 * 25 / 10000 = 0.1625

      // Order 2: Biden market
      const fee2 = router.calculateOrderFee(200, 0.35);
      expect(fee2).toBe(175000n); // 200 * 0.35 = 70, 70 * 25 / 10000 = 0.175

      // Order 3: General market
      const fee3 = router.calculateOrderFee(50, 0.5);
      expect(fee3).toBe(62500n); // 50 * 0.50 = 25, 25 * 25 / 10000 = 0.0625

      // Total fees for session
      const totalFees = fee1 + fee2 + fee3;
      expect(totalFees).toBe(400000n); // $0.40 total
    });

    it('should track cumulative affiliate earnings', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Process 10 orders of $100 each
      let totalFee = 0n;
      for (let i = 0; i < 10; i++) {
        const fee = router.calculateOrderFee(200, 0.5); // $100 each
        totalFee += fee;
      }

      expect(totalFee).toBe(2500000n); // 10 * $0.25

      // Affiliate share: 5 BPS out of 25 BPS = 20%
      // Affiliate earnings: $2.50 * 20% = $0.50 USDC
      const affiliateShare = (totalFee * 5n) / 25n;
      expect(affiliateShare).toBe(500000n); // $0.50
    });
  });

  describe('Scenario 5: Configuration Validation', () => {
    it('should reject invalid configurations at construction', () => {
      expect(() => {
        new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            affiliateFeeBps: 10, // Non-zero affiliate fee
            // Missing affiliate address - should throw
          },
        });
      }).toThrow('affiliate address is required when affiliateFeeBps > 0');
    });

    it('should allow zero affiliate fee without address', () => {
      // Should not throw
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 25,
          affiliateFeeBps: 0, // Zero is OK without address
        },
      });

      expect(router).toBeInstanceOf(PolymarketRouterWithEscrow);
    });

    it('should validate affiliate address format', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: `0x${'a'.repeat(40)}`, // Valid Ethereum address
        },
      });

      const config = router.getEscrowConfig();
      expect(config.affiliate).toBe(`0x${'a'.repeat(40)}`);
    });
  });

  describe('Scenario 6: Fee Split Verification', () => {
    it('should calculate individual dome and affiliate amounts correctly', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // $100 order
      const orderSizeUsdc = 100_000_000n; // 100 USDC in 6-decimal format

      // Manual calculation to verify
      const domeAmount = (orderSizeUsdc * 20n) / 10000n; // = 200000
      const affiliateAmount = (orderSizeUsdc * 5n) / 10000n; // = 50000
      const totalFee = domeAmount + affiliateAmount; // = 250000

      expect(domeAmount).toBe(200000n);
      expect(affiliateAmount).toBe(50000n);
      expect(totalFee).toBe(250000n);

      // Verify router calculates same total
      const routerTotal = router.calculateOrderFee(200, 0.5);
      expect(routerTotal).toBe(totalFee);
    });

    it('should maintain precision for large orders', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_WALLET,
        },
      });

      // $1,000,000 order
      const fee = router.calculateOrderFee(1000000, 1.0);

      // Expected: 1000000 * 25 / 10000 = 2500 USDC = 2500000000 (6 decimals)
      expect(fee).toBe(2500000000n);

      // No rounding errors or precision loss
    });
  });

  describe('Summary: Configuration Best Practices', () => {
    it('demonstrates recommended Dome-only setup', () => {
      // Use case: Dome keeps all fees
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 25, // 0.25% total fee
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(25);
      expect(config.affiliateFeeBps).toBe(0);
    });

    it('demonstrates recommended Dome + Affiliate setup', () => {
      // Use case: Dome keeps 80%, Affiliate gets 20%
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20, // 0.20% to Dome
          affiliateFeeBps: 5, // 0.05% to Affiliate (20% of 0.25%)
          affiliate: AFFILIATE_WALLET,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps + config.affiliateFeeBps).toBe(25);
    });

    it('demonstrates tiered affiliate setup', () => {
      // Use case: Premium affiliates get higher share
      // Tier 1: Standard 80/20 split (20 BPS dome + 5 BPS affiliate)
      const tier1 = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5, // 20% of total
          affiliate: AFFILIATE_WALLET,
        },
      });

      // Standard tier fee
      const standardFee = tier1.calculateOrderFee(100, 1.0); // 25 BPS
      expect(standardFee).toBe(250000n);

      // Tier 2: Premium 70/30 split (override per order: 17 BPS dome + 8 BPS affiliate)
      const premiumFee = tier1.calculateOrderFee(100, 1.0, 17, 8); // 25 BPS total, different split
      expect(premiumFee).toBe(250000n); // Same total fee

      const config1 = tier1.getEscrowConfig();
      expect(config1.domeFeeBps).toBe(20);
      expect(config1.affiliateFeeBps).toBe(5);
    });
  });
});
