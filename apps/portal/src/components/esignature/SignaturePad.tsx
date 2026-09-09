'use client';

import { useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { SignInput } from '../../lib/api/esignature';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';

/**
 * The signature-CAPTURE UI, shared by both the internal ESS sign page and
 * the external (no-account) public signing page — see
 * docs/conventions/e-signatures.md. Produces exactly the `SignInput` shape
 * both `signMine`/`signViaLink` accept; has no opinion on WHO is signing or
 * how the result is submitted, only on how a typed/drawn signature is
 * captured and turned into that payload.
 */
export function SignaturePad({
  onSubmit,
  submitting,
}: {
  onSubmit: (input: SignInput) => void;
  submitting: boolean;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<'TYPED_NAME' | 'DRAWN_SIGNATURE'>('TYPED_NAME');
  const [typedName, setTypedName] = useState('');
  const [consent, setConsent] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  function getPos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    setHasDrawn(true);
  }

  function stopDrawing() {
    drawingRef.current = false;
  }

  function clearCanvas() {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  }

  const canSubmit = consent && (method === 'TYPED_NAME' ? typedName.trim().length > 0 : hasDrawn);

  function handleSubmit() {
    if (!canSubmit) return;
    if (method === 'TYPED_NAME') {
      onSubmit({ signingMethod: 'TYPED_NAME', typedSignatureText: typedName.trim(), consent: true });
    } else {
      onSubmit({ signingMethod: 'DRAWN_SIGNATURE', signatureImageBase64: canvasRef.current!.toDataURL('image/png'), consent: true });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="sign-method-typed"
          onClick={() => setMethod('TYPED_NAME')}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            method === 'TYPED_NAME' ? 'bg-brand-600 text-white' : 'bg-sand-100 text-ink-700'
          }`}
        >
          {t('esignature.typedName')}
        </button>
        <button
          type="button"
          data-testid="sign-method-drawn"
          onClick={() => setMethod('DRAWN_SIGNATURE')}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            method === 'DRAWN_SIGNATURE' ? 'bg-brand-600 text-white' : 'bg-sand-100 text-ink-700'
          }`}
        >
          {t('esignature.drawnSignature')}
        </button>
      </div>

      {method === 'TYPED_NAME' ? (
        <div>
          <Label htmlFor="typed-signature">{t('esignature.typeYourName')}</Label>
          <Input id="typed-signature" data-testid="typed-signature-input" value={typedName} onChange={(e) => setTypedName(e.target.value)} />
        </div>
      ) : (
        <div>
          <canvas
            ref={canvasRef}
            width={400}
            height={140}
            data-testid="signature-canvas"
            className="w-full touch-none rounded-lg border border-ink-200 bg-white"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDrawing}
            onPointerLeave={stopDrawing}
          />
          <button type="button" onClick={clearCanvas} className="mt-1 text-xs text-ink-500 underline" data-testid="clear-signature-button">
            {t('esignature.clear')}
          </button>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" data-testid="sign-consent-checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {t('esignature.consent')}
      </label>

      <Button data-testid="submit-signature-button" disabled={!canSubmit} loading={submitting} onClick={handleSubmit}>
        {t('esignature.submitSignature')}
      </Button>
    </div>
  );
}
