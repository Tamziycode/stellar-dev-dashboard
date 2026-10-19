import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as Sdk from '@stellar/stellar-sdk';

/**
 * #1190 — pending signature requests expire when the wallet, account or
 * network changes underneath them, or when they sit too long.
 */

const mockSign = vi.fn();
const mockTrack = vi.fn();
const mockBioAbort = vi.fn();

let storeState;
let preferences;
let bio;

vi.mock('../../src/lib/store', () => ({
  useStore: () => storeState,
}));

vi.mock('../../src/lib/wallet/adapters', () => ({
  getWalletAdapter: () => ({ signTransaction: (...args) => mockSign(...args) }),
}));

vi.mock('../../src/lib/securityEvents', () => ({
  SecurityEventType: { WALLET_SIGN_REJECTED: 'wallet.sign.rejected' },
  trackSecurityEvent: (...args) => mockTrack(...args),
}));

vi.mock('../../src/lib/storage', () => ({
  getStoredValue: vi.fn().mockResolvedValue([]),
  setStoredValue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/userPreferences', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadPreferences: () => Promise.resolve(preferences) };
});

vi.mock('../../src/hooks/useBehavioralBiometrics', () => ({
  useBehavioralBiometrics: () => bio,
}));

vi.mock('../../src/components/biometrics/BiometricAuthOverlay', () => ({
  default: () => <div data-testid="bio-overlay" />,
}));

// The real panel has its own cooldown/email flow; only its confirm/cancel
// contract matters to the signer's request handling.
vi.mock('../../src/components/security/EnhancedTransactionConfirmation', () => ({
  default: ({ onConfirm, onCancel }) => (
    <div data-testid="confirmation-panel">
      <button onClick={onConfirm}>Confirm signing</button>
      <button onClick={onCancel}>Cancel signing</button>
    </div>
  ),
}));

const { DEFAULT_PREFERENCES } = await vi.importActual('../../src/lib/userPreferences');
const TransactionSigner = (await import('../../src/components/dashboard/TransactionSigner')).default;

const KEY_A = Sdk.Keypair.random().publicKey();
const KEY_B = Sdk.Keypair.random().publicKey();

const XDR = new Sdk.TransactionBuilder(new Sdk.Account(KEY_A, '100'), {
  fee: Sdk.BASE_FEE,
  networkPassphrase: Sdk.Networks.TESTNET,
})
  .addOperation(Sdk.Operation.payment({ destination: KEY_B, asset: Sdk.Asset.native(), amount: '1' }))
  .setTimeout(300)
  .build()
  .toXDR();

const baseState = () => ({
  walletConnected: true,
  walletType: 'freighter',
  walletPublicKey: KEY_A,
  network: 'testnet',
  accountData: null,
});

const flush = () => act(async () => {});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render and wait for the async preference load, as the real app would have. */
async function renderSigner() {
  const view = render(<TransactionSigner />);
  await flush();
  return view;
}

async function startSigning() {
  fireEvent.change(screen.getByPlaceholderText(/paste the unsigned transaction xdr/i), {
    target: { value: XDR },
  });
  fireEvent.click(screen.getByRole('button', { name: /sign transaction/i }));
  await flush();
}

/** Change the live wallet state and re-render, as a store update would. */
async function changeWallet(view, change) {
  storeState = { ...storeState, ...change };
  view.rerender(<TransactionSigner />);
  await flush();
}

describe('TransactionSigner — pending signature request expiry (#1190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = baseState();
    preferences = {
      ...DEFAULT_PREFERENCES,
      transactionConfirmation: { ...DEFAULT_PREFERENCES.transactionConfirmation, enabled: false },
    };
    bio = {
      enabled: false,
      strictMode: false,
      isEstablished: false,
      authStatus: 'idle',
      profile: null,
      lastAnomalyResult: null,
      samplesNeeded: 0,
      startCollection: vi.fn(),
      evaluateAndRecord: vi.fn().mockResolvedValue(null),
      recordSuccessfulSign: vi.fn().mockResolvedValue(undefined),
      abort: mockBioAbort,
    };
    mockSign.mockResolvedValue('SIGNED_XDR');
    mockTrack.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy path', () => {
    it('signs with the context the request was started in', async () => {
      await renderSigner();
      await startSigning();

      expect(mockSign).toHaveBeenCalledTimes(1);
      expect(mockSign).toHaveBeenCalledWith(XDR, 'testnet');
      expect(screen.getByText('SIGNED_XDR')).toBeInTheDocument();
      expect(screen.queryByTestId('signing-expiry-notice')).toBeNull();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('still completes after a confirmation step when nothing changed', async () => {
      preferences.transactionConfirmation.enabled = true;
      const view = await renderSigner();
      await startSigning();
      expect(screen.getByTestId('confirmation-panel')).toBeInTheDocument();

      // Boundary: a store update that leaves the wallet context untouched.
      await changeWallet(view, { accountData: { id: KEY_A } });
      expect(screen.getByTestId('confirmation-panel')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /confirm signing/i }));
      await flush();
      expect(mockSign).toHaveBeenCalledWith(XDR, 'testnet');
    });
  });

  describe('expiry while a confirmation is pending', () => {
    beforeEach(() => {
      preferences.transactionConfirmation.enabled = true;
    });

    it.each([
      ['the network changes', { network: 'futurenet' }, 'network_changed', /network changed/i],
      ['the account changes', { walletPublicKey: KEY_B }, 'account_changed', /account changed/i],
      ['a different wallet connects', { walletType: 'xbull' }, 'wallet_changed', /wallet changed/i],
    ])('cancels the request when %s', async (_label, change, reason, message) => {
      const view = await renderSigner();
      await startSigning();
      expect(screen.getByTestId('confirmation-panel')).toBeInTheDocument();

      await changeWallet(view, change);

      expect(screen.queryByTestId('confirmation-panel')).toBeNull();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-reason', reason);
      expect(alert).toHaveTextContent(message);
      expect(mockSign).not.toHaveBeenCalled();
      expect(mockBioAbort).toHaveBeenCalled();
    });

    it('tells the user when the wallet disconnects', async () => {
      const view = await renderSigner();
      await startSigning();

      await changeWallet(view, { walletConnected: false, walletType: null, walletPublicKey: null });

      expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'wallet_disconnected');
      expect(screen.getByText(/connect a wallet to sign/i)).toBeInTheDocument();
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('expires after the lifetime if the confirmation is left open', async () => {
      vi.useFakeTimers();
      await renderSigner();
      await startSigning();
      expect(screen.getByTestId('confirmation-panel')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      });
      expect(screen.getByTestId('confirmation-panel')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByTestId('confirmation-panel')).toBeNull();
      expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'timed_out');
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('does not report an expiry for a request the user cancelled', async () => {
      vi.useFakeTimers();
      await renderSigner();
      await startSigning();

      fireEvent.click(screen.getByRole('button', { name: /cancel signing/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });

      expect(screen.queryByRole('alert')).toBeNull();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('lets the user dismiss the notice and start again in the new context', async () => {
      const view = await renderSigner();
      await startSigning();
      await changeWallet(view, { network: 'futurenet' });
      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /dismiss/i }));
      expect(screen.queryByRole('alert')).toBeNull();

      preferences.transactionConfirmation.enabled = false;
      await startSigning();

      expect(mockSign).toHaveBeenCalledWith(XDR, 'futurenet');
      expect(screen.getByText('SIGNED_XDR')).toBeInTheDocument();
    });
  });

  describe('expiry while the wallet prompt is open', () => {
    it('discards a signature produced after the network changed', async () => {
      const pending = deferred();
      mockSign.mockReturnValue(pending.promise);
      const view = await renderSigner();
      await startSigning();
      expect(mockSign).toHaveBeenCalledTimes(1);

      await changeWallet(view, { network: 'futurenet' });
      await act(async () => {
        pending.resolve('SIGNED_XDR');
      });

      expect(screen.queryByText('SIGNED_XDR')).toBeNull();
      expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'network_changed');
    });

    it('does not pile a wallet error on top of the expiry notice', async () => {
      const pending = deferred();
      mockSign.mockReturnValue(pending.promise);
      const view = await renderSigner();
      await startSigning();

      await changeWallet(view, { walletPublicKey: KEY_B });
      await act(async () => {
        pending.reject(new Error('Freighter rejected the request'));
      });

      expect(screen.queryByText(/freighter rejected/i)).toBeNull();
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });

    it('still reports an ordinary wallet error when nothing changed', async () => {
      mockSign.mockRejectedValue(new Error('User declined access'));
      await renderSigner();
      await startSigning();

      expect(screen.getByText(/user declined access/i)).toBeInTheDocument();
      expect(screen.queryByTestId('signing-expiry-notice')).toBeNull();
    });
  });

  describe('flows that stop before the wallet is asked', () => {
    it('leaves no timeout notice behind when the mainnet review step halts the flow', async () => {
      // On mainnet `_proceedToSign` stops at the review step without reaching
      // the wallet. The request it began must end there, not linger until its
      // lifetime runs out and then report a timeout nobody can act on.
      vi.useFakeTimers();
      storeState = { ...storeState, network: 'mainnet' };
      await renderSigner();
      fireEvent.change(screen.getByPlaceholderText(/paste the unsigned transaction xdr/i), {
        target: { value: XDR },
      });
      fireEvent.click(screen.getByRole('button', { name: /sign transaction/i }));
      await flush();
      fireEvent.change(screen.getByPlaceholderText('mainnet'), { target: { value: 'mainnet' } });
      fireEvent.click(screen.getByRole('button', { name: /confirm write/i }));
      await flush();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });

      expect(screen.queryByRole('alert')).toBeNull();
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });

  describe('delayed biometric proceed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      bio = {
        ...bio,
        enabled: true,
        isEstablished: true,
        evaluateAndRecord: vi.fn().mockResolvedValue({ isAnomaly: false }),
      };
    });

    it('proceeds to sign once the check has passed and nothing changed', async () => {
      await renderSigner();
      await startSigning();
      expect(screen.getByTestId('bio-overlay')).toBeInTheDocument();
      expect(mockSign).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(mockSign).toHaveBeenCalledWith(XDR, 'testnet');
    });

    it('does not auto-proceed if the network changed during the check', async () => {
      const view = await renderSigner();
      await startSigning();

      await changeWallet(view, { network: 'futurenet' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockSign).not.toHaveBeenCalled();
      expect(screen.queryByTestId('bio-overlay')).toBeNull();
      expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'network_changed');
    });

    it('cancels the delayed step when the component unmounts', async () => {
      const view = await renderSigner();
      await startSigning();

      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockSign).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    it('records the reason and ids but never the transaction', async () => {
      preferences.transactionConfirmation.enabled = true;
      const view = await renderSigner();
      await startSigning();
      await changeWallet(view, { network: 'futurenet' });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const [eventType, options] = mockTrack.mock.calls[0];
      expect(eventType).toBe('wallet.sign.rejected');
      expect(options).toMatchObject({
        actor: KEY_A,
        target: 'testnet',
        outcome: 'denied',
        metadata: { reason: 'network_changed', walletType: 'freighter' },
      });
      expect(JSON.stringify(options)).not.toContain(XDR);
    });

    it('keeps working when the audit sink throws', async () => {
      preferences.transactionConfirmation.enabled = true;
      mockTrack.mockImplementation(() => {
        throw new Error('audit unavailable');
      });
      const view = await renderSigner();
      await startSigning();
      await changeWallet(view, { network: 'futurenet' });

      expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'network_changed');
    });
  });
});
