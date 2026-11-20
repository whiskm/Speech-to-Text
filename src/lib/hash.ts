export function uid(): string {
  return crypto.randomUUID();
}

/** SHA-256 of a blob as lowercase hex. Used to spot the same audio file imported twice. */
export async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
