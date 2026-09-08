/** Saves a `Blob` fetched via `apiFetchBlob` to disk — an object URL + a synthetic `<a download>` click, cleaned up immediately after. Mirrors `apps/portal`'s own `download.ts` (see that file's doc comment) — the data migration toolkit's error-report CSV is this console's first binary download. */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
