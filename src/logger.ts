/** Minimal logger boundary so the SDK never hard-depends on `console` and tests can capture warnings. */
export interface Logger {
  warn(message: string): void;
}

/** Default logger — routes warnings to `console.warn` when available, otherwise a no-op. */
export const consoleLogger: Logger = {
  warn(message: string): void {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(message);
    }
  },
};
