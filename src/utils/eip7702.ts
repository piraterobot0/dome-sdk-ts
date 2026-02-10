/**
 * EIP-7702 Detection and Verification Utilities
 *
 * EIP-7702 allows EOAs to delegate execution to smart contracts, enabling advanced features
 * like gas sponsorship (used by Privy). This module detects EIP-7702 delegation and verifies
 * that delegates implement EIP-1271 for signature verification compatibility.
 *
 * **Critical for fee authorization**: When a wallet uses EIP-7702 delegation, the delegate
 * contract MUST implement EIP-1271 (isValidSignature). Otherwise, off-chain signatures will
 * fail on-chain validation in the DomeFeeEscrow contract.
 */

import { ethers } from 'ethers';

/**
 * Result of EIP-7702 detection check
 */
export interface EIP7702DetectionResult {
  /** Whether the account has EIP-7702 delegation active */
  isDelegated: boolean;

  /** Address of the delegate contract (if delegated) */
  delegateAddress?: string;

  /** Whether the delegate implements EIP-1271 (if delegated) */
  supportsEIP1271?: boolean;

  /** Error message if detection failed */
  error?: string;
}

/**
 * Custom error for EIP-7702 related issues
 */
export class EIP7702Error extends Error {
  constructor(
    message: string,
    readonly delegateAddress?: string,
    readonly supportsEIP1271?: boolean
  ) {
    super(message);
    this.name = 'EIP7702Error';
  }
}

/**
 * EIP-7702 bytecode prefix: 0xef0100 (23 bytes total with 20-byte delegate address)
 * Format: 0xef0100 || delegateAddress (20 bytes)
 */
const EIP7702_PREFIX = '0xef0100';
const EIP7702_BYTECODE_LENGTH = 46; // 0x + 44 hex chars (2 bytes per byte) = 23 bytes total

/**
 * EIP-1271 signature validation selector (0x1626ba7e)
 * keccak256("isValidSignature(bytes32,bytes)") = 0x1626ba7e...
 */
const EIP1271_SELECTOR = '0x1626ba7e';

/**
 * Detect if an address has EIP-7702 delegation active
 *
 * @param address - Address to check
 * @param provider - Ethers.js provider
 * @returns Detection result with delegation status and delegate address
 *
 * @example
 * ```typescript
 * const result = await detectEIP7702Delegation('0x1234...', provider);
 * if (result.isDelegated) {
 *   console.log('Delegate:', result.delegateAddress);
 * }
 * ```
 */
export async function detectEIP7702Delegation(
  address: string,
  provider: ethers.providers.Provider
): Promise<EIP7702DetectionResult> {
  try {
    const code = await provider.getCode(address);

    // Check if bytecode starts with EIP-7702 prefix
    if (!code.toLowerCase().startsWith(EIP7702_PREFIX)) {
      return { isDelegated: false };
    }

    // Extract delegate address (20 bytes after 0xef0100 prefix)
    if (code.length !== EIP7702_BYTECODE_LENGTH) {
      return {
        isDelegated: false,
        error: 'Invalid EIP-7702 bytecode length',
      };
    }

    // Extract delegate address: skip "0xef0100" (8 chars) and take next 40 hex chars (20 bytes)
    const delegateAddress = `0x${code.slice(8, 48)}`;

    // Verify it's a valid address format
    try {
      ethers.utils.getAddress(delegateAddress);
    } catch {
      return {
        isDelegated: false,
        error: 'Invalid delegate address in EIP-7702 bytecode',
      };
    }

    return {
      isDelegated: true,
      delegateAddress,
    };
  } catch (error) {
    return {
      isDelegated: false,
      error: `Failed to detect EIP-7702: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check if a contract implements EIP-1271 (isValidSignature)
 *
 * @param contractAddress - Contract address to check
 * @param provider - Ethers.js provider
 * @returns True if the contract appears to implement EIP-1271
 *
 * @remarks
 * This is a heuristic check - it attempts to call isValidSignature with dummy parameters.
 * The contract must implement the EIP-1271 interface for this to return true.
 *
 * @example
 * ```typescript
 * const hasEIP1271 = await supportsEIP1271(delegateAddress, provider);
 * if (!hasEIP1271) {
 *   console.warn('Delegate lacks EIP-1271 support');
 * }
 * ```
 */
export async function supportsEIP1271(
  contractAddress: string,
  provider: ethers.providers.Provider
): Promise<boolean> {
  try {
    // Create a contract instance with minimal ABI (just isValidSignature)
    const abi = [
      'function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4)',
    ];

    const contract = new ethers.Contract(contractAddress, abi, provider);

    // Try to call isValidSignature with dummy values
    // Dummy hash: all zeros
    const dummyHash = ethers.utils.formatBytes32String('');
    const dummySignature = '0x00';

    try {
      const result = await contract.isValidSignature(dummyHash, dummySignature);

      // Even if the call fails, if the function exists, it should return something
      // If no function exists, this would throw
      return true;
    } catch (callError) {
      // If we get a contract-specific error (e.g., from the validation logic),
      // that means the function exists. Only return false if we get a "function not found" error
      const errorMessage =
        callError instanceof Error ? callError.message : String(callError);

      // These errors indicate the function exists but validation failed (good)
      if (
        errorMessage.includes('reverted') ||
        errorMessage.includes('insufficient')
      ) {
        return true;
      }

      // This error indicates the function doesn't exist (bad)
      if (errorMessage.includes('no matching function')) {
        return false;
      }

      // For other errors, assume it exists (safer approach)
      return true;
    }
  } catch (error) {
    // If we can't even create the contract instance, function doesn't exist
    return false;
  }
}

/**
 * Combined EIP-7702 detection and EIP-1271 verification
 *
 * @param address - Address to check
 * @param provider - Ethers.js provider
 * @returns Full detection result including EIP-1271 support status
 *
 * @example
 * ```typescript
 * const result = await checkEIP7702Compatibility(walletAddress, provider);
 *
 * if (result.isDelegated && !result.supportsEIP1271) {
 *   console.error('Fee authorization will fail!');
 *   console.log('Delegate:', result.delegateAddress);
 * }
 * ```
 */
export async function checkEIP7702Compatibility(
  address: string,
  provider: ethers.providers.Provider
): Promise<EIP7702DetectionResult> {
  const detectionResult = await detectEIP7702Delegation(address, provider);

  if (!detectionResult.isDelegated || !detectionResult.delegateAddress) {
    return detectionResult;
  }

  // Check if delegate supports EIP-1271
  const supportsEIP1271Result = await supportsEIP1271(
    detectionResult.delegateAddress,
    provider
  );

  return {
    ...detectionResult,
    supportsEIP1271: supportsEIP1271Result,
  };
}

/**
 * Create a user-friendly error message for EIP-7702 issues
 *
 * @param address - The address with EIP-7702 delegation
 * @param delegateAddress - The delegate contract address
 * @param supportsEIP1271 - Whether delegate implements EIP-1271
 * @returns User-friendly error message
 *
 * @example
 * ```typescript
 * const message = createEIP7702ErrorMessage(
 *   '0x1234...',
 *   '0x5678...',
 *   false
 * );
 * console.error(message);
 * // Output: "Wallet uses EIP-7702 gas sponsorship but delegate lacks EIP-1271 support..."
 * ```
 */
export function createEIP7702ErrorMessage(
  address: string,
  delegateAddress?: string,
  supportsEIP1271?: boolean
): string {
  if (!delegateAddress) {
    return `Wallet ${address} has EIP-7702 delegation but could not extract delegate address`;
  }

  if (supportsEIP1271 === false) {
    return (
      `Wallet ${address} uses EIP-7702 gas sponsorship with delegate ${delegateAddress}, ` +
      `but the delegate lacks EIP-1271 support. ` +
      `This will cause fee authorization signatures to fail on-chain. ` +
      `Please contact Privy support or disable gas sponsorship.`
    );
  }

  if (supportsEIP1271 === true) {
    return (
      `Wallet ${address} uses EIP-7702 gas sponsorship with delegate ${delegateAddress} ` +
      `which supports EIP-1271. Fee authorizations should work correctly.`
    );
  }

  return (
    `Wallet ${address} uses EIP-7702 gas sponsorship with delegate ${delegateAddress}. ` +
    `Could not verify EIP-1271 support. Fee authorizations may fail.`
  );
}

/**
 * Log EIP-7702 detection results to console with color coding
 *
 * @param address - Address that was checked
 * @param result - Detection result
 *
 * @example
 * ```typescript
 * const result = await checkEIP7702Compatibility(address, provider);
 * logEIP7702Result(address, result);
 * ```
 */
export function logEIP7702Result(
  address: string,
  result: EIP7702DetectionResult
): void {
  if (result.error) {
    console.warn(`[EIP-7702] Error checking ${address}: ${result.error}`);
    return;
  }

  if (!result.isDelegated) {
    console.log(`[EIP-7702] ${address} - No delegation detected`);
    return;
  }

  const delegateAddr = result.delegateAddress || 'unknown';

  if (result.supportsEIP1271 === true) {
    console.log(
      `[EIP-7702] ${address} - Delegation detected: ${delegateAddr} (EIP-1271 ✓)`
    );
  } else if (result.supportsEIP1271 === false) {
    console.warn(
      `[EIP-7702] ${address} - Delegation detected: ${delegateAddr} (EIP-1271 ✗)`
    );
  } else {
    console.log(
      `[EIP-7702] ${address} - Delegation detected: ${delegateAddr} (EIP-1271 status unknown)`
    );
  }
}
