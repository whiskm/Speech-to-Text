/** Hands a picked backup file from the settings screen to the import screen. */
let pending: File | null = null;

export function setPendingBackup(file: File | null): void {
  pending = file;
}

export function takePendingBackup(): File | null {
  const f = pending;
  pending = null;
  return f;
}
