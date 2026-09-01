/** Saves a `Blob` fetched via `apiFetchBlob` (payslip PDF, bank-export CSV) to disk — an object URL + a synthetic `<a download>` click, cleaned up immediately after. */
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
