import type { SigningExpiryNotice as SigningExpiryNoticeData } from '../../hooks/useSigningRequestGuard';

interface SigningExpiryNoticeProps {
  notice: SigningExpiryNoticeData | null;
  onDismiss: () => void;
}

/**
 * Tells the user a pending signature request was cancelled and why (#1190).
 * Rendered as an alert so assistive technology announces it as soon as it
 * appears, and dismissible by keyboard.
 */
export default function SigningExpiryNotice({ notice, onDismiss }: SigningExpiryNoticeProps) {
  if (!notice) return null;

  return (
    <div
      role="alert"
      data-testid="signing-expiry-notice"
      data-reason={notice.reason}
      style={{
        background: 'rgba(245,158,11,0.1)',
        border: '1px solid var(--amber, #f59e0b)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 14px',
        marginBottom: '12px',
        fontSize: '12px',
        color: 'var(--amber, #f59e0b)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span style={{ flex: 1 }}>{notice.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 10px',
          fontSize: '11px',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
