# EIP-7702 Troubleshooting Guide

This guide helps diagnose and resolve issues when using Privy's gas sponsorship feature (EIP-7702) with Dome fee escrow.

## Quick Diagnosis

### Test Your Wallet

```bash
# Check if wallet uses EIP-7702
curl -s https://polygon-rpc.com \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_getCode",
    "params": ["0xYourWalletAddress"]
  }' | jq '.result'
```

**Interpretation:**

- `0x` or `0x0`: No EIP-7702 (issue is NOT EIP-7702 related)
- `0xef0100...`: EIP-7702 detected (check delegate EIP-1271 support)

### Programmatic Check

```typescript
import { checkEIP7702Compatibility } from '@dome-api/sdk/escrow';
import { ethers } from 'ethers';

const provider = new ethers.providers.JsonRpcProvider(
  'https://polygon-rpc.com',
  137
);
const walletAddress = '0x...';

const result = await checkEIP7702Compatibility(walletAddress, provider);

if (!result.isDelegated) {
  console.log('✓ No EIP-7702 delegation detected');
  console.log('→ Issue is NOT related to EIP-7702');
} else if (result.supportsEIP1271 === false) {
  console.error('✗ EIP-7702 detected WITHOUT EIP-1271 support');
  console.error(`→ Delegate: ${result.delegateAddress}`);
  console.error('→ Fee authorizations will FAIL');
} else if (result.supportsEIP1271 === true) {
  console.log('✓ EIP-7702 detected WITH EIP-1271 support');
  console.log(`→ Delegate: ${result.delegateAddress}`);
  console.log('→ Fee authorizations should work');
} else {
  console.warn('? Could not verify EIP-1271 support');
  console.log(`→ Delegate: ${result.delegateAddress}`);
}
```

---

## Common Issues and Solutions

### 1. "InvalidSignature" Error During Order Placement

**Symptom:**

```
Error: Order placement failed: InvalidSignature
```

**Root Causes:**

#### A. EIP-7702 Delegate Lacks EIP-1271

Most common issue - delegate contract doesn't implement `isValidSignature()`.

**Check:**

```typescript
const result = await checkEIP7702Compatibility(walletAddress, provider);
if (result.isDelegated && result.supportsEIP1271 === false) {
  console.error('FOUND ISSUE: Delegate lacks EIP-1271');
}
```

**Solutions:**

1. **Contact Privy Support**: Request EIP-1271 implementation in delegate
2. **Disable Gas Sponsorship**: Turn off Privy's gas sponsorship feature
3. **Use Different Wallet**: Try with a non-EIP-7702 wallet temporarily

#### B. Not EIP-7702 Related (Other Signature Issues)

**Check:**

```typescript
const result = await checkEIP7702Compatibility(walletAddress, provider);
if (!result.isDelegated) {
  console.log('Wallet does not use EIP-7702');
  console.log('Issue is caused by something else...');
}
```

**Other causes to investigate:**

- Invalid signature format (wrong encoding)
- Wrong payer address in signature
- Expired deadline
- Wrong chain ID in signature
- Signature created for wrong contract

See "Signature Format Verification" below.

---

### 2. "DelegateDoesNotSupportEIP1271" Error (Contract Error)

**Symptom:**

```
Error: Order placement failed: DelegateDoesNotSupportEIP1271
```

**Meaning:** This is the contract explicitly detecting EIP-7702 and failing. It's the same as "InvalidSignature" but with a clearer error message.

**Solutions:** Same as above - either get EIP-1271 support or disable gas sponsorship.

---

### 3. Signature Verification Failed (Off-Chain vs On-Chain)

**Problem:** Off-chain signing works, but on-chain verification fails.

**Diagnosis Checklist:**

```typescript
import { ethers } from 'ethers';
import { createDomeFeeEscrowEIP712Domain } from '@dome-api/sdk/escrow';

async function debugSignatureIssue(
  walletAddress: string,
  signature: string,
  domeFeeEscrowAddress: string,
  chainId: number
) {
  console.log('\n=== Signature Verification Debug ===\n');

  // 1. Check signature format
  console.log('1. Signature Format:');
  console.log(
    `   Length: ${signature.length} (expected: 132 for 0x + 130 hex)`
  );
  console.log(`   Valid: ${signature.length === 132 ? '✓' : '✗'}`);

  if (signature.length === 132) {
    const r = signature.slice(0, 66);
    const s = '0x' + signature.slice(66, 130);
    const v = parseInt(signature.slice(130, 132), 16);
    console.log(`   r: ${r.slice(0, 10)}...${r.slice(-6)}`);
    console.log(`   s: ${s.slice(0, 10)}...${s.slice(-6)}`);
    console.log(
      `   v: ${v} (expected: 27 or 28) ${v === 27 || v === 28 ? '✓' : '✗'}`
    );
  }

  // 2. Check signer
  console.log('\n2. Signer Check:');
  const expectedSigner = walletAddress;
  console.log(`   Expected: ${expectedSigner}`);
  console.log(`   Payer in signature: [compare with actual]`);

  // 3. Check EIP-712 domain
  console.log('\n3. EIP-712 Domain:');
  const domain = createDomeFeeEscrowEIP712Domain(domeFeeEscrowAddress, chainId);
  console.log(`   Name: ${domain.name}`);
  console.log(`   Version: ${domain.version}`);
  console.log(`   ChainId: ${domain.chainId}`);
  console.log(`   VerifyingContract: ${domain.verifyingContract}`);

  // 4. Check if wallet uses EIP-7702
  console.log('\n4. EIP-7702 Status:');
  const provider = new ethers.providers.JsonRpcProvider(
    'https://polygon-rpc.com'
  );
  const code = await provider.getCode(walletAddress);

  if (code === '0x' || code === '0x0') {
    console.log(`   Status: No EIP-7702 delegation`);
    console.log(`   → Standard EOA or contract wallet`);
  } else if (code.toLowerCase().startsWith('0xef0100')) {
    console.log(`   Status: EIP-7702 delegation detected`);
    const delegateAddr = '0x' + code.slice(8, 48);
    console.log(`   → Delegate: ${delegateAddr}`);
    console.log(`   → Check if delegate implements EIP-1271`);
  } else {
    console.log(`   Status: Contract code present (not EOA)`);
  }
}
```

**What to Check:**

| Check            | Expected         | Your Wallet | Status |
| ---------------- | ---------------- | ----------- | ------ |
| Signature length | 132 chars        | ?           |        |
| r value format   | 0x... (66 chars) | ?           |        |
| s value format   | 0x... (66 chars) | ?           |        |
| v value          | 27 or 28         | ?           |        |
| Signer address   | Matches payer    | ?           |        |
| Chain ID         | 137 (Polygon)    | ?           |        |
| Contract address | DomeFeeEscrow    | ?           |        |
| EIP-7702 status  | No or supported  | ?           |        |

---

### 4. Detection Fails or Returns Uncertain Results

**Problem:** Router can't determine EIP-7702 status.

**Debug:**

```typescript
import { checkEIP7702Compatibility } from '@dome-api/sdk/escrow';
import { ethers } from 'ethers';

async function debugDetection(walletAddress: string) {
  const provider = new ethers.providers.JsonRpcProvider(
    'https://polygon-rpc.com'
  );

  try {
    const code = await provider.getCode(walletAddress);
    console.log('Raw bytecode:', code.slice(0, 20) + '...');

    const result = await checkEIP7702Compatibility(walletAddress, provider);

    if (result.error) {
      console.error('Detection error:', result.error);
      console.log('\nTroubleshooting:');
      console.log('- Check RPC endpoint availability');
      console.log('- Verify wallet address is correct');
      console.log('- Try alternative RPC endpoint');
    } else {
      console.log('Detection result:', result);
    }
  } catch (error) {
    console.error('Unexpected error:', error);
  }
}
```

**Solutions:**

- Verify RPC endpoint is working: `curl https://polygon-rpc.com`
- Try alternative RPC: `quicknode.com`, `alchemy.com`, or `infura.io`
- Check wallet address format (should be 42 chars: 0x + 40 hex)

---

### 5. EIP-7702 Detected But Status Unknown

**Problem:** Detection works but can't verify EIP-1271 support.

**Cause:** RPC limitations or delegate implementation variations.

**Solutions:**

1. **Manual verification**:

   ```bash
   # Try to call isValidSignature() directly
   cast call 0xDelegateAddress \
     "isValidSignature(bytes32,bytes)" \
     0x0000000000000000000000000000000000000000000000000000000000000000 \
     0x00 \
     --rpc-url https://polygon-rpc.com
   ```

2. **Check contract source**: Look up delegate on Polygonscan
   - Search for `isValidSignature` in code
   - Check if it returns `0x1626ba7e` (EIP-1271 success magic value)

3. **Contact Privy**: Get explicit confirmation of EIP-1271 support in their delegate

---

## Configuration Options

### Disable EIP-7702 Detection

If detection is causing issues or you want to skip it:

```typescript
const router = new PolymarketRouterWithEscrow({
  apiKey: process.env.DOME_API_KEY!,
  escrow: {
    domeFeeBps: 20,
    checkEIP7702: false, // Skip detection entirely
  },
});
```

**Tradeoff:** You won't get warnings about unsupported EIP-7702 delegates, but orders may still fail on-chain.

### Enable Strict Mode (Fail Fast)

To reject orders immediately instead of attempting them:

```typescript
const router = new PolymarketRouterWithEscrow({
  apiKey: process.env.DOME_API_KEY!,
  escrow: {
    domeFeeBps: 20,
    checkEIP7702: true,
    blockUnsupportedEIP7702: true, // Throw error if unsupported
  },
});
```

**Benefit:** Catch issues before submitting to Polymarket.

---

## Advanced: Manual Signature Verification

If you're signing off-chain and want to manually verify before submission:

```typescript
import { ethers } from 'ethers';
import {
  createDomeFeeEscrowEIP712Domain,
  ORDER_FEE_TYPES,
} from '@dome-api/sdk/escrow';

async function verifySignatureManually(
  signature: string,
  payerAddress: string,
  orderId: string,
  domeAmount: bigint,
  affiliateAmount: bigint,
  deadline: number,
  escrowAddress: string,
  chainId: number,
  provider: ethers.providers.Provider
) {
  // 1. Create domain
  const domain = createDomeFeeEscrowEIP712Domain(escrowAddress, chainId);

  // 2. Hash the message
  const structHash = ethers.utils._TypedDataEncoder.hash(
    domain,
    ORDER_FEE_TYPES,
    {
      orderId,
      payer: payerAddress,
      domeAmount: domeAmount.toString(),
      affiliateAmount: affiliateAmount.toString(),
      chainId,
      deadline,
    }
  );

  // 3. Recover signer from signature
  const recovered = ethers.utils.recoverAddress(structHash, signature);

  console.log('Expected signer:', payerAddress);
  console.log('Recovered from sig:', recovered);
  console.log('Match:', recovered.toLowerCase() === payerAddress.toLowerCase());

  // 4. Check if recovered address would pass on-chain verification
  const SignatureChecker = new ethers.Contract(
    escrowAddress,
    [
      'function isValidSignatureNow(address signer, bytes32 hash, bytes calldata sig) external view returns (bool)',
    ],
    provider
  );

  try {
    const isValid = await SignatureChecker.isValidSignatureNow(
      payerAddress,
      structHash,
      signature
    );
    console.log('On-chain verification would pass:', isValid);
  } catch (error) {
    console.error('On-chain verification would fail:', error);
  }
}
```

---

## Contact & Support

### If You Encounter Issues:

1. **Run diagnostic**: `checkEIP7702Compatibility()` and `logEIP7702Result()`
2. **Check configuration**: Verify chain ID, contract address, fee amounts
3. **Verify signature**: Use manual verification script above
4. **Check Privy status**: Confirm gas sponsorship is enabled
5. **Contact support**:
   - **Dome Team**: kunal@domeapi.com
   - **Privy Support**: https://privy.io/support

### Provide Details:

When reporting issues, include:

- Wallet address (0x...)
- EIP-7702 status (use diagnostic tool)
- Signature format (length, r/s/v values)
- Error message
- Transaction hash (if available)
- Network (Polygon mainnet vs testnet)

---

## References

- [EIP-7702 Specification](https://eips.ethereum.org/EIPS/eip-7702)
- [EIP-1271 Specification](https://eips.ethereum.org/EIPS/eip-1271)
- [Privy Documentation](https://docs.privy.io)
- [Dome Fee Escrow Guide](./ESCROW_ROUTER_QUICKSTART.md)
