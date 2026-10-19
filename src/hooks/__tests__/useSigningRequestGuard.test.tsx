import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSigningRequestGuard } from '../useSigningRequestGuard';
import type { UseSigningRequestGuardOptions } from '../useSigningRequestGuard';
import type { SigningContext } from '../../lib/wallet/signingRequests';

const KEY_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const base: SigningContext = {
  walletConnected: true,
  walletType: 'freighter',
  walletPublicKey: KEY_A,
  network: 'testnet',
};

function setup(options: UseSigningRequestGuardOptions = {}, initial: SigningContext = base) {
  return renderHook(
    ({ context }: { context: SigningContext }) => useSigningRequestGuard(context, options),
    { initialProps: { context: initial } },
  );
}

describe('useSigningRequestGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a request valid across re-renders with an unchanged context', () => {
    const onExpire = vi.fn();
    const { result, rerender } = setup({ onExpire });

    let request!: ReturnType<typeof result.current.begin>;
    act(() => {
      request = result.current.begin(base);
    });
    expect(request).not.toBeNull();

    rerender({ context: { ...base } }); // same values, new object
    expect(result.current.getActive()).toBe(request);
    expect(result.current.notice).toBeNull();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it.each([
    ['network', { network: 'mainnet' }, 'network_changed'],
    ['account', { walletPublicKey: KEY_B }, 'account_changed'],
    ['wallet', { walletType: 'xbull' }, 'wallet_changed'],
    ['connection', { walletConnected: false }, 'wallet_disconnected'],
  ])('expires the pending request when the %s changes', (_label, change, reason) => {
    const onExpire = vi.fn();
    const { result, rerender } = setup({ onExpire });
    act(() => {
      result.current.begin(base);
    });

    rerender({ context: { ...base, ...change } });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0][0]).toMatchObject({ reason });
    expect(result.current.notice?.reason).toBe(reason);
    expect(result.current.getActive()).toBeNull();
  });

  it('expires immediately when begun from a snapshot the live context has left behind', () => {
    const onExpire = vi.fn();
    const { result } = setup({ onExpire }, { ...base, network: 'mainnet' });

    let request: ReturnType<typeof result.current.begin> = null;
    act(() => {
      request = result.current.begin(base); // user acted while on testnet
    });

    expect(request).toBeNull();
    expect(result.current.notice?.reason).toBe('network_changed');
    expect(result.current.getActive()).toBeNull();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('expires after the lifetime and not a moment before', () => {
    const onExpire = vi.fn();
    const { result } = setup({ ttlMs: 10_000, onExpire });
    act(() => {
      result.current.begin(base);
    });

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(onExpire).not.toHaveBeenCalled();
    expect(result.current.getActive()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(result.current.notice?.reason).toBe('timed_out');
  });

  it('does not expire a request that was ended, even after its lifetime', () => {
    const onExpire = vi.fn();
    const { result } = setup({ ttlMs: 10_000, onExpire });
    act(() => {
      result.current.begin(base);
      result.current.end();
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onExpire).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
  });

  it('reports a stale request once however many times it is checked', () => {
    const onExpire = vi.fn();
    const { result, rerender } = setup({ onExpire });
    let request!: NonNullable<ReturnType<typeof result.current.begin>>;
    act(() => {
      request = result.current.begin(base)!;
    });

    rerender({ context: { ...base, network: 'mainnet' } });
    act(() => {
      expect(result.current.ensureCurrent(request)).toBe(false);
      expect(result.current.ensureCurrent(request)).toBe(false);
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('answers ensureCurrent from the live context, not the render it was created in', () => {
    const { result, rerender } = setup();
    let request!: NonNullable<ReturnType<typeof result.current.begin>>;
    act(() => {
      request = result.current.begin(base)!;
    });
    const staleEnsure = result.current.ensureCurrent; // captured before the change

    rerender({ context: { ...base, walletPublicKey: KEY_B } });

    act(() => {
      expect(staleEnsure(request)).toBe(false);
    });
  });

  it('clears the previous notice when a new request begins', () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.begin(base);
    });
    rerender({ context: { ...base, network: 'mainnet' } });
    expect(result.current.notice).not.toBeNull();

    act(() => {
      result.current.begin({ ...base, network: 'mainnet' });
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.getActive()).not.toBeNull();
  });

  it('lets the user dismiss the notice', () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.begin(base);
    });
    rerender({ context: { ...base, network: 'mainnet' } });

    act(() => {
      result.current.dismissNotice();
    });
    expect(result.current.notice).toBeNull();
  });

  it('stops its timer on unmount', () => {
    const onExpire = vi.fn();
    const { result, unmount } = setup({ ttlMs: 10_000, onExpire });
    act(() => {
      result.current.begin(base);
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});
