'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'idle' | 'starting' | 'ready' | 'denied';

/** Front-camera preview + single-frame JPEG capture, for the kiosk's optional buddy-punching photo. The stream is stopped the moment `enabled` goes false. */
export function useCamera(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>('idle');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState('starting');
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setState('ready');
      } catch {
        if (!cancelled) setState('denied');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState('idle');
    };
  }, [enabled]);

  const capture = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || state !== 'ready' || !video.videoWidth) return null;
    const scale = Math.min(1, 640 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
  }, [state]);

  return { videoRef, state, capture };
}
