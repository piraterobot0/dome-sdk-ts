/**
 * Router Server Configuration Tests
 *
 * Tests the PolymarketRouterWithEscrow.create() static factory method
 * and performance fee helpers.
 */

import { PolymarketRouterWithEscrow } from '../router/polymarket-escrow.js';
import {
  clearConfigCache,
  type ServerFeeResponse,
} from '../escrow/fee-config-fetcher.js';
import { ethers } from 'ethers';

// Mock fetch globally
const originalFetch = global.fetch;

describe('Router: Server Fee Configuration', () => {
  const DOME_API_KEY = 'test-dome-api-key';
  const MIN_ORDER_FEE = 10000n;
  const MIN_PERFORMANCE_FEE = 100000n;

  beforeEach(() => {
    clearConfigCache();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('static create() method', () => {
    it('should create router with server-fetched config', async () => {
      const mockResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 25, // Total 25 BPS
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 500, // Total 500 BPS (5%)
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            name: 'Test Affiliate',
            orderFeeSplitBps: 2000, // 20% to affiliate
            performanceFeeSplitBps: 2000, // 20% to affiliate
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 137,
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const router = await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
        fetchConfigFromServer: true,
        configCacheTTL: 0, // Disable caching for test
      });

      const config = router.getEscrowConfig();

      // Verify order fee conversion: 25 BPS total, 20% to affiliate
      // Affiliate: 25 * 0.20 = 5 BPS
      // Dome: 25 - 5 = 20 BPS
      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(5);
      expect(config.affiliate).toBe(
        '0x1234567890123456789012345678901234567890'
      );

      // Verify performance fee conversion: 500 BPS total, 20% to affiliate
      // Affiliate: 500 * 0.20 = 100 BPS (1%)
      // Dome: 500 - 100 = 400 BPS (4%)
      expect(config.performanceDomeFeeBps).toBe(400);
      expect(config.performanceAffiliateFeeBps).toBe(100);

      expect(config.escrowAddress).toBe(
        '0xEscrowAddress12345678901234567890123456'
      );
      expect(config.chainId).toBe(137);
    });

    it('should create router with local config when fetchConfigFromServer is false', async () => {
      global.fetch = jest.fn();

      const router = await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
        fetchConfigFromServer: false,
        escrow: {
          domeFeeBps: 15,
          affiliateFeeBps: 3,
          affiliate: '0xAffiliateAddress123456789012345678901234',
        },
      });

      const config = router.getEscrowConfig();

      expect(config.domeFeeBps).toBe(15);
      expect(config.affiliateFeeBps).toBe(3);
      expect(config.affiliate).toBe(
        '0xAffiliateAddress123456789012345678901234'
      );

      // Fetch should not be called
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should use default local config when fetchConfigFromServer is not specified', async () => {
      global.fetch = jest.fn();

      const router = await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
      });

      const config = router.getEscrowConfig();

      // Default values
      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(0);
      expect(config.affiliate).toBe(ethers.constants.AddressZero);

      // Fetch should not be called
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should throw error when fetchConfigFromServer is true but no apiKey', async () => {
      await expect(
        PolymarketRouterWithEscrow.create({
          fetchConfigFromServer: true,
        })
      ).rejects.toThrow(
        'apiKey is required when fetchConfigFromServer is true'
      );
    });

    it('should propagate fetch errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      });

      await expect(
        PolymarketRouterWithEscrow.create({
          apiKey: DOME_API_KEY,
          fetchConfigFromServer: true,
          configCacheTTL: 0,
        })
      ).rejects.toThrow('Failed to fetch fee configuration: 401 Unauthorized');
    });

    it('should use custom cache TTL', async () => {
      const mockResponse: ServerFeeResponse = {
        result: {
          orderFee: { enabled: true, feeBps: 10, minFeeUsdc: '10000' },
          performanceFee: { enabled: true, feeBps: 100, minFeeUsdc: '100000' },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 0,
            performanceFeeSplitBps: 0,
          },
          domeAddress: '0xDome',
          escrowAddress: '0xEscrow',
          chainId: 137,
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // First creation
      await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
        fetchConfigFromServer: true,
        configCacheTTL: 300000, // Enable caching
      });

      // Second creation should use cache
      await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
        fetchConfigFromServer: true,
        configCacheTTL: 300000,
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('performance fee helpers', () => {
    describe('calculatePerformanceFee', () => {
      it('should calculate performance fee with configured rates', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            affiliateFeeBps: 5,
            affiliate: '0x1234567890123456789012345678901234567890',
            performanceDomeFeeBps: 400, // 4%
            performanceAffiliateFeeBps: 100, // 1%
          },
        });

        // $1000 winnings (1000 * 10^6)
        const winnings = 1000_000_000n;
        const fee = router.calculatePerformanceFee(winnings);

        // Expected: 1000 * 500 / 10000 = 50 USDC = 50_000_000 (6 decimals)
        expect(fee).toBe(50_000_000n);
      });

      it('should use order fee rates as default for performance fees', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 30,
            affiliateFeeBps: 10,
            affiliate: '0x1234567890123456789012345678901234567890',
            // performanceDomeFeeBps not set - should default to domeFeeBps
            // performanceAffiliateFeeBps not set - should default to affiliateFeeBps
          },
        });

        const config = router.getEscrowConfig();
        expect(config.performanceDomeFeeBps).toBe(30);
        expect(config.performanceAffiliateFeeBps).toBe(10);

        // $100 winnings
        const winnings = 100_000_000n;
        const fee = router.calculatePerformanceFee(winnings);

        // Expected: 100 * 40 / 10000 = 0.4 USDC = 400_000 (6 decimals)
        expect(fee).toBe(400_000n);
      });

      it('should allow per-call fee override', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            performanceDomeFeeBps: 400,
            performanceAffiliateFeeBps: 100,
          },
        });

        const winnings = 1000_000_000n;

        // Override with lower rates: 2% dome + 0.5% affiliate = 2.5%
        const fee = router.calculatePerformanceFee(winnings, 200, 50);

        // Expected: 1000 * 250 / 10000 = 25 USDC = 25_000_000 (6 decimals)
        expect(fee).toBe(25_000_000n);
      });

      it('should apply minimum performance fee', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            performanceDomeFeeBps: 100, // 1%
            performanceAffiliateFeeBps: 0,
          },
        });

        // $1 winnings - calculated fee would be $0.01 which is < MIN_PERFORMANCE_FEE ($0.10)
        const winnings = 1_000_000n;
        const fee = router.calculatePerformanceFee(winnings);

        // Should apply minimum fee
        expect(fee).toBe(MIN_PERFORMANCE_FEE);
      });

      it('should handle zero winnings', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            performanceDomeFeeBps: 400,
            performanceAffiliateFeeBps: 100,
          },
        });

        const fee = router.calculatePerformanceFee(0n);

        // Minimum fee should be applied
        expect(fee).toBe(MIN_PERFORMANCE_FEE);
      });
    });

    describe('getPerformanceFeeSplit', () => {
      it('should return fee breakdown with dome and affiliate amounts', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            affiliateFeeBps: 5,
            affiliate: '0x1234567890123456789012345678901234567890',
            performanceDomeFeeBps: 400, // 4%
            performanceAffiliateFeeBps: 100, // 1%
          },
        });

        // $1000 winnings
        const winnings = 1000_000_000n;
        const split = router.getPerformanceFeeSplit(winnings);

        // Dome: 1000 * 400 / 10000 = 40 USDC
        expect(split.domeAmount).toBe(40_000_000n);

        // Affiliate: 1000 * 100 / 10000 = 10 USDC
        expect(split.affiliateAmount).toBe(10_000_000n);

        // Total: 50 USDC
        expect(split.totalFee).toBe(50_000_000n);

        // Verify split adds up
        expect(split.domeAmount + split.affiliateAmount).toBe(split.totalFee);
      });

      it('should allow per-call fee override', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            performanceDomeFeeBps: 400,
            performanceAffiliateFeeBps: 100,
          },
        });

        const winnings = 1000_000_000n;

        // Override: 3% dome + 2% affiliate = 5%
        const split = router.getPerformanceFeeSplit(winnings, 300, 200);

        expect(split.domeAmount).toBe(30_000_000n);
        expect(split.affiliateAmount).toBe(20_000_000n);
        expect(split.totalFee).toBe(50_000_000n);
      });

      it('should apply minimum fee with proportional scaling', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 20,
            affiliateFeeBps: 5,
            affiliate: '0x1234567890123456789012345678901234567890',
            performanceDomeFeeBps: 100, // 1%
            performanceAffiliateFeeBps: 25, // 0.25%
          },
        });

        // $1 winnings - very small, should trigger minimum
        // Calculated: 1 * 125 / 10000 = 0.0125 USDC < MIN_PERFORMANCE_FEE
        const winnings = 1_000_000n;
        const split = router.getPerformanceFeeSplit(winnings);

        // Should apply minimum fee
        expect(split.totalFee).toBe(MIN_PERFORMANCE_FEE);

        // Verify split adds up to minimum
        expect(split.domeAmount + split.affiliateAmount).toBe(
          MIN_PERFORMANCE_FEE
        );
      });

      it('should assign all to dome when both rates are zero', () => {
        const router = new PolymarketRouterWithEscrow({
          apiKey: DOME_API_KEY,
          escrow: {
            domeFeeBps: 0,
            affiliateFeeBps: 0,
            performanceDomeFeeBps: 0,
            performanceAffiliateFeeBps: 0,
          },
        });

        const winnings = 1000_000_000n;
        const split = router.getPerformanceFeeSplit(winnings);

        // Minimum fee should go entirely to dome
        expect(split.totalFee).toBe(MIN_PERFORMANCE_FEE);
        expect(split.domeAmount).toBe(MIN_PERFORMANCE_FEE);
        expect(split.affiliateAmount).toBe(0n);
      });
    });
  });

  describe('backward compatibility', () => {
    it('should work with existing constructor pattern', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: '0x1234567890123456789012345678901234567890',
        },
      });

      const config = router.getEscrowConfig();

      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(5);
      expect(config.affiliate).toBe(
        '0x1234567890123456789012345678901234567890'
      );
    });

    it('should work without any escrow config', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
      });

      const config = router.getEscrowConfig();

      expect(config.domeFeeBps).toBe(20);
      expect(config.affiliateFeeBps).toBe(0);
    });

    it('should still calculate order fees correctly', () => {
      const router = new PolymarketRouterWithEscrow({
        apiKey: DOME_API_KEY,
        escrow: {
          domeFeeBps: 20,
          affiliateFeeBps: 5,
          affiliate: '0x1234567890123456789012345678901234567890',
        },
      });

      // $100 order
      const fee = router.calculateOrderFee(200, 0.5);

      // Expected: 100 * 25 / 10000 = 0.25 USDC = 250000 (6 decimals)
      expect(fee).toBe(250000n);
    });

    it('should throw when affiliate fee is set without address', () => {
      expect(
        () =>
          new PolymarketRouterWithEscrow({
            apiKey: DOME_API_KEY,
            escrow: {
              domeFeeBps: 20,
              affiliateFeeBps: 5,
              // No affiliate address
            },
          })
      ).toThrow('affiliate address is required when affiliateFeeBps > 0');
    });
  });

  describe('integration: server-fetched config with fee calculation', () => {
    it('should calculate correct fees after fetching server config', async () => {
      const mockResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 10, // Total 10 BPS
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 500, // Total 500 BPS (5%)
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 0, // No affiliate split
            performanceFeeSplitBps: 2000, // 20% to affiliate for perf fee
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 137,
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const router = await PolymarketRouterWithEscrow.create({
        apiKey: DOME_API_KEY,
        fetchConfigFromServer: true,
        configCacheTTL: 0,
      });

      // Order fee: 10 BPS to dome, 0 to affiliate
      const config = router.getEscrowConfig();
      expect(config.domeFeeBps).toBe(10);
      expect(config.affiliateFeeBps).toBe(0);

      // $100 order fee
      const orderFee = router.calculateOrderFee(200, 0.5);
      expect(orderFee).toBe(100_000n); // 100 * 10 / 10000 = 0.10 USDC

      // Performance fee: 400 BPS to dome, 100 BPS to affiliate
      expect(config.performanceDomeFeeBps).toBe(400);
      expect(config.performanceAffiliateFeeBps).toBe(100);

      // $1000 performance fee
      const perfFee = router.calculatePerformanceFee(1000_000_000n);
      expect(perfFee).toBe(50_000_000n); // 1000 * 500 / 10000 = 50 USDC

      const perfSplit = router.getPerformanceFeeSplit(1000_000_000n);
      expect(perfSplit.domeAmount).toBe(40_000_000n); // 1000 * 400 / 10000 = 40 USDC
      expect(perfSplit.affiliateAmount).toBe(10_000_000n); // 1000 * 100 / 10000 = 10 USDC
    });
  });
});
