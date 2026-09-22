import pino from 'pino';

/**
 * Structured logger with REDACTION: credentials, tokens, OTP codes, PINs and cookies can never reach the log stream even if
 * someone logs a whole request/body by mistake (SECURITY_RISKS #19: legacy wrote OTPs to the server log in plaintext).
 */
export const REDACT_PATHS = [
  'password', 'pin', 'code', 'otp', 'token', 'accessToken', 'refreshToken', 'newPassword', 'currentPassword',
  '*.password', '*.pin', '*.code', '*.otp', '*.token', '*.accessToken', '*.refreshToken', '*.newPassword', '*.currentPassword',
  'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'headers.authorization', 'headers.cookie',
];

// Tests can attach a sink to inspect exactly what would have been written.
const sinks: Array<(line: string) => void> = [];
const destination = {
  write(line: string) {
    sinks.forEach((s) => s(line));
    if (process.env.NODE_ENV !== 'test') process.stdout.write(line);
  },
};

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'debug' : 'info'),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'al-barakah-backend' },
  },
  destination,
);

export function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const sink = (l: string) => lines.push(l);
  sinks.push(sink);
  return { lines, stop: () => void sinks.splice(sinks.indexOf(sink), 1) };
}
