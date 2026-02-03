/**
 * Fee Config Fetcher Unit Tests
 *
 * Tests the fee configuration fetching, format conversion, and caching logic.
 */

import {
  convertServerConfigToSDK,
  clearConfigCache,
  hasCachedConfig,
  fetchFeeConfig,
  type ServerFeeResponse,
} from '../escrow/fee-config-fetcher.js';

// Mock fetch globally
const originalFetch = global.fetch;

describe('Fee Config Fetcher', () => {
  beforeEach(() => {
    clearConfigCache();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('convertServerConfigToSDK', () => {
    it('should convert server split format to SDK independent format', () => {
      const serverResponse: ServerFeeResponse = {
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

      const sdkConfig = convertServerConfigToSDK(serverResponse);

      // Order fee: 25 BPS total, 20% to affiliate
      // Affiliate: 25 * 0.20 = 5 BPS
      // Dome: 25 - 5 = 20 BPS
      expect(sdkConfig.orderFee.enabled).toBe(true);
      expect(sdkConfig.orderFee.domeFeeBps).toBe(20);
      expect(sdkConfig.orderFee.affiliateFeeBps).toBe(5);
      expect(sdkConfig.orderFee.minFeeUsdc).toBe(10000n);

      // Performance fee: 500 BPS total, 20% to affiliate
      // Affiliate: 500 * 0.20 = 100 BPS (1%)
      // Dome: 500 - 100 = 400 BPS (4%)
      expect(sdkConfig.performanceFee.enabled).toBe(true);
      expect(sdkConfig.performanceFee.domeFeeBps).toBe(400);
      expect(sdkConfig.performanceFee.affiliateFeeBps).toBe(100);
      expect(sdkConfig.performanceFee.minFeeUsdc).toBe(100000n);

      expect(sdkConfig.affiliate.address).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect(sdkConfig.affiliate.name).toBe('Test Affiliate');
      expect(sdkConfig.domeAddress).toBe(
        '0xDomeAddress1234567890123456789012345678'
      );
      expect(sdkConfig.escrowAddress).toBe(
        '0xEscrowAddress12345678901234567890123456'
      );
      expect(sdkConfig.chainId).toBe(137);
    });

    it('should handle zero affiliate split', () => {
      const serverResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 10,
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: false,
            feeBps: 0,
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x0000000000000000000000000000000000000000',
            orderFeeSplitBps: 0, // No affiliate
            performanceFeeSplitBps: 0,
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 137,
        },
      };

      const sdkConfig = convertServerConfigToSDK(serverResponse);

      // All fees go to Dome
      expect(sdkConfig.orderFee.domeFeeBps).toBe(10);
      expect(sdkConfig.orderFee.affiliateFeeBps).toBe(0);
      expect(sdkConfig.performanceFee.domeFeeBps).toBe(0);
      expect(sdkConfig.performanceFee.affiliateFeeBps).toBe(0);
    });

    it('should handle 50/50 split correctly', () => {
      const serverResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 30, // Total 30 BPS
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 1000, // Total 1000 BPS (10%)
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 5000, // 50% to affiliate
            performanceFeeSplitBps: 5000, // 50% to affiliate
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 137,
        },
      };

      const sdkConfig = convertServerConfigToSDK(serverResponse);

      // Order fee: 30 BPS total, 50% each
      expect(sdkConfig.orderFee.domeFeeBps).toBe(15);
      expect(sdkConfig.orderFee.affiliateFeeBps).toBe(15);

      // Performance fee: 1000 BPS total, 50% each
      expect(sdkConfig.performanceFee.domeFeeBps).toBe(500);
      expect(sdkConfig.performanceFee.affiliateFeeBps).toBe(500);
    });

    it('should round fractional BPS correctly', () => {
      const serverResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 17, // Total 17 BPS
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 333, // Total 333 BPS
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 3333, // 33.33% to affiliate
            performanceFeeSplitBps: 3333,
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 137,
        },
      };

      const sdkConfig = convertServerConfigToSDK(serverResponse);

      // Order fee: 17 * 0.3333 = 5.666 -> rounded to 6
      // Dome: 17 - 6 = 11
      expect(sdkConfig.orderFee.affiliateFeeBps).toBe(6);
      expect(sdkConfig.orderFee.domeFeeBps).toBe(11);

      // Performance fee: 333 * 0.3333 = 111 -> rounded
      expect(sdkConfig.performanceFee.affiliateFeeBps).toBe(111);
      expect(sdkConfig.performanceFee.domeFeeBps).toBe(222);
    });

    it('should handle Amoy testnet chain ID', () => {
      const serverResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 10,
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 100,
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 0,
            performanceFeeSplitBps: 0,
          },
          domeAddress: '0xDomeAddress1234567890123456789012345678',
          escrowAddress: '0xEscrowAddress12345678901234567890123456',
          chainId: 80002, // Amoy testnet
        },
      };

      const sdkConfig = convertServerConfigToSDK(serverResponse);

      expect(sdkConfig.chainId).toBe(80002);
    });
  });

  describe('fetchFeeConfig', () => {
    it('should fetch and convert config from server', async () => {
      const mockResponse: ServerFeeResponse = {
        result: {
          orderFee: {
            enabled: true,
            feeBps: 10,
            minFeeUsdc: '10000',
          },
          performanceFee: {
            enabled: true,
            feeBps: 500,
            minFeeUsdc: '100000',
          },
          affiliate: {
            address: '0x1234567890123456789012345678901234567890',
            orderFeeSplitBps: 0,
            performanceFeeSplitBps: 0,
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

      const config = await fetchFeeConfig({
        apiKey: 'test-api-key',
        cacheTTL: 0, // Disable caching for this test
      });

      expect(config.orderFee.domeFeeBps).toBe(10);
      expect(config.orderFee.affiliateFeeBps).toBe(0);
      expect(config.performanceFee.domeFeeBps).toBe(500);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.domeapi.io/v1/fees',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should use custom API endpoint', async () => {
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

      await fetchFeeConfig({
        apiKey: 'test-api-key',
        apiEndpoint: 'https://custom.api.io/v2',
        cacheTTL: 0,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom.api.io/v2/fees',
        expect.anything()
      );
    });

    it('should throw error on HTTP failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      });

      await expect(
        fetchFeeConfig({
          apiKey: 'bad-api-key',
          cacheTTL: 0,
        })
      ).rejects.toThrow(
        'Failed to fetch fee configuration: 401 Unauthorized - Invalid API key'
      );
    });

    it('should throw error on invalid response structure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }), // Missing result
      });

      await expect(
        fetchFeeConfig({
          apiKey: 'test-api-key',
          cacheTTL: 0,
        })
      ).rejects.toThrow(
        'Invalid fee configuration response: missing result field'
      );
    });

    it('should throw error on missing required fields', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { orderFee: {} } }), // Missing fields
      });

      await expect(
        fetchFeeConfig({
          apiKey: 'test-api-key',
          cacheTTL: 0,
        })
      ).rejects.toThrow('Invalid orderFee.enabled: expected boolean');
    });

    it('should throw error on invalid minFeeUsdc format', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              orderFee: { enabled: true, feeBps: 10, minFeeUsdc: 'invalid' },
              performanceFee: {
                enabled: true,
                feeBps: 100,
                minFeeUsdc: '100000',
              },
              affiliate: {
                address: '0x1234567890123456789012345678901234567890',
                orderFeeSplitBps: 0,
                performanceFeeSplitBps: 0,
              },
              domeAddress: '0xDome',
              escrowAddress: '0xEscrow',
              chainId: 137,
            },
          }),
      });

      await expect(
        fetchFeeConfig({
          apiKey: 'test-api-key',
          cacheTTL: 0,
        })
      ).rejects.toThrow('Invalid orderFee.minFeeUsdc');
    });

    it('should throw error on invalid affiliate split BPS', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              orderFee: { enabled: true, feeBps: 10, minFeeUsdc: '10000' },
              performanceFee: {
                enabled: true,
                feeBps: 100,
                minFeeUsdc: '100000',
              },
              affiliate: {
                address: '0x1234567890123456789012345678901234567890',
                orderFeeSplitBps: 15000, // > 10000 is invalid
                performanceFeeSplitBps: 0,
              },
              domeAddress: '0xDome',
              escrowAddress: '0xEscrow',
              chainId: 137,
            },
          }),
      });

      await expect(
        fetchFeeConfig({
          apiKey: 'test-api-key',
          cacheTTL: 0,
        })
      ).rejects.toThrow('Invalid affiliate.orderFeeSplitBps');
    });
  });

  describe('caching', () => {
    it('should cache results and return cached value', async () => {
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

      // First call should fetch
      const config1 = await fetchFeeConfig({
        apiKey: 'test-api-key',
        cacheTTL: 300000, // 5 minutes
      });

      // Second call should use cache
      const config2 = await fetchFeeConfig({
        apiKey: 'test-api-key',
        cacheTTL: 300000,
      });

      expect(config1).toEqual(config2);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should use separate cache per API key', async () => {
      const mockResponse1: ServerFeeResponse = {
        result: {
          orderFee: { enabled: true, feeBps: 10, minFeeUsdc: '10000' },
          performanceFee: { enabled: true, feeBps: 100, minFeeUsdc: '100000' },
          affiliate: {
            address: '0x1111111111111111111111111111111111111111',
            orderFeeSplitBps: 0,
            performanceFeeSplitBps: 0,
          },
          domeAddress: '0xDome1',
          escrowAddress: '0xEscrow1',
          chainId: 137,
        },
      };

      const mockResponse2: ServerFeeResponse = {
        result: {
          orderFee: { enabled: true, feeBps: 20, minFeeUsdc: '10000' },
          performanceFee: { enabled: true, feeBps: 200, minFeeUsdc: '100000' },
          affiliate: {
            address: '0x2222222222222222222222222222222222222222',
            orderFeeSplitBps: 1000,
            performanceFeeSplitBps: 1000,
          },
          domeAddress: '0xDome2',
          escrowAddress: '0xEscrow2',
          chainId: 137,
        },
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse1),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse2),
        });

      const config1 = await fetchFeeConfig({
        apiKey: 'api-key-1',
        cacheTTL: 300000,
      });

      const config2 = await fetchFeeConfig({
        apiKey: 'api-key-2',
        cacheTTL: 300000,
      });

      expect(config1.orderFee.domeFeeBps).toBe(10);
      expect(config2.orderFee.domeFeeBps).toBe(18); // 20 - (20 * 0.10) = 18
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should skip cache when cacheTTL is 0', async () => {
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

      await fetchFeeConfig({ apiKey: 'test-api-key', cacheTTL: 0 });
      await fetchFeeConfig({ apiKey: 'test-api-key', cacheTTL: 0 });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should clear specific cache entry', async () => {
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

      // First fetch
      await fetchFeeConfig({ apiKey: 'test-api-key', cacheTTL: 300000 });
      expect(hasCachedConfig('test-api-key')).toBe(true);

      // Clear specific key
      clearConfigCache('test-api-key');
      expect(hasCachedConfig('test-api-key')).toBe(false);

      // Should fetch again
      await fetchFeeConfig({ apiKey: 'test-api-key', cacheTTL: 300000 });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache entries', async () => {
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

      await fetchFeeConfig({ apiKey: 'api-key-1', cacheTTL: 300000 });
      await fetchFeeConfig({ apiKey: 'api-key-2', cacheTTL: 300000 });

      expect(hasCachedConfig('api-key-1')).toBe(true);
      expect(hasCachedConfig('api-key-2')).toBe(true);

      // Clear all
      clearConfigCache();

      expect(hasCachedConfig('api-key-1')).toBe(false);
      expect(hasCachedConfig('api-key-2')).toBe(false);
    });
  });

  describe('hasCachedConfig', () => {
    it('should return false when no cache exists', () => {
      expect(hasCachedConfig('nonexistent-key')).toBe(false);
    });

    it('should return true for valid cached config', async () => {
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

      await fetchFeeConfig({ apiKey: 'test-api-key', cacheTTL: 300000 });

      expect(hasCachedConfig('test-api-key')).toBe(true);
    });
  });
});
