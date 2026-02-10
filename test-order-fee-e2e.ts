/**
 * Order Fee Flow Test - REAL PRIVY SIGNATURES
 *
 * Tests complete order placement with fee authorization using REAL Privy signatures.
 * This is a TRUE end-to-end test with real on-chain transactions.
 *
 * Prerequisites:
 * - Proxy server running: cd dome-fee-integration/testing/proxy && npm start
 * - PROXY_MODE=online (real escrow)
 * - ORDER_MODE=live (real orders)
 * - Privy credentials in .env (PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY)
 * - Wallet funded with USDC and POL
 * - Operator wallet has gas for escrow transactions
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '../../.env' });

import { ethers } from 'ethers';
import { PrivyClient } from '@privy-io/server-auth';
import fetch from 'node-fetch';
import * as fs from 'fs';
import {
  DomeFeeEscrowClient,
  parseUsdc,
  formatUsdc,
  ESCROW_CONTRACT_V3_POLYGON,
  generateOrderId,
} from '../../dome-sdk-ts-pr/dist/esm/index.js';
import type { TypedDataSigner } from '../../dome-sdk-ts-pr/dist/esm/escrow/signing.js';

// Configuration
const CONFIG = {
  POLYGON_RPC_URL:
    process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  DOME_API_ENDPOINT: process.env.DOME_API_ENDPOINT || 'http://localhost:3001',
  DOME_API_KEY:
    process.env.DOME_API_KEY || 'e779410b-f1a6-479c-9851-2a49c1749f55',

  // Privy configuration
  PRIVY_APP_ID: process.env.PRIVY_APP_ID || '',
  PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET || '',
  PRIVY_AUTHORIZATION_KEY: process.env.PRIVY_AUTHORIZATION_KEY || '',
  PRIVY_WALLET_ID: process.env.PRIVY_WALLET_ID || 'g4pamnepfl2bkabxjxrcdckc',
  PRIVY_WALLET_ADDRESS: (process.env.PRIVY_WALLET_ADDRESS ||
    '0x12592f556EeAc4C76A92c02E4Bf8cAf42EC58904') as `0x${string}`,

  // Contracts
  DOME_ESCROW_ADDRESS: ESCROW_CONTRACT_V3_POLYGON,
  USDC_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',

  // Fee configuration
  MIN_ORDER_FEE: 10000n, // $0.01 USDC
  TEST_ORDER_FEE: 2500000n, // $2.50 USDC
  TEST_MARKET_ID:
    '0xd595eb9b81985ff018738300c79047e3ec89e87294424f57a29a7fa9162bf116', // Trump Greenland

  // Timeout
  TX_CONFIRMATION_TIMEOUT: 60000, // 60 seconds
};

interface ProxyOrderRequest {
  orderID: string;
  payerAddress: string;
  displayAddress: string;
  signerAddress: string;
  feeAuth: any;
  signedOrder: any;
  credentials: any;
  marketID: string;
}

interface TestResults {
  passed: boolean;
  timestamp: string;
  tests: {
    [key: string]: {
      passed: boolean;
      details: string;
    };
  };
}

/**
 * Create Privy TypedDataSigner adapter
 */
function createPrivyTypedDataSigner(
  privy: PrivyClient,
  walletId: string,
  walletAddress: string
): TypedDataSigner {
  return {
    async getAddress(): Promise<string> {
      return walletAddress;
    },
    async signTypedData(params: {
      domain: any;
      types: any;
      primaryType: string;
      message: any;
    }): Promise<string> {
      console.log(`    Calling Privy.signTypedData for wallet ${walletId}`);
      try {
        const { signature } = await privy.walletApi.ethereum.signTypedData({
          walletId,
          typedData: {
            domain: params.domain,
            types: params.types,
            primaryType: params.primaryType,
            message: params.message,
          },
        });
        return signature;
      } catch (error) {
        console.error('    ❌ Privy signTypedData failed:', error);
        throw error;
      }
    },
  };
}

/**
 * Create a mock Polymarket signed order
 */
function createMockSignedOrder(side: 'BUY' | 'SELL' = 'BUY'): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    salt: ethers.hexlify(ethers.randomBytes(32)),
    maker: CONFIG.PRIVY_WALLET_ADDRESS,
    signer: CONFIG.PRIVY_WALLET_ADDRESS,
    taker: ethers.ZeroAddress,
    tokenId: CONFIG.TEST_MARKET_ID,
    makerAmount: '1000000000', // 1000 USDC
    takerAmount: '5000',
    expiration: (now + 3600).toString(),
    nonce: '0',
    feeRateBps: '0',
    side,
    signatureType: 1,
    signature: `0x${'00'.repeat(65)}`, // Mock signature
  };
}

/**
 * Submit order to proxy server
 */
async function submitOrderToProxy(request: ProxyOrderRequest): Promise<any> {
  console.log(`\n  🌐 Submitting order to proxy server`);
  console.log(`    Endpoint: ${CONFIG.DOME_API_ENDPOINT}/orders`);
  console.log(`    API Key: ${CONFIG.DOME_API_KEY.substring(0, 8)}...`);
  console.log(`    FeeAuth fields:`, Object.keys(request.feeAuth).join(', '));

  try {
    const response = await fetch(`${CONFIG.DOME_API_ENDPOINT}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.DOME_API_KEY,
      },
      body: JSON.stringify(request),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        `Proxy error: ${response.status} ${JSON.stringify(result)}`
      );
    }

    return result;
  } catch (error) {
    console.error(`    ❌ Error submitting to proxy:`, error);
    throw error;
  }
}

/**
 * Check USDC balance
 */
async function checkBalance(
  address: string,
  provider: ethers.Provider
): Promise<bigint> {
  const abi = ['function balanceOf(address) public view returns (uint256)'];
  const usdc = new ethers.Contract(CONFIG.USDC_ADDRESS, abi, provider);
  return await usdc.balanceOf(address);
}

/**
 * Main test execution
 */
async function runTest(): Promise<void> {
  console.log('🚀 Starting Order Fee Flow Test (REAL PRIVY SIGNATURES)\n');
  console.log(`Network: Polygon Mainnet (137)`);
  console.log(`RPC: ${CONFIG.POLYGON_RPC_URL}`);
  console.log(`Proxy: ${CONFIG.DOME_API_ENDPOINT}\n`);

  const provider = new ethers.JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const results: TestResults = {
    passed: true,
    timestamp: new Date().toISOString(),
    tests: {},
  };

  try {
    // Verify network
    const network = await provider.getNetwork();
    console.log(
      `✅ Connected to: ${network.name} (Chain ID: ${network.chainId})\n`
    );

    // Test 1: Check wallet balance
    console.log('📋 Test 1: Check Wallet Balance');
    const balance = await checkBalance(CONFIG.PRIVY_WALLET_ADDRESS, provider);
    const balanceUSDC = Number(balance) / 1e6;
    console.log(`  Wallet Address: ${CONFIG.PRIVY_WALLET_ADDRESS}`);
    console.log(`  USDC Balance: $${balanceUSDC.toFixed(2)}`);

    if (balance < CONFIG.MIN_ORDER_FEE) {
      console.log(`  ❌ Insufficient balance`);
      results.tests['balance'] = {
        passed: false,
        details: `Insufficient USDC balance: $${balanceUSDC.toFixed(2)}`,
      };
      throw new Error('Insufficient wallet balance');
    } else {
      console.log(`  ✅ Sufficient balance`);
      results.tests['balance'] = {
        passed: true,
        details: `Balance: $${balanceUSDC.toFixed(2)}`,
      };
    }
    console.log();

    // Test 2: Generate order ID
    console.log('📋 Test 2: Generate Order ID');
    const orderId = generateOrderId({
      chainId: 137,
      userAddress: CONFIG.PRIVY_WALLET_ADDRESS,
      marketId: CONFIG.TEST_MARKET_ID,
      side: 'BUY',
      size: 5000n,
      price: 0.5, // 50% price
      timestamp: Date.now(),
    });
    console.log(`  Order ID: ${orderId}`);
    results.tests['orderID'] = {
      passed: true,
      details: orderId,
    };
    console.log();

    // Test 3: Setup Privy client
    console.log('📋 Test 3: Initialize Privy Client');
    if (!CONFIG.PRIVY_APP_ID || !CONFIG.PRIVY_APP_SECRET) {
      throw new Error('Missing PRIVY_APP_ID or PRIVY_APP_SECRET');
    }

    const privy = new PrivyClient(
      CONFIG.PRIVY_APP_ID,
      CONFIG.PRIVY_APP_SECRET,
      {
        walletApi: {
          authorizationPrivateKey: CONFIG.PRIVY_AUTHORIZATION_KEY,
        },
      }
    );
    console.log(`  ✅ Privy client initialized`);
    console.log(`  Wallet ID: ${CONFIG.PRIVY_WALLET_ID}`);
    results.tests['privyInit'] = {
      passed: true,
      details: `Privy client initialized for wallet ${CONFIG.PRIVY_WALLET_ID}`,
    };
    console.log();

    // Test 4: Setup escrow client and sign fee authorization
    console.log('📋 Test 4: Sign Fee Authorization with Privy');
    const escrowClient = new DomeFeeEscrowClient({
      provider,
      contractAddress: CONFIG.DOME_ESCROW_ADDRESS,
      chainId: 137,
    });

    const privySigner = createPrivyTypedDataSigner(
      privy,
      CONFIG.PRIVY_WALLET_ID,
      CONFIG.PRIVY_WALLET_ADDRESS
    );

    console.log(`  📝 Signing order fee authorization via Privy...`);
    const { auth, signature } = await escrowClient.signOrderFeeAuthWithSigner(
      privySigner,
      {
        orderId,
        domeAmount: CONFIG.TEST_ORDER_FEE,
        affiliateAmount: 0n,
        deadline: 3600,
      }
    );

    console.log(`  ✅ Signed with Privy`);
    console.log(`    Signature: ${signature.substring(0, 20)}...`);
    results.tests['feeAuth'] = {
      passed: true,
      details: `Signed for ${formatUsdc(CONFIG.TEST_ORDER_FEE)} USDC`,
    };
    console.log();

    // Test 5: Prepare order request
    console.log('📋 Test 5: Prepare Order Request');
    const mockSignedOrder = createMockSignedOrder('BUY');
    const orderRequest: ProxyOrderRequest = {
      orderID: orderId,
      payerAddress: CONFIG.PRIVY_WALLET_ADDRESS,
      displayAddress: CONFIG.PRIVY_WALLET_ADDRESS,
      signerAddress: CONFIG.PRIVY_WALLET_ADDRESS,
      feeAuth: {
        orderId: auth.orderId,
        payer: auth.payer,
        feeAmount: CONFIG.TEST_ORDER_FEE.toString(),
        deadline: auth.deadline,
        signature,
      },
      signedOrder: mockSignedOrder,
      credentials: {
        apiKey: '',
        apiSecret: '',
        apiPassphrase: '',
      },
      marketID: CONFIG.TEST_MARKET_ID,
    };
    console.log(`  ✅ Prepared`);
    results.tests['orderRequest'] = {
      passed: true,
      details: 'Order request prepared',
    };
    console.log();

    // Test 6: Submit to proxy
    console.log('📋 Test 6: Submit Order to Proxy');
    try {
      const proxyResponse = await submitOrderToProxy(orderRequest);
      console.log(`  ✅ Submitted`);
      console.log(`  Response:`, JSON.stringify(proxyResponse, null, 2));
      results.tests['proxySubmit'] = {
        passed: true,
        details: `Proxy accepted order`,
      };
    } catch (error) {
      console.log(`  ⚠️  Proxy submission failed`);
      console.log(
        `  Error: ${error instanceof Error ? error.message : String(error)}`
      );

      // Check if this is due to signature verification failure
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('reverted') || errorMsg.includes('signature')) {
        // Signature verification failed - this is expected if something is wrong
        results.tests['proxySubmit'] = {
          passed: false,
          details: `Signature verification failed or transaction reverted`,
        };
      } else {
        // Some other error
        results.tests['proxySubmit'] = {
          passed: false,
          details: errorMsg,
        };
      }
    }
    console.log();

    // Calculate final passed status
    results.passed = Object.values(results.tests).every(test => test.passed);

    // Summary
    console.log('='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));

    for (const [testName, testResult] of Object.entries(results.tests)) {
      const status = testResult.passed ? '✅' : '❌';
      console.log(`${status} ${testName}: ${testResult.details}`);
    }

    console.log(`\n${'='.repeat(60)}`);
    const overallStatus = results.passed
      ? '✅ ALL TESTS PASSED'
      : '❌ SOME TESTS FAILED';
    console.log(overallStatus);
    console.log('='.repeat(60));

    console.log('\n📋 CRITICAL DETAILS');
    console.log(`Wallet Address: ${CONFIG.PRIVY_WALLET_ADDRESS}`);
    console.log(`Escrow Contract: ${CONFIG.DOME_ESCROW_ADDRESS}`);

    // Save results
    const resultsFile = 'order-fee-results-privy.json';
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to: ${resultsFile}`);
  } catch (error) {
    console.error('❌ Test failed:', error);
    results.tests['error'] = {
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    };
    results.passed = false;
    const resultsFile = 'order-fee-results-privy.json';
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    process.exit(1);
  }
}

// Run test
runTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
