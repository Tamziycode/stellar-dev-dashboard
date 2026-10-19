import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { useStore } from '../../lib/store';
import { getWalletAdapter } from '../../lib/wallet/adapters';
import { NETWORKS } from '../../lib/stellar';
import { measureAsync } from '../../lib/performanceMonitoring';
import { loadPreferences, DEFAULT_PREFERENCES } from '../../lib/userPreferences';
import type { UserPreferences } from '../../lib/userPreferences';
import Card from './Card';
import EnhancedTransactionConfirmation from '../security/EnhancedTransactionConfirmation';
import RiskSummaryPanel from '../security/RiskSummaryPanel';
import {
  usePreSignRiskSummary,
  REVIEW_SHOWN,
  REVIEW_ERROR,
} from '../../hooks/usePreSignRiskSummary';
import BiometricAuthOverlay from '../biometrics/BiometricAuthOverlay';
import MainnetConfirmDialog from '../security/MainnetConfirmDialog';
import { useBehavioralBiometrics } from '../../hooks/useBehavioralBiometrics';
import { useWriteGuard } from '../../hooks/useWriteGuard';
import { inspectEnvelope } from '../../utils/feeBumpInspector';
import type { EnvelopeInfo } from '../../utils/feeBumpInspector';
import { setCriticalSigningActive } from '../../utils/offline';
import { useSigningRequestGuard } from '../../hooks/useSigningRequestGuard';
import type { SigningExpiryNotice as SigningExpiryNoticeData } from '../../hooks/useSigningRequestGuard';
import type { SigningRequest } from '../../lib/wallet/signingRequests';
import SigningExpiryNotice from '../security/SigningExpiryNotice';
import { trackSecurityEvent, SecurityEventType } from '../../lib/securityEvents';
import type { NetworkName } from '../../lib/stellar';

interface MainnetReviewItem {
  label: string;
  value: string;
  highlight?: boolean;
  mono?: boolean;
}

/**
 * Record that a pending signature request was cancelled (#1190). Carries the
 * reason and ids only, never the transaction or any key material, and must
 * never break the signing UI.
 */
function recordSigningExpiry(notice: SigningExpiryNoticeData, request: SigningRequest): void {
  try {
    void Promise.resolve(
      trackSecurityEvent(SecurityEventType.WALLET_SIGN_REJECTED, {
        actor: request.context.walletPublicKey ?? undefined,
        target: request.context.network,
        outcome: 'denied',
        metadata: {
          reason: notice.reason,
          requestId: notice.requestId,
          walletType: request.context.walletType,
        },
      })
    ).catch(() => {});
  } catch {
    /* auditing must never interfere with signing */
  }
}

export default function TransactionSigner() {
  const { walletConnected, walletType, walletPublicKey, network } = useStore();
  const [xdr, setXdr] = useState('');
  const [envelopeInfo, setEnvelopeInfo] = useState<EnvelopeInfo | null>(null);
  const [signedXdr, setSignedXdr] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ledgerPrompt, setLedgerPrompt] = useState(false);
  const [showMainnetReview, setShowMainnetReview] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  // #983 — mainnet write guard
  const { guard, isReadOnlyLocked, dialogProps } = useWriteGuard();
  const [showBiometricOverlay, setShowBiometricOverlay] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);

  // #982 — pre-sign risk review.
  const {
    summary: riskSummary,
    reviewError: riskReviewError,
    onTrustContract: trustRiskContract,
    beginReview: beginRiskReview,
    cancelReview: cancelRiskReview,
    onAcknowledged: acknowledgeRiskReview,
  } = usePreSignRiskSummary();

  // The envelope that was actually summarised. Held in a ref rather than read
  // back from `xdr`, because the field stays editable while the review panel is
  // open and signing whatever it holds then would slip past the review.
  const reviewedXdrRef = useRef<string | null>(null);

  // ─── Behavioral Biometrics ─────────────────────────────────────────────────
  const bio = useBehavioralBiometrics(walletPublicKey);

  // ─── Pending signature request expiry (#1190) ──────────────────────────────
  // Delayed flow steps (biometric auto-proceed) are tracked so they can be
  // cancelled when the request expires or the component unmounts.
  const flowTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const clearFlowTimers = () => {
    flowTimersRef.current.forEach((id) => clearTimeout(id));
    flowTimersRef.current.clear();
  };
  useEffect(() => {
    const timers = flowTimersRef.current;
    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  const signingGuard = useSigningRequestGuard(
    { walletConnected, walletType, walletPublicKey, network },
    {
      onExpire: (notice, request) => {
        clearFlowTimers();
        setShowBiometricOverlay(false);
        setShowMainnetReview(false);
        setShowConfirmation(false);
        cancelRiskReview();
        bio.abort();
        recordSigningExpiry(notice, request);
      },
    }
  );

  const scheduleFlowStep = (request: SigningRequest, delayMs: number, step: () => void) => {
    const id = setTimeout(() => {
      flowTimersRef.current.delete(id);
      if (!signingGuard.ensureCurrent(request)) return;
      step();
    }, delayMs);
    flowTimersRef.current.add(id);
  };

  const [accountInfo, setAccountInfo] = useState<any>(null);

  useEffect(() => {
    async function fetchPreferences() {
      const prefs = await loadPreferences();
      setPreferences(prefs);
    }
    fetchPreferences();
  }, []);

  // Start collecting behavior as soon as user interacts with the XDR textarea
  const handleXdrChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setXdr(value);
      setSignedXdr(null);
      setError(null);

      // Parse envelope on every keystroke so we can show inner-tx details immediately.
      if (value.trim()) {
        const result = inspectEnvelope(value.trim(), network);
        setEnvelopeInfo(result.ok ? result.envelope : null);
      } else {
        setEnvelopeInfo(null);
      }

      if (bio.enabled && !bio.authStatus.match(/collecting|evaluating/)) {
        bio.startCollection();
      }
    },
    [bio, network]
  );

  // networkPassphrase
  const networkPassphrase = NETWORKS[network]?.passphrase ?? NETWORKS.testnet.passphrase;
  const handleSign = async () => {
    if (!xdr.trim()) {
      setError('Please enter a transaction XDR to sign');
      return;
    }
    // #983 — route through central write guard; it handles mainnet confirmation
    // and session read-only lock before proceeding to the biometric/confirmation flow.
    guard({ action: 'sign & submit transaction', onConfirm: _runSignFlow });
  };

  const _runSignFlow = async () => {
    // #1190 — bind the request to the wallet/account/network the user acted
    // on. If the context already moved on (e.g. the mainnet confirmation
    // dialog stayed open while the network changed) this expires immediately.
    const request = signingGuard.begin({ walletConnected, walletType, walletPublicKey, network });
    if (!request) return;

    if (bio.enabled && bio.isEstablished) {
      const result = await bio.evaluateAndRecord();
      if (!signingGuard.ensureCurrent(request)) return;
      if (result) {
        setShowBiometricOverlay(true);
        // For strict mode anomalies, stop here — overlay handles cancel
        if (result.isAnomaly && bio.strictMode) return;
        // For non-anomaly or warn mode, overlay will call onDismiss/onProceedAnyway
        if (!result.isAnomaly) {
          // Auto-dismiss quickly for a passed check — show briefly then proceed
          scheduleFlowStep(request, 1200, () => {
            setShowBiometricOverlay(false);
            _proceedToSign();
          });
          return;
        }
        // Anomaly in warn mode: wait for user action via overlay
        return;
      }
    } else if (bio.enabled && !bio.isEstablished) {
      // Learning mode: still evaluate (returns learning result) and show briefly
      const result = await bio.evaluateAndRecord();
      if (!signingGuard.ensureCurrent(request)) return;
      if (result) {
        setShowBiometricOverlay(true);
        scheduleFlowStep(request, 1500, () => {
          setShowBiometricOverlay(false);
          _proceedToSign();
        });
        return;
      }
    }

    await _proceedToSign();
  };

  const _proceedToSign = async () => {
    // #1190 — a request that expired (or was never started) must not continue.
    const pending = signingGuard.getActive();
    if (!pending || !signingGuard.ensureCurrent(pending)) return;
    // On Mainnet, show the explicit review step before confirmation/signing
    if (network === 'mainnet' && !showMainnetReview) {
      setShowMainnetReview(true);
      // This step halts the flow without asking the wallet, so the request is
      // finished rather than left to raise a timeout notice later (#1190).
      signingGuard.end();
      return;
    }
    if (preferences.transactionConfirmation.enabled) {
      setShowConfirmation(true);
      return;
    }
    await doSign();
  };

  const _buildMainnetReviewItems = (): MainnetReviewItem[] => {
    const items: MainnetReviewItem[] = [];
    try {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr.trim(), networkPassphrase) as any;
      const source: string = tx.source || tx.sourceAccount?.accountId?.() || '—';
      items.push({ label: 'Network', value: 'Mainnet (Public)', highlight: true });
      items.push({
        label: 'Source',
        value: `${source.slice(0, 8)}…${source.slice(-8)}`,
        mono: true,
      });
      const fee = tx.fee ?? '—';
      items.push({ label: 'Fee', value: `${fee} stroops`, mono: true });
      const ops: any[] = tx.operations || [];
      items.push({ label: 'Operations', value: String(ops.length) });
      ops.forEach((op: any, idx: number) => {
        if (op.type === 'payment' || op.type === 'createAccount') {
          const dest: string = op.destination || '—';
          items.push({
            label: `Destination ${idx + 1}`,
            value: `${dest.slice(0, 8)}…${dest.slice(-8)}`,
            mono: true,
          });
          const amt = op.amount ?? op.startingBalance ?? '—';
          const assetLabel =
            !op.asset ||
            (op.asset && typeof op.asset.isNative === 'function' && op.asset.isNative())
              ? 'XLM'
              : (op.asset?.code ?? 'unknown');
          items.push({
            label: `Amount ${idx + 1}`,
            value: `${amt} ${assetLabel}`,
            highlight: true,
          });
        } else if (op.type === 'invokeHostFunction') {
          items.push({ label: `Op ${idx + 1}`, value: 'Smart contract invocation' });
        } else {
          items.push({ label: `Op ${idx + 1}`, value: op.type ?? 'unknown' });
        }
      });
    } catch {
      items.push({ label: 'Network', value: 'Mainnet (Public)', highlight: true });
      items.push({ label: 'Transaction', value: 'Unable to parse XDR for preview' });
    }
    return items;
  };

  const doSign = async () => {
    // #1190 — sign only for a live request. Entry points that did not start
    // one (the risk-review acknowledgement) begin it here against the current
    // context, which preserves their previous behaviour.
    const request =
      signingGuard.getActive() ??
      signingGuard.begin({ walletConnected, walletType, walletPublicKey, network });
    if (!request || !signingGuard.ensureCurrent(request)) return;

    setSigning(true);
    setError(null);
    setSignedXdr(null);
    // #886 — Protect the signing flow from service-worker activation/reload:
    // deferred SW updates wait until the flow finishes (finally block below).
    setCriticalSigningActive(true);

    try {
      const signWith = request.context.walletType;
      if (!signWith) throw new Error('No wallet connected. Connect a wallet first.');
      setLedgerPrompt(signWith === 'ledger');
      const signingNetwork = request.context.network as NetworkName;
      const result = await measureAsync(
        'TRANSACTION_SIGNING_DURATION',
        () => getWalletAdapter(signWith).signTransaction(xdr.trim(), signingNetwork),
        { network: signingNetwork, walletType: signWith }
      );

      // The wallet may have been left, switched or re-pointed while its prompt
      // was open. The signature is then for a context the user no longer has,
      // so it is discarded rather than shown.
      if (!signingGuard.ensureCurrent(request)) return;

      setSignedXdr(result);
      // Record this successful sign to the behavioral profile
      if (bio.enabled) {
        bio.recordSuccessfulSign().catch(() => {});
      }
    } catch (err: unknown) {
      // An expiry already told the user why; a wallet error that follows it
      // is a consequence, not a second problem to report.
      if (!signingGuard.ensureCurrent(request)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      signingGuard.end();
      setLedgerPrompt(false);
      setSigning(false);
      // #886 — Signing is over: a service-worker update deferred during the
      // flow is now safe to activate (and reload) again.
      setCriticalSigningActive(false);
    }
  };

  const handleConfirm = async () => {
    setShowConfirmation(false);
    await doSign();
  };

  const handleCancelConfirmation = () => {
    setShowConfirmation(false);
    signingGuard.end();
    bio.abort();
  };

  // Biometric overlay handlers
  const handleBiometricProceed = async () => {
    setShowBiometricOverlay(false);
    await _proceedToSign();
  };

  const handleBiometricCancel = () => {
    setShowBiometricOverlay(false);
    signingGuard.end();
    bio.abort();
  };

  const handleBiometricDismiss = async () => {
    setShowBiometricOverlay(false);
    await _proceedToSign();
  };

  const handleCopy = () => {
    if (signedXdr) {
      navigator.clipboard.writeText(signedXdr);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!walletConnected) {
    return (
      <>
      <SigningExpiryNotice notice={signingGuard.notice} onDismiss={signingGuard.dismissNotice} />
      <Card title="Transaction Signer" subtitle="Sign transactions with your wallet">
        <div
          style={{
            padding: '32px 18px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '13px',
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.5 }}>✎</div>
          Connect a wallet to sign transactions.
          <br />
          <span style={{ fontSize: '11px' }}>
            Use the Wallet tab to connect Freighter or Ledger.
          </span>
        </div>
      </Card>
      </>
    );
  }

  if (riskSummary || riskReviewError) {
    return (
      <RiskSummaryPanel
        summary={riskSummary}
        reviewError={riskReviewError}
        proceedLabel="Sign Transaction"
        sourceLabel={
          walletPublicKey
            ? `signer ${walletPublicKey.slice(0, 6)}…${walletPublicKey.slice(-6)}`
            : undefined
        }
        onAcknowledged={() => acknowledgeRiskReview(() => doSign())}
        onCancel={cancelRiskReview}
        onTrustContract={trustRiskContract}
      />
    );
  }

  if (showConfirmation) {
    return (
      <EnhancedTransactionConfirmation
        transactionXdr={xdr}
        network={network}
        preferences={preferences}
        onConfirm={handleConfirm}
        onCancel={handleCancelConfirmation}
        sourceAccount={walletPublicKey}
      />
    );
  }

  return (
    <>
      {/* #983 — mainnet write guard dialog */}
      <MainnetConfirmDialog {...dialogProps} />
      <SigningExpiryNotice notice={signingGuard.notice} onDismiss={signingGuard.dismissNotice} />
      {error && (
        <div
          role="alert"
          style={{
            background: 'rgba(255,23,68,0.08)',
            border: '1px solid var(--red)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '12px',
            color: 'var(--red)',
          }}
        >
          {error}
        </div>
      )}
      {isReadOnlyLocked && (
        <div style={{
          background: 'rgba(255,23,68,0.08)',
          border: '1px solid var(--red)',
          borderRadius: 'var(--radius-md)',
          padding: '10px 14px',
          marginBottom: '12px',
          fontSize: '12px',
          color: 'var(--red)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          🔒 Mainnet read-only lock is active — signing is blocked this session.
        </div>
      )}
      <Card title="Transaction Signer" subtitle={`Signing with ${walletType}`}>
        <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 12px',
              background: 'var(--cyan-glow)',
              border: '1px solid var(--cyan-dim)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '11px',
              color: 'var(--cyan)',
            }}
          >
            <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Signer:
            </span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {walletPublicKey?.slice(0, 8)}…{walletPublicKey?.slice(-8)}
            </span>
            <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{walletType}</span>
          </div>

          {ledgerPrompt && (
            <div
              style={{
                padding: '12px',
                background: 'var(--amber-glow, rgba(245,158,11,0.1))',
                border: '1px solid var(--amber, #f59e0b)',
                borderRadius: 'var(--radius-md)',
                fontSize: '12px',
                color: 'var(--amber, #f59e0b)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span style={{ fontSize: '18px' }}>🔐</span>
              Review and confirm the transaction on your Ledger device…
            </div>
          )}

          <div>
            <label
              style={{
                fontSize: '10px',
                color: 'var(--text-muted)',
                letterSpacing: '1px',
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: '6px',
              }}
            >
              TRANSACTION XDR
            </label>
            <textarea
              value={xdr}
              onChange={handleXdrChange}
              placeholder="Paste the unsigned transaction XDR envelope here…"
              rows={5}
              style={{
                width: '100%',
                padding: '12px',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
                resize: 'vertical',
                lineHeight: 1.5,
                outline: 'none',
              }}
            />
          </div>

          {accountInfo && (
            <div
              style={{
                padding: '12px',
                background: 'var(--bg-elevated)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: '8px',
                  textTransform: 'uppercase',
                }}
              >
                Signer Requirements
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '8px',
                  marginBottom: '12px',
                }}
              >
                <div
                  style={{
                    background: 'var(--bg-base)',
                    padding: '8px',
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>LOW</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
                    {accountInfo.thresholds?.low_threshold}
                  </div>
                </div>
                <div
                  style={{
                    background: 'var(--bg-base)',
                    padding: '8px',
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>MED</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
                    {accountInfo.thresholds?.med_threshold}
                  </div>
                </div>
                <div
                  style={{
                    background: 'var(--bg-base)',
                    padding: '8px',
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>HIGH</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
                    {accountInfo.thresholds?.high_threshold}
                  </div>
                </div>
              </div>

              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Current Signers
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  maxHeight: '150px',
                  overflowY: 'auto',
                }}
              >
                {accountInfo.signers?.map((s: any) => (
                  <div
                    key={s.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      padding: '4px 8px',
                      background: 'var(--bg-base)',
                      borderRadius: '4px',
                    }}
                  >
                    <span>
                      {s.key.slice(0, 8)}...{s.key.slice(-8)}
                    </span>
                    <span style={{ color: 'var(--cyan)' }}>Weight: {s.weight}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {envelopeInfo && <EnvelopeDetails info={envelopeInfo} />}

        <button
          onClick={handleSign}
          disabled={signing || !xdr.trim()}
          style={{
            padding: '12px 20px',
            background: signing ? 'transparent' : 'var(--cyan-glow)',
            border: `1px solid ${signing ? 'var(--border)' : 'var(--cyan)'}`,
            borderRadius: 'var(--radius-md)',
            color: signing ? 'var(--text-muted)' : 'var(--cyan)',
            fontSize: '13px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            cursor: signing ? 'wait' : 'pointer',
            transition: 'var(--transition)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: !xdr.trim() ? 0.5 : 1,
          }}
        >
          {signing ? (
            <>
              <div className="spinner" />
              {ledgerPrompt ? 'Waiting for Ledger…' : 'Signing…'}
            </>
          ) : (
            'Sign Transaction'
          )}

          {signedXdr && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                }}
              >
                <label
                  style={{
                    fontSize: '10px',
                    color: 'var(--text-muted)',
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                  }}
                >
                  SIGNED XDR
                </label>
                <button
                  onClick={handleCopy}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 10px',
                    fontSize: '11px',
                    color: copied ? 'var(--green)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    transition: 'var(--transition)',
                  }}
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <div
                style={{
                  padding: '12px',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--green)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  wordBreak: 'break-all',
                  lineHeight: 1.5,
                  maxHeight: '120px',
                  overflowY: 'auto',
                }}
              >
                {signedXdr}
              </div>
            </div>
          )}

          {/* Biometric status badge (shown in learning mode) */}
          {bio.enabled && !bio.isEstablished && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                background: 'rgba(6,182,212,0.06)',
                border: '1px solid var(--cyan-dim, rgba(6,182,212,0.2))',
                borderRadius: 'var(--radius-sm)',
                fontSize: '11px',
                color: 'var(--cyan, #06b6d4)',
              }}
            >
              <span>📖</span>
              <span>
                Behavioral profile learning — {bio.samplesNeeded} more transaction
                {bio.samplesNeeded === 1 ? '' : 's'} to establish your identity
              </span>
            </div>
          )}
        </button>
      </Card>

      {/* Biometric overlay — rendered as a portal-like fixed overlay */}
      {showBiometricOverlay && (
        <BiometricAuthOverlay
          status={bio.authStatus}
          profile={bio.profile}
          lastResult={bio.lastAnomalyResult}
          onProceedAnyway={handleBiometricProceed}
          onCancel={handleBiometricCancel}
          onDismiss={handleBiometricDismiss}
          strictMode={bio.strictMode}
        />
      )}
    </>
  );
}

// ─── Envelope inspector panel ─────────────────────────────────────────────────

function mono(text: string) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', wordBreak: 'break-all' }}>
      {text}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-muted)', minWidth: '120px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

function EnvelopeDetails({ info }: { info: EnvelopeInfo }) {
  if (info.type === 'fee_bump') {
    const inner = info.innerTransaction;
    return (
      <div
        style={{
          border: '1px solid var(--cyan-dim)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          fontSize: '12px',
        }}
      >
        {/* Fee-bump header */}
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--cyan-glow)',
            borderBottom: '1px solid var(--cyan-dim)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '14px' }}>⇧</span>
          <span style={{ fontWeight: 600, color: 'var(--cyan)', fontSize: '12px' }}>
            Fee-Bump Transaction
          </span>
        </div>

        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <Row label="Outer hash">{mono(`${info.hash.slice(0, 16)}…${info.hash.slice(-8)}`)}</Row>
          <Row label="Fee source">{mono(info.feeSource)}</Row>
          <Row label="Outer fee">{mono(`${info.fee} stroops`)}</Row>
        </div>

        {/* Inner transaction */}
        <div
          style={{
            margin: '0 12px 12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)',
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Inner Transaction
          </div>
          <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <Row label="Hash">{mono(`${inner.hash.slice(0, 16)}…${inner.hash.slice(-8)}`)}</Row>
            <Row label="Source">{mono(inner.source)}</Row>
            <Row label="Fee">{mono(`${inner.fee} stroops`)}</Row>
            <Row label="Sequence">{mono(inner.sequenceNumber)}</Row>
            <Row label="Signatures">{mono(String(inner.signatures))}</Row>
            <Row label="Operations">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {inner.operations.map((op, i) => (
                  <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                    {i + 1}. {op.type}
                    {op.source ? (
                      <span style={{ color: 'var(--text-muted)' }}>
                        {' '}
                        ({op.source.slice(0, 6)}…)
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </Row>
          </div>
        </div>
      </div>
    );
  }

  // Plain transaction
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        fontSize: '12px',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          fontSize: '12px',
        }}
      >
        Transaction Envelope
      </div>
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Row label="Hash">{mono(`${info.hash.slice(0, 16)}…${info.hash.slice(-8)}`)}</Row>
        <Row label="Source">{mono(info.source)}</Row>
        <Row label="Fee">{mono(`${info.fee} stroops`)}</Row>
        <Row label="Sequence">{mono(info.sequenceNumber)}</Row>
        <Row label="Signatures">{mono(String(info.signatures))}</Row>
        <Row label="Operations">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {info.operations.map((op, i) => (
              <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                {i + 1}. {op.type}
                {op.source ? (
                  <span style={{ color: 'var(--text-muted)' }}> ({op.source.slice(0, 6)}…)</span>
                ) : null}
              </div>
            ))}
          </div>
        </Row>
      </div>
    </div>
  );
}
