import React, { useState } from 'react';
import type { DecisionCard } from './types';

interface WhisperCardProps {
  cards: DecisionCard[];
  onAnswer: (id: string, optionKey: string) => void;
  onDismiss: (id: string) => void;
  onSubmitCredential?: (id: string, secretValue: string) => Promise<{ ok: boolean; error?: string; receipt?: string } | undefined>;
  onOpenInBrowser: (card: DecisionCard) => void;
  onClose: () => void;
}

export const WhisperCard: React.FC<WhisperCardProps> = ({
  cards,
  onAnswer,
  onDismiss,
  onSubmitCredential,
  onOpenInBrowser,
  onClose,
}) => {
  const [index, setIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const [secretDraft, setSecretDraft] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);

  if (cards.length === 0) {
    return (
      <div className="ab-whisper ab-whisper--empty">
        <div className="ab-whisper__top">
          <span className="ab-whisper__eyebrow">ALL CLEAR</span>
          <button type="button" className="ab-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="ab-whisper__empty-msg">No decisions waiting on you right now.</div>
      </div>
    );
  }

  const safeIdx = index % cards.length;
  const card = cards[safeIdx];
  const moreCount = cards.length - 1;

  const readAloud = () => {
    setVoiceNote('');
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setVoiceNote('Speech synthesis unavailable in this runtime.');
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const text = `${card.title}. ${card.summary || ''}`.trim();
      const utter = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utter);
      setVoiceNote('Reading aloud…');
    } catch {
      setVoiceNote('Could not start speech output.');
    }
  };

  const answerByVoice = () => {
    const w = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: ((ev: { error: string }) => void) | null;
        onend: (() => void) | null;
        start: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: ((ev: { error: string }) => void) | null;
        onend: (() => void) | null;
        start: () => void;
      };
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setVoiceNote('Voice recognition unavailable — click an option above.');
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = 'en-US';
      setVoiceNote('Listening…');
      rec.onresult = (ev) => {
        const spoken = String(ev.results?.[0]?.[0]?.transcript || '').toLowerCase();
        const match = card.options.find(
          (o) => spoken.includes(o.key.toLowerCase()) || spoken.includes(o.label.toLowerCase().split(' ')[0]),
        );
        if (match) {
          setVoiceNote(`Heard "${spoken}" → ${match.label}`);
          onAnswer(card.id, match.key);
        } else {
          setVoiceNote(`Heard "${spoken}" — no matching option.`);
        }
      };
      rec.onerror = (ev) => setVoiceNote(`Mic: ${ev.error}`);
      rec.start();
    } catch {
      setVoiceNote('Could not access microphone.');
    }
  };

  return (
    <div className="ab-whisper" role="region" aria-label="Decision whisper card">
      <div className="ab-whisper__top">
        <span className="ab-whisper__eyebrow">● NEW FOR YOU</span>
        <div className="ab-whisper__nav">
          {moreCount > 0 && (
            <button
              type="button"
              className="ab-whisper__link"
              onClick={() => setIndex((i) => (i + 1) % cards.length)}
            >
              {moreCount} more needs you ›
            </button>
          )}
          <button type="button" className="ab-icon-btn" onClick={onClose} aria-label="Hide card">
            ×
          </button>
        </div>
      </div>

      <div className="ab-whisper__title">{card.title}</div>

      {card.summary && (
        <div className="ab-whisper__summary-box">
          ✦ {card.summary}
        </div>
      )}

      {showDetails && (
        <div className="ab-whisper__details">
          <div>ID: {card.id} · Kind: {card.kind} · Urgency: {card.urgency}</div>
          {card.options.map((o) => (
            <div key={o.key}>
              <strong>{o.label}</strong>
              {o.consequence ? ` — ${o.consequence}` : ''}
            </div>
          ))}
        </div>
      )}

      {card.kind === 'credential' ? (
        <form
          className="ab-cred-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const val = secretDraft;
            if (!val || vaultBusy || !onSubmitCredential) return;
            setSecretDraft('');
            setVaultBusy(true);
            try {
              const res = await onSubmitCredential(card.id, val);
              setVoiceNote(res?.ok ? 'Stored securely in platform vault.' : (res?.error || 'Vault write failed.'));
            } finally {
              setVaultBusy(false);
            }
          }}
        >
          <input
            type="password"
            className="ab-avatar-ask__input"
            value={secretDraft}
            onChange={(e) => setSecretDraft(e.target.value)}
            placeholder={`Paste ${card.secretName || 'secret value'} (stored straight to vault)…`}
            aria-label="Secret credential value"
            autoComplete="off"
          />
          <button type="submit" className="ab-whisper__opt is-primary" disabled={vaultBusy || !secretDraft}>
            {vaultBusy ? 'Storing…' : 'Store in Vault'}
          </button>
        </form>
      ) : (
        <div className="ab-whisper__options">
          {(card.options.length > 0
            ? card.options
            : [{ key: 'ack', label: 'Acknowledge', recommended: true }]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`ab-whisper__opt ${opt.recommended ? 'is-primary' : ''}`}
              onClick={() => onAnswer(card.id, opt.key)}
              title={opt.consequence || opt.label}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div className="ab-whisper__links">
        <button type="button" className="ab-whisper__link" onClick={() => onDismiss(card.id)}>
          Later
        </button>
        <button type="button" className="ab-whisper__link" onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        <button type="button" className="ab-whisper__link" onClick={() => onOpenInBrowser(card)}>
          Open in AitherBrowser
        </button>
      </div>

      <div className="ab-whisper__voice">
        <button type="button" className="ab-whisper__voice-btn" onClick={readAloud}>
          Read it to me
        </button>
        <button type="button" className="ab-whisper__voice-btn" onClick={answerByVoice}>
          Answer by voice
        </button>
      </div>

      {voiceNote && <div className="ab-whisper__note">{voiceNote}</div>}
    </div>
  );
};
