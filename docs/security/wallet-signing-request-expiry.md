# Pending Signature Request Expiry

A signature request is only meaningful for the wallet, account and network the user was looking at when they started it. If any of those change before the wallet is asked to sign, the review and confirmation the user went through no longer describe what would be signed. The dashboard cancels such a request and asks the user to start again (#1190).

## Behaviour

A request begins when the user confirms the sign action in **Transaction Signer** (after the mainnet write guard, if it applies). It is bound to a snapshot of:

| Bound value | Changes when |
|-------------|--------------|
| Wallet connection | The wallet disconnects, locks or is revoked |
| Wallet type | A different wallet is connected |
| Account (public key) | The active account changes |
| Network | The dashboard network changes, including a Freighter network switch the dashboard follows |

The request is cancelled as soon as the live state differs from the snapshot, or when its lifetime ends. Cancelling:

1. closes the confirmation panel, biometric overlay and risk-review panel;
2. stops any delayed step (the biometric auto-proceed) so it cannot fire later;
3. shows an alert explaining the cause, with a **Dismiss** button;
4. records a `wallet.sign.rejected` security event (see below).

| Reason | Shown when |
|--------|------------|
| `wallet_disconnected` | The wallet is no longer connected |
| `wallet_changed` | A different wallet is now connected |
| `account_changed` | The active account differs |
| `network_changed` | The network differs |
| `timed_out` | The request outlived its lifetime |

If several apply at once, the most specific cause wins, in the order above.

### While the wallet prompt is open

The wallet extension or device cannot be told to abandon a prompt that is already showing, so a signature can arrive after the context changed. The dashboard checks again when the wallet returns and **discards** that signature: it is not shown, not copyable, and not recorded against the behavioural profile. A wallet error that arrives after an expiry is suppressed so the user sees one cause, not two.

### Lifetime

A request lasts **5 minutes** (`DEFAULT_SIGNING_REQUEST_TTL_MS`). It expires at the boundary: at exactly 5 minutes it is already expired. Lifetimes passed in code are validated by `normalizeSigningRequestTtl`:

| Input | Result |
|-------|--------|
| Positive finite number up to 30 minutes | Used as-is |
| Above 30 minutes | Capped at 30 minutes |
| `0`, negative, `NaN`, `Infinity`, non-number, missing | Falls back to the 5-minute default |

Invalid configuration fails safe: it can never produce a request that does not expire.

### Requests that end without expiring

A request that finishes (signed, wallet error) or is cancelled by the user (**Cancel** on the confirmation panel or biometric overlay) is ended and never reports an expiry. A flow that halts before the wallet is asked also ends its request.

## Audit trail

Each expiry records one `wallet.sign.rejected` event through `trackSecurityEvent` with `outcome: 'denied'`, the signer public key as `actor`, the network as `target`, and metadata `{ reason, requestId, walletType }`. The event never contains the transaction XDR, a signature, or any key material. A failure to record the event is swallowed; it never interferes with the signing UI.

## Accessibility

The notice is rendered with `role="alert"` so screen readers announce it when it appears, and its **Dismiss** control is a native button reachable by keyboard.

## Where it lives

- `src/lib/wallet/signingRequests.ts`: framework-free rules (snapshot, expiry reason, lifetime, typed error).
- `src/hooks/useSigningRequestGuard.ts`: binds a request to the live wallet state and owns the lifetime timer.
- `src/components/security/SigningExpiryNotice.tsx`: the accessible notice.
- `src/components/dashboard/TransactionSigner.tsx`: starts, checks and ends the request.

## Scope and limits

- **Transaction Signer only.** The multisig co-signing flow (`SignatureCollector`) signs with a pasted key against the network stored on the session, not the connected wallet, so wallet/network changes do not apply to it.
- **Stored multisig sessions are not expired.** Their `network` is persisted by design and independent of the dashboard network.
- **Per tab.** Each tab tracks its own requests.
- **No effect on the wallet.** Cancelling does not close an open extension popup or a Ledger prompt; it only ensures the result is not used.
- **A window of one render.** The live context is read from the latest render, so a change is seen once the dashboard has re-rendered with it. The wallet adapter's own network check (`requireSigningNetwork`) remains the last line of defence at signing time.

## Tests

- `src/lib/wallet/__tests__/signingRequests.test.ts`: snapshotting, every expiry reason and their precedence, the lifetime boundary, invalid lifetimes, the typed error.
- `src/hooks/__tests__/useSigningRequestGuard.test.tsx`: expiry on each context change, the stale-snapshot case, timer boundary, report-once, cleanup on unmount.
- `tests/integration/TransactionSigner.requestExpiry.test.jsx`: the signer end to end: happy path, expiry during confirmation, during the wallet prompt and during the biometric delay, user cancel, recovery, audit contents.
