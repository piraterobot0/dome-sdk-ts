/**
 * EIP-7702 Diagnostic Tool
 *
 * Use this script to diagnose EIP-7702 delegation issues with Privy wallets.
 *
 * Usage:
 *   npx tsx privy-eip7702-diagnostic.ts 0xYourWalletAddress
 *
 * Or with custom RPC:
 *   RPC_URL=https://your-rpc.com npx tsx privy-eip7702-diagnostic.ts 0xYourWalletAddress
 */

import { ethers } from 'ethers';
import {
  checkEIP7702Compatibility,
  logEIP7702Result,
  EIP7702DetectionResult,
  supportsEIP1271,
} from '../src/utils/eip7702.js';

/**
 * Color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * Print formatted header
 */
function printHeader(text: string): void {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${text}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}\n`);
}

/**
 * Print section header
 */
function printSection(text: string): void {
  console.log(`\n${colors.blue}→ ${text}${colors.reset}`);
  console.log(`${colors.blue}${'─'.repeat(58)}${colors.reset}`);
}

/**
 * Print success message
 */
function printSuccess(text: string): void {
  console.log(`${colors.green}✓${colors.reset} ${text}`);
}

/**
 * Print error message
 */
function printError(text: string): void {
  console.log(`${colors.red}✗${colors.reset} ${text}`);
}

/**
 * Print warning message
 */
function printWarning(text: string): void {
  console.log(`${colors.yellow}⚠${colors.reset} ${text}`);
}

/**
 * Print info message
 */
function printInfo(text: string): void {
  console.log(`ℹ ${text}`);
}

/**
 * Verify wallet address format
 */
function validateAddress(address: string): boolean {
  if (!address.startsWith('0x')) {
    printError('Address must start with "0x"');
    return false;
  }

  if (address.length !== 42) {
    printError(
      `Address must be 42 characters (0x + 40 hex), got ${address.length}`
    );
    return false;
  }

  try {
    ethers.utils.getAddress(address); // Checksum validation
    return true;
  } catch {
    printError('Invalid address format');
    return false;
  }
}

/**
 * Get RPC URL from environment or use default
 */
function getRpcUrl(): string {
  return process.env.RPC_URL || 'https://polygon-rpc.com';
}

/**
 * Main diagnostic function
 */
async function runDiagnostic(walletAddress: string): Promise<void> {
  try {
    printHeader('EIP-7702 Diagnostic Tool');

    // Validate address
    printSection('1. Address Validation');
    if (!validateAddress(walletAddress)) {
      process.exit(1);
    }
    const checksumAddress = ethers.utils.getAddress(walletAddress);
    printSuccess(`Valid address: ${checksumAddress}`);

    // Initialize provider
    printSection('2. RPC Connection');
    const rpcUrl = getRpcUrl();
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 137);

    try {
      const blockNumber = await provider.getBlockNumber();
      printSuccess(`Connected to RPC: ${rpcUrl}`);
      printInfo(`Current block: ${blockNumber}`);
    } catch (error) {
      printError(`Failed to connect to RPC`);
      printInfo(`RPC URL: ${rpcUrl}`);
      printInfo(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }

    // Check raw bytecode
    printSection('3. Raw Bytecode Check');
    const code = await provider.getCode(checksumAddress);

    if (code === '0x' || code === '0x0') {
      printInfo('Bytecode: (empty)');
      printSuccess(
        'No code at address - Standard EOA (not contract, not EIP-7702)'
      );
    } else if (code.length > 1000) {
      const preview = `${code.slice(0, 20)}...${code.slice(-20)}`;
      printInfo(`Bytecode length: ${(code.length - 2) / 2} bytes`);
      printInfo(`Preview: ${preview}`);

      if (code.toLowerCase().startsWith('0xef0100')) {
        printWarning('EIP-7702 bytecode detected!');
      } else {
        printSuccess('Contract code detected (not EIP-7702)');
      }
    } else {
      const preview = code.length > 20 ? `${code.slice(0, 20)}...` : code;
      printInfo(`Bytecode length: ${(code.length - 2) / 2} bytes`);
      printInfo(`Code: ${preview}`);
    }

    // Run EIP-7702 detection
    printSection('4. EIP-7702 Detection');
    const result = await checkEIP7702Compatibility(checksumAddress, provider);
    logEIP7702Result(checksumAddress, result);

    if (result.error) {
      printError(`Detection error: ${result.error}`);
    } else if (!result.isDelegated) {
      printSuccess('No EIP-7702 delegation detected');
      printInfo('This wallet does not use EIP-7702 gas sponsorship');
    } else {
      printWarning('EIP-7702 delegation detected');

      if (result.delegateAddress) {
        printInfo(`Delegate address: ${result.delegateAddress}`);

        // Verify delegate address format
        try {
          ethers.utils.getAddress(result.delegateAddress);
          printSuccess(`Delegate address is valid`);
        } catch {
          printError(`Delegate address is invalid format`);
        }

        // Check delegate code
        const delegateCode = await provider.getCode(result.delegateAddress);
        if (delegateCode === '0x' || delegateCode === '0x0') {
          printError(
            'Delegate address has no code (address does not exist or is EOA)'
          );
        } else {
          printSuccess(
            `Delegate has code (${(delegateCode.length - 2) / 2} bytes)`
          );
        }
      }

      // EIP-1271 support check
      if (result.supportsEIP1271 === true) {
        printSuccess('Delegate implements EIP-1271 ✓');
        printSuccess(
          'Fee authorizations should work correctly with DomeFeeEscrow'
        );
      } else if (result.supportsEIP1271 === false) {
        printError('Delegate does NOT implement EIP-1271 ✗');
        printError('Fee authorizations will FAIL on-chain with DomeFeeEscrow');
        printInfo('Solution: Contact Privy support or disable gas sponsorship');
      } else {
        printWarning('Could not verify EIP-1271 support (uncertain)');
        printInfo(
          'Try manual verification or contact Privy support for confirmation'
        );

        // Attempt manual verification if we have delegate address
        if (result.delegateAddress) {
          printSection('5. Manual EIP-1271 Verification');
          try {
            const hasEIP1271 = await supportsEIP1271(
              result.delegateAddress,
              provider
            );
            if (hasEIP1271) {
              printSuccess('Manual check found EIP-1271 support');
            } else {
              printWarning('Manual check found no EIP-1271 support');
            }
          } catch (error) {
            printWarning(
              `Manual check failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    }

    // Recommendations
    printSection('6. Recommendations');

    if (!result.isDelegated) {
      printSuccess(
        'No EIP-7702 detected. This wallet should work normally with Dome fee escrow.'
      );
      printInfo(
        'If you still experience "InvalidSignature" errors, investigate other causes:'
      );
      console.log('     - Wrong signature encoding');
      console.log('     - Mismatched payer address');
      console.log('     - Expired deadline');
      console.log('     - Wrong chain ID');
      console.log('     - See TROUBLESHOOTING_EIP7702.md for more details');
    } else if (result.supportsEIP1271 === true) {
      printSuccess('EIP-7702 is configured correctly. Fee escrow should work.');
    } else if (result.supportsEIP1271 === false) {
      printError('EIP-7702 delegate lacks EIP-1271 support');
      console.log('\nAction items:');
      console.log(
        '  1. Contact Privy support to enable EIP-1271 on their delegate'
      );
      console.log(
        '  2. Or disable Privy gas sponsorship and use regular transaction fee'
      );
      console.log('  3. Or use a different wallet without gas sponsorship');
    } else {
      printWarning('EIP-1271 status uncertain');
      console.log('\nNext steps:');
      console.log(
        '  1. Check Privy documentation for delegate implementation details'
      );
      console.log(
        '  2. Look up delegate contract on Polygonscan (search for isValidSignature)'
      );
      console.log('  3. Contact Privy support for explicit confirmation');
    }

    // Test order placement
    printSection('7. Test Recommendation');
    if (result.isDelegated && result.supportsEIP1271 === false) {
      printError(
        'This wallet configuration will NOT work with Dome fee escrow'
      );
    } else {
      printSuccess('This wallet should work with Dome fee escrow');
      console.log('\nTo test:');
      console.log('  1. Use PolymarketRouterWithEscrow.create() to initialize');
      console.log('  2. Set escrow.checkEIP7702 = true for detection logs');
      console.log('  3. Try placing a small test order');
    }

    printHeader('Diagnostic Complete');
  } catch (error) {
    printError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error(error);
    process.exit(1);
  }
}

/**
 * Entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('EIP-7702 Diagnostic Tool');
    console.log('\nUsage:');
    console.log('  npx tsx privy-eip7702-diagnostic.ts <wallet_address>');
    console.log('\nExample:');
    console.log(
      '  npx tsx privy-eip7702-diagnostic.ts 0x1234567890123456789012345678901234567890'
    );
    console.log('\nEnvironment Variables:');
    console.log(
      '  RPC_URL - Custom RPC endpoint (default: https://polygon-rpc.com)'
    );
    console.log('\nExample with custom RPC:');
    console.log(
      '  RPC_URL=https://your-rpc.com npx tsx privy-eip7702-diagnostic.ts 0x...'
    );
    process.exit(0);
  }

  const walletAddress = args[0];
  await runDiagnostic(walletAddress);
}

// Run main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
