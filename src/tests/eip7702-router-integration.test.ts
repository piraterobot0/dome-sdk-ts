/**
 * Integration tests for EIP-7702 detection in PolymarketRouterWithEscrow
 *
 * Tests that the router properly detects and handles EIP-7702 delegated accounts.
 */

import { PolymarketRouterWithEscrow } from '../router/polymarket-escrow';

describe('PolymarketRouterWithEscrow - EIP-7702 Integration', () => {
  describe('Configuration', () => {
    it('should have default EIP-7702 settings', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.checkEIP7702).toBe(true);
      expect(config.blockUnsupportedEIP7702).toBe(false);
    });

    it('should allow disabling EIP-7702 checks', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
          checkEIP7702: false,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.checkEIP7702).toBe(false);
    });

    it('should allow enabling strict mode (block unsupported)', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
          checkEIP7702: true,
          blockUnsupportedEIP7702: true,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.blockUnsupportedEIP7702).toBe(true);
    });

    it('should maintain other escrow settings with EIP-7702 options', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 30,
          affiliateFeeBps: 10,
          affiliate: '0x1111111111111111111111111111111111111111',
          checkEIP7702: true,
          blockUnsupportedEIP7702: false,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(30);
      expect(config.affiliateFeeBps).toBe(10);
      expect(config.affiliate).toBe(
        '0x1111111111111111111111111111111111111111'
      );
    });
  });

  describe('Escrow config structure', () => {
    it('should have complete escrow configuration', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: '0x1234567890123456789012345678901234567890',
          checkEIP7702: true,
          blockUnsupportedEIP7702: false,
        },
      });

      const config = router.getEscrowConfig();

      // Check all required fields exist
      expect(config.domeFeeBps).toBeDefined();
      expect(config.affiliateFeeBps).toBeDefined();
      expect(config.affiliate).toBeDefined();
      expect(config.escrowAddress).toBeDefined();
      expect(config.chainId).toBeDefined();
      expect(config.deadlineSeconds).toBeDefined();
      expect(config.performanceDomeFeeBps).toBeDefined();
      expect(config.performanceAffiliateFeeBps).toBeDefined();
      expect(config.minOrderFeeUsdc).toBeDefined();
      expect(config.minPerformanceFeeUsdc).toBeDefined();
      expect(config.checkEIP7702).toBeDefined();
      expect(config.blockUnsupportedEIP7702).toBeDefined();
    });

    it('should use default values when not provided', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
      });

      const config = router.getEscrowConfig();

      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(0);
      expect(config.chainId).toBe(137);
      expect(config.checkEIP7702).toBe(true);
      expect(config.blockUnsupportedEIP7702).toBe(false);
    });
  });

  describe('Fee calculation with EIP-7702 settings', () => {
    it('should calculate order fees regardless of EIP-7702 settings', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: '0x1234567890123456789012345678901234567890',
          checkEIP7702: true,
          blockUnsupportedEIP7702: true,
        },
      });

      const fee = router.calculateOrderFee(100, 0.5);

      // size * price = 100 * 0.5 = $50
      // total fee = 50 * (20 + 5) / 10000 = 50 * 0.0025 = $0.125
      expect(fee).toBe(125000n); // 125000 USDC atomic units
    });

    it('should calculate performance fees regardless of EIP-7702 settings', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          performanceDomeFeeBps: 100,
          performanceAffiliateFeeBps: 50,
          affiliate: '0x1234567890123456789012345678901234567890',
          checkEIP7702: false,
          blockUnsupportedEIP7702: false,
        },
      });

      const fee = router.calculatePerformanceFee(1000000n); // $1 in USDC

      // fee = 1000000 * (100 + 50) / 10000 = 15000, but bumped to MIN_PERFORMANCE_FEE (100000)
      expect(fee).toBe(100000n);
    });

    it('should get performance fee split', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: 'test-key',
        escrow: {
          performanceDomeFeeBps: 100,
          performanceAffiliateFeeBps: 50,
          affiliate: '0x1234567890123456789012345678901234567890',
          checkEIP7702: true,
        },
      });

      const split = router.getPerformanceFeeSplit(1000000n);

      // Total fee is bumped to minimum (100000)
      expect(split.totalFee).toBe(100000n);
      expect(split.domeAmount).toBeGreaterThan(0n);
      expect(split.affiliateAmount).toBeGreaterThan(0n);
    });
  });

  describe('Static create method with EIP-7702', () => {
    it('should preserve EIP-7702 settings through create method', async () => {
      const router = await PolymarketRouterWithEscrow.create({
        apiKey: 'test-key',
        escrow: {
          domeFeeBps: 20,
          checkEIP7702: true,
          blockUnsupportedEIP7702: true,
        },
      });

      const config = router.getEscrowConfig();
      expect(config.checkEIP7702).toBe(true);
      expect(config.blockUnsupportedEIP7702).toBe(true);
    });
  });
});
