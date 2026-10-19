import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createSigningRequest,
  describeSigningExpiry,
  getSigningExpiryReason,
} from '../lib/wallet/signingRequests'
import type {
  SigningContext,
  SigningExpiryReason,
  SigningRequest,
} from '../lib/wallet/signingRequests'

export interface SigningExpiryNotice {
  requestId: string
  reason: SigningExpiryReason
  message: string
}

export interface UseSigningRequestGuardOptions {
  /** Request lifetime in ms. Defaults to DEFAULT_SIGNING_REQUEST_TTL_MS. */
  ttlMs?: number
  /**
   * Called once when a request expires, so the caller can tear down its own
   * pending UI. Receives the expired request and the notice shown to the user.
   */
  onExpire?: (_notice: SigningExpiryNotice, _request: SigningRequest) => void
}

export interface SigningRequestGuard {
  /**
   * Start a request bound to `snapshot`, replacing any active one. Pass the
   * context from the render in which the user acted: if the live context has
   * already moved on (for example a confirmation dialog stayed open while the
   * network changed) the request expires immediately and `null` is returned.
   */
  begin: (_snapshot: SigningContext) => SigningRequest | null
  /** The request that has started and neither ended nor expired. */
  getActive: () => SigningRequest | null
  /**
   * `true` while `request` is still valid against the live wallet state. When
   * it is not, the request is expired (once) and `false` is returned: callers
   * must stop and must not hand the transaction to the wallet.
   */
  ensureCurrent: (_request: SigningRequest) => boolean
  /** The request finished or was cancelled by the user. No notice is shown. */
  end: () => void
  notice: SigningExpiryNotice | null
  dismissNotice: () => void
}

/**
 * Expire pending signature requests when the wallet, account or network
 * changes, or when the request outlives its lifetime (#1190).
 *
 * `context` must be the live wallet state from the current render.
 */
export function useSigningRequestGuard(
  context: SigningContext,
  options: UseSigningRequestGuardOptions = {},
): SigningRequestGuard {
  const { walletConnected, walletType, walletPublicKey, network } = context

  // Handlers run after the render that produced the latest state, so reading
  // the context from a ref gives them the live value instead of the stale one
  // captured by the closure they were created in.
  const contextRef = useRef<SigningContext>(context)
  contextRef.current = context
  const onExpireRef = useRef(options.onExpire)
  onExpireRef.current = options.onExpire
  const ttlRef = useRef(options.ttlMs)
  ttlRef.current = options.ttlMs

  const activeRef = useRef<SigningRequest | null>(null)
  const reportedRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notice, setNotice] = useState<SigningExpiryNotice | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const end = useCallback(() => {
    clearTimer()
    activeRef.current = null
  }, [clearTimer])

  const ensureCurrent = useCallback(
    (request: SigningRequest): boolean => {
      const reason = getSigningExpiryReason(request, contextRef.current)
      if (!reason) return true

      // Report each request once, however many checks notice it is stale.
      if (reportedRef.current !== request.id) {
        reportedRef.current = request.id
        if (activeRef.current?.id === request.id) {
          clearTimer()
          activeRef.current = null
        }
        const expiry: SigningExpiryNotice = {
          requestId: request.id,
          reason,
          message: describeSigningExpiry(reason),
        }
        setNotice(expiry)
        onExpireRef.current?.(expiry, request)
      }
      return false
    },
    [clearTimer],
  )

  const begin = useCallback(
    (snapshot: SigningContext): SigningRequest | null => {
      clearTimer()
      setNotice(null)
      const request = createSigningRequest(snapshot, { ttlMs: ttlRef.current })
      activeRef.current = request
      if (!ensureCurrent(request)) return null
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        ensureCurrent(request)
      }, request.ttlMs)
      return request
    },
    [clearTimer, ensureCurrent],
  )

  const getActive = useCallback(() => activeRef.current, [])
  const dismissNotice = useCallback(() => setNotice(null), [])

  // A change in the live context expires the pending request right away,
  // without waiting for the next user action.
  useEffect(() => {
    const active = activeRef.current
    if (active) ensureCurrent(active)
  }, [walletConnected, walletType, walletPublicKey, network, ensureCurrent])

  useEffect(() => end, [end])

  return { begin, getActive, ensureCurrent, end, notice, dismissNotice }
}
