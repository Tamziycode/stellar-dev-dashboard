/**
 * Pending signature request expiry (#1190).
 *
 * A signature request is bound to the wallet, account and network that were
 * active when the user started it. If any of those change before the wallet
 * has been asked to sign, the review the user saw (and any confirmation they
 * gave) no longer describes what would be signed, so the request is expired
 * and the flow has to be restarted. A request also expires after a fixed
 * lifetime so an abandoned confirmation cannot be completed much later.
 *
 * This module is framework-free: it does not import the store or React, so it
 * can be unit-tested directly and reused by any signing surface. The React
 * wiring lives in `src/hooks/useSigningRequestGuard.ts`.
 */

/** The wallet state a request is bound to. */
export interface SigningContext {
  walletConnected: boolean
  walletType: string | null
  walletPublicKey: string | null
  network: string
}

export type SigningExpiryReason =
  | 'wallet_disconnected'
  | 'wallet_changed'
  | 'account_changed'
  | 'network_changed'
  | 'timed_out'

export interface SigningRequest {
  readonly id: string
  /** Snapshot of the context at creation. Never mutated. */
  readonly context: Readonly<SigningContext>
  readonly createdAt: number
  readonly ttlMs: number
}

/** How long a request stays valid when no lifetime is given. */
export const DEFAULT_SIGNING_REQUEST_TTL_MS = 5 * 60_000
/** Upper bound; larger or invalid values fall back to the default / cap. */
export const MAX_SIGNING_REQUEST_TTL_MS = 30 * 60_000

let requestSequence = 0

/** Clamp a configured lifetime into a safe, positive range. */
export function normalizeSigningRequestTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_SIGNING_REQUEST_TTL_MS
  }
  return Math.min(ttlMs, MAX_SIGNING_REQUEST_TTL_MS)
}

export function createSigningRequest(
  context: SigningContext,
  options: { ttlMs?: number; now?: number } = {},
): SigningRequest {
  requestSequence += 1
  return Object.freeze({
    id: `signing-request-${requestSequence}`,
    context: Object.freeze({ ...context }),
    createdAt: options.now ?? Date.now(),
    ttlMs: normalizeSigningRequestTtl(options.ttlMs),
  })
}

/**
 * Why `request` is no longer valid against the `current` wallet state, or
 * `null` when it still is. Context changes outrank the timeout so the user is
 * told the most specific cause. A request expires once `ttlMs` has elapsed
 * (the boundary instant is already expired).
 */
export function getSigningExpiryReason(
  request: SigningRequest,
  current: SigningContext,
  now: number = Date.now(),
): SigningExpiryReason | null {
  const bound = request.context
  if (!current.walletConnected) return 'wallet_disconnected'
  if (current.walletType !== bound.walletType) return 'wallet_changed'
  if (current.walletPublicKey !== bound.walletPublicKey) return 'account_changed'
  if (current.network !== bound.network) return 'network_changed'
  if (now - request.createdAt >= request.ttlMs) return 'timed_out'
  return null
}

/** Plain-language explanation shown to the user. Contains no key material. */
export function describeSigningExpiry(reason: SigningExpiryReason): string {
  switch (reason) {
    case 'wallet_disconnected':
      return 'The wallet was disconnected, so the pending signature request was cancelled. Reconnect your wallet and start again.'
    case 'wallet_changed':
      return 'The connected wallet changed, so the pending signature request was cancelled. Review the transaction and start again.'
    case 'account_changed':
      return 'The active account changed, so the pending signature request was cancelled. Review the transaction and start again.'
    case 'network_changed':
      return 'The network changed, so the pending signature request was cancelled. Review the transaction and start again.'
    case 'timed_out':
      return 'The signature request timed out and was cancelled. Review the transaction and start again.'
  }
}

export class SigningRequestExpiredError extends Error {
  readonly reason: SigningExpiryReason
  readonly requestId: string

  constructor(request: SigningRequest, reason: SigningExpiryReason) {
    super(describeSigningExpiry(reason))
    this.name = 'SigningRequestExpiredError'
    this.reason = reason
    this.requestId = request.id
  }
}

/** Throws `SigningRequestExpiredError` unless `request` is still current. */
export function assertSigningRequestCurrent(
  request: SigningRequest,
  current: SigningContext,
  now: number = Date.now(),
): void {
  const reason = getSigningExpiryReason(request, current, now)
  if (reason) throw new SigningRequestExpiredError(request, reason)
}
