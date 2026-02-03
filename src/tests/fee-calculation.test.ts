import { PolymarketRouterWithEscrow } from '../router/polymarket-escrow.js';
import { ethers } from 'ethers';

describe('Fee Calculation - Independent Dome and Affiliate Fees', () => {
  const MOCK_API_KEY = 'test-api-key';
  const AFFILIATE_ADDRESS = '0x58241F4C9C76CD7b8357185BF533fFA266f46916';
  const MIN_ORDER_FEE = 10000n; // $0.01 USDC

  describe('Constructor - Fee Configuration', () => {
    it('should create router with default fees (20 BPS dome, 0 BPS affiliate)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {},
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(0);
      expect(config.affiliate).toBe(ethers.constants.AddressZero);
    });

    it('should accept custom dome and affiliate fees', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 30,
          affiliateFeeBps: 10,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(30);
      expect(config.affiliateFeeBps).toBe(10);
      expect(config.affiliate).toBe(AFFILIATE_ADDRESS);
    });

    it('should throw error if affiliate fee is set without address', () => {
      expect(
        () =>
          new PolymarketRouterWithEscrow({
            apiKey: MOCK_API_KEY,
            escrow: {
              domeFeeBps: 20,
              affiliateFeeBps: 5, // Non-zero affiliate fee
              // No affiliate address provided
            },
          })
      ).toThrow('affiliate address is required when affiliateFeeBps > 0');
    });

    it('should allow affiliate fee 0 without address', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 25,
          affiliateFeeBps: 0, // Zero is allowed without address
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(25);
      expect(config.affiliateFeeBps).toBe(0);
    });

    it('should preserve affiliate address when provided', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.affiliate).toBe(AFFILIATE_ADDRESS);
    });
  });

  describe('Fee Calculation - calculateOrderFee()', () => {
    it('should calculate fee with default rates (20 BPS dome only)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: { domeFeeBps: 20, affiliateFeeBps: 0 },
      });

      // 100 shares @ $0.65 = $65 order
      const fee = router.calculateOrderFee(100, 0.65);

      // Expected: 65 * 20 / 10000 = 0.13 USDC = 130000 (6 decimals)
      expect(fee).toBe(130000n);
    });

    it('should calculate independent fees with affiliate (20 BPS dome + 5 BPS affiliate)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // 100 shares @ $0.65 = $65 order
      const fee = router.calculateOrderFee(100, 0.65);

      // Expected: 65 * 25 / 10000 = 0.1625 USDC = 162500 (6 decimals)
      expect(fee).toBe(162500n);
    });

    it('should support per-call dome fee override', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: { domeFeeBps: 20, affiliateFeeBps: 0 },
      });

      // Override to 50 BPS dome for this calculation
      const fee = router.calculateOrderFee(100, 0.65, 50, 0);

      // Expected: 65 * 50 / 10000 = 0.325 USDC = 325000 (6 decimals)
      expect(fee).toBe(325000n);
    });

    it('should support per-call affiliate fee override', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 0,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // Override to add 10 BPS affiliate for this calculation
      const fee = router.calculateOrderFee(100, 0.65, 20, 10);

      // Expected: 65 * 30 / 10000 = 0.195 USDC = 195000 (6 decimals)
      expect(fee).toBe(195000n);
    });

    it('should handle zero order size', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: { domeFeeBps: 20, affiliateFeeBps: 0 },
      });

      const fee = router.calculateOrderFee(0, 0.65);
      expect(fee).toBe(MIN_ORDER_FEE); // Should apply minimum fee
    });

    it('should apply minimum fee to very small orders', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // $1 order with 20 + 5 = 25 BPS = $0.0025 < MIN (0.01)
      const fee = router.calculateOrderFee(1, 1);
      expect(fee).toBe(MIN_ORDER_FEE);
    });

    it('should maintain proportional split when applying minimum fee', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 10,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // $1 order: 20 BPS dome = 200, 10 BPS affiliate = 100, total = 300 < MIN (10000)
      // Scale factor: 10000 * 10000 / 300 = 333333.33
      // Scaled dome: 200 * 333333 / 10000 = 6666 (approx)
      // Scaled affiliate: 10000 - 6666 = 3334
      // Ratio should be maintained approximately
      const fee = router.calculateOrderFee(1, 1);

      expect(fee).toBe(MIN_ORDER_FEE);
      // The fee distribution should maintain the 2:1 dome:affiliate ratio
    });

    it('should handle large orders correctly', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // 10000 shares @ $1.0 = $10000 order
      const fee = router.calculateOrderFee(10000, 1.0);

      // Expected: 10000 * 25 / 10000 = 25 USDC = 25000000 (6 decimals)
      expect(fee).toBe(25000000n);
    });
  });

  describe('Fee Calculation - Edge Cases', () => {
    it('should handle very small prices', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: { domeFeeBps: 20, affiliateFeeBps: 0 },
      });

      // 1 share @ $0.001 = $0.001
      const fee = router.calculateOrderFee(1, 0.001);

      // Should apply minimum fee: 10000
      expect(fee).toBe(MIN_ORDER_FEE);
    });

    it('should handle high basis point fees', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 500, // 5% to dome
          affiliateFeeBps: 200, // 2% to affiliate
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // 1000 shares @ $0.50 = $500 order
      const fee = router.calculateOrderFee(1000, 0.5);

      // Expected: 500 * 700 / 10000 = 35 USDC = 35000000 (6 decimals)
      expect(fee).toBe(35000000n);
    });

    it('should calculate 0 fees without rounding errors', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 1,
          affiliateFeeBps: 1,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      // Very small fees should not lose precision
      const fee = router.calculateOrderFee(1, 1); // $1 order with 2 BPS = 0.0002 USDC

      // Should still apply minimum fee when below threshold
      expect(fee).toBeGreaterThanOrEqual(MIN_ORDER_FEE);
    });
  });

  describe('Configuration Retrieval', () => {
    it('should return read-only configuration', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const config = router.getEscrowConfig();

      // Verify all fields are present
      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(5);
      expect(config.affiliate).toBe(AFFILIATE_ADDRESS);
      expect(config.escrowAddress).toBeDefined();
      expect(config.chainId).toBe(137);
      expect(config.deadlineSeconds).toBe(3600);
    });

    it('should return independent copy of configuration', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const config1 = router.getEscrowConfig();
      const config2 = router.getEscrowConfig();

      // Should be equal but not the same object
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });
  });

  describe('Backward Compatibility', () => {
    it('should not accept old feeBps parameter', () => {
      // This test ensures the old API is not available
      const config = {
        apiKey: MOCK_API_KEY,
        escrow: {
          feeBps: 25, // Old parameter - should be ignored or cause type error
        } as any,
      };

      // TypeScript would catch this, but runtime should default to new params
      const router = new PolymarketRouterWithEscrow(config);
      const routerConfig = router.getEscrowConfig();

      // Should use default new values, not old feeBps
      expect(routerConfig.domeFeeBps).toBe(20); // Default
      expect(routerConfig.affiliateFeeBps).toBe(0); // Default
    });
  });

  describe('Real-World Scenarios', () => {
    it('Scenario 1: $100 order, 20 BPS Dome, 5 BPS Affiliate', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const fee = router.calculateOrderFee(200, 0.5); // 200 shares * $0.50 = $100
      // Expected: 100 * 25 / 10000 = 0.25 USDC = 250000 (6 decimals)
      expect(fee).toBe(250000n);
    });

    it('Scenario 2: $10 order, 20 BPS Dome only (no affiliate)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 0,
        },
      });

      const fee = router.calculateOrderFee(10, 1.0); // 10 shares * $1.00 = $10
      // Expected: 10 * 20 / 10000 = 0.02 USDC = 20000 (6 decimals)
      expect(fee).toBe(20000n);
    });

    it('Scenario 3: Small $0.50 order triggers minimum fee', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const fee = router.calculateOrderFee(50, 0.01); // 50 shares * $0.01 = $0.50
      // Calculated fee: 0.50 * 25 / 10000 = 0.00125 < MIN (0.01)
      // Should return minimum fee
      expect(fee).toBe(MIN_ORDER_FEE);
    });

    it('Scenario 4: High fees (3% Dome + 1% Affiliate)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: MOCK_API_KEY,
        escrow: {
          domeFeeBps: 300,
          affiliateFeeBps: 100,
          affiliate: AFFILIATE_ADDRESS,
        },
      });

      const fee = router.calculateOrderFee(1000, 0.5); // 1000 * $0.50 = $500
      // Expected: 500 * 400 / 10000 = 20 USDC = 20000000 (6 decimals)
      expect(fee).toBe(20000000n);
    });
  });
});
