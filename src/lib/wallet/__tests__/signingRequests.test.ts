import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNING_REQUEST_TTL_MS,
  MAX_SIGNING_REQUEST_TTL_MS,
  SigningRequestExpiredError,
  assertSigningRequestCurrent,
  createSigningRequest,
  describeSigningExpiry,
  getSigningExpiryReason,
  normalizeSigningRequestTtl,
} from '../signingRequests';
import type { SigningContext, SigningExpiryReason } from '../signingRequests';

const KEY_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const context = (overrides: Partial<SigningContext> = {}): SigningContext => ({
  walletConnected: true,
  walletType: 'freighter',
  walletPublicKey: KEY_A,
  network: 'testnet',
  ...overrides,
});

const T0 = 1_000_000;

describe('createSigningRequest', () => {
  it('snapshots the context so later changes to the source do not leak in', () => {
    const source = context();
    const request = createSigningRequest(source, { now: T0 });
    source.network = 'mainnet';
    expect(request.context.network).toBe('testnet');
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.context)).toBe(true);
  });

  it('gives every request a distinct id', () => {
    const a = createSigningRequest(context());
    const b = createSigningRequest(context());
    expect(a.id).not.toBe(b.id);
  });
});

describe('normalizeSigningRequestTtl', () => {
  it('keeps a valid lifetime', () => {
    expect(normalizeSigningRequestTtl(90_000)).toBe(90_000);
  });

  it('falls back to the default for missing or invalid values', () => {
    for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '60000']) {
      expect(normalizeSigningRequestTtl(bad)).toBe(DEFAULT_SIGNING_REQUEST_TTL_MS);
    }
  });

  it('caps an excessive lifetime', () => {
    expect(normalizeSigningRequestTtl(MAX_SIGNING_REQUEST_TTL_MS + 1)).toBe(MAX_SIGNING_REQUEST_TTL_MS);
    expect(normalizeSigningRequestTtl(MAX_SIGNING_REQUEST_TTL_MS)).toBe(MAX_SIGNING_REQUEST_TTL_MS);
  });
});

describe('getSigningExpiryReason', () => {
  const request = createSigningRequest(context(), { now: T0, ttlMs: 60_000 });

  it('is null while nothing has changed', () => {
    expect(getSigningExpiryReason(request, context(), T0 + 1)).toBeNull();
  });

  it.each<[string, Partial<SigningContext>, SigningExpiryReason]>([
    ['the network changes', { network: 'mainnet' }, 'network_changed'],
    ['the account changes', { walletPublicKey: KEY_B }, 'account_changed'],
    ['the account is cleared', { walletPublicKey: null }, 'account_changed'],
    ['a different wallet is connected', { walletType: 'xbull' }, 'wallet_changed'],
    ['the wallet disconnects', { walletConnected: false }, 'wallet_disconnected'],
  ])('expires when %s', (_label, change, reason) => {
    expect(getSigningExpiryReason(request, context(change), T0 + 1)).toBe(reason);
  });

  it('reports the most specific cause when several things changed', () => {
    const everything = context({
      walletConnected: false,
      walletType: 'xbull',
      walletPublicKey: KEY_B,
      network: 'mainnet',
    });
    expect(getSigningExpiryReason(request, everything, T0 + 120_000)).toBe('wallet_disconnected');
    expect(
      getSigningExpiryReason(request, context({ walletPublicKey: KEY_B, network: 'mainnet' }), T0 + 120_000),
    ).toBe('account_changed');
    expect(getSigningExpiryReason(request, context({ network: 'mainnet' }), T0 + 120_000)).toBe('network_changed');
  });

  it('stays valid one millisecond before the lifetime ends and expires at the boundary', () => {
    expect(getSigningExpiryReason(request, context(), T0 + 59_999)).toBeNull();
    expect(getSigningExpiryReason(request, context(), T0 + 60_000)).toBe('timed_out');
    expect(getSigningExpiryReason(request, context(), T0 + 600_000)).toBe('timed_out');
  });

  it('does not expire a request because the clock moved backwards', () => {
    expect(getSigningExpiryReason(request, context(), T0 - 10_000)).toBeNull();
  });

  it('treats a request created while disconnected as already expired', () => {
    const offline = createSigningRequest(context({ walletConnected: false }), { now: T0 });
    expect(getSigningExpiryReason(offline, context({ walletConnected: false }), T0)).toBe('wallet_disconnected');
  });
});

describe('assertSigningRequestCurrent', () => {
  const request = createSigningRequest(context(), { now: T0, ttlMs: 60_000 });

  it('returns quietly for a current request', () => {
    expect(() => assertSigningRequestCurrent(request, context(), T0 + 1)).not.toThrow();
  });

  it('throws a typed error carrying the reason and request id', () => {
    let caught: unknown;
    try {
      assertSigningRequestCurrent(request, context({ network: 'mainnet' }), T0 + 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SigningRequestExpiredError);
    const expired = caught as SigningRequestExpiredError;
    expect(expired.reason).toBe('network_changed');
    expect(expired.requestId).toBe(request.id);
    expect(expired.message).toBe(describeSigningExpiry('network_changed'));
  });
});

describe('describeSigningExpiry', () => {
  it('has a distinct, actionable message for every reason', () => {
    const reasons: SigningExpiryReason[] = [
      'wallet_disconnected',
      'wallet_changed',
      'account_changed',
      'network_changed',
      'timed_out',
    ];
    const messages = reasons.map(describeSigningExpiry);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message).toMatch(/cancelled/);
  });
});
