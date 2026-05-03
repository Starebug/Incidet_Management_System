export class DebugLogger {
  private static isEnabled(): boolean {
    const value = (process.env.DEBUG || '').trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'yes' || value === 'on';
  }

  static log(scope: string, message: string, meta?: unknown): void {
    if (!this.isEnabled()) return;

    if (meta !== undefined) {
      console.log(`[${scope}] ${message}`, meta);
      return;
    }

    console.log(`[${scope}] ${message}`);
  }

  static warn(scope: string, message: string, meta?: unknown): void {
    if (!this.isEnabled()) return;

    if (meta !== undefined) {
      console.warn(`[${scope}] ${message}`, meta);
      return;
    }

    console.warn(`[${scope}] ${message}`);
  }
}

