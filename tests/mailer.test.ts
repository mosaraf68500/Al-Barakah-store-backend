import nodemailer from 'nodemailer';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env';
import { OtpModel } from '../src/modules/admin-auth/otp.model';
import { MailDeliveryError, __setTransportForTests, buildSmtpOptions, memoryOutbox, sendMail } from '../src/modules/notifications/mailer';
import { renderAdminInviteEmail, renderOrderNotificationEmail, renderOtpEmail } from '../src/modules/notifications/templates';
import { UserModel } from '../src/modules/users/user.model';
import { captureLogs } from '../src/utils/logger';
import { ADMIN_EMAIL, ADMIN_PASSWORD, adminSignIn, app, codeFromMail, lastMail, makeUser } from './helpers';

const SMTP_ENV = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.albarakah.test', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'sender@albarakah.test', SMTP_PASS: 'not-a-real-password', SMTP_FROM: 'Al Barakah <sender@albarakah.test>' };
const saved: Record<string, string | undefined> = {};
function useEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
  resetEnvCacheForTests();
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  resetEnvCacheForTests();
  __setTransportForTests(undefined);
  vi.restoreAllMocks();
});

const HOSTILE = `<script>alert(1)</script>"><img src=x onerror=alert(2)>&'\``;

describe('mailer fix #1 - OTP is never logged in plaintext (SECURITY_RISKS #19)', () => {
  it('the code appears in the e-mail body only: not in logs, not in the subject, not in the DB', async () => {
    const cap = captureLogs();
    const a = app();
    await makeUser('admin');
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const mail = lastMail();
    const code = codeFromMail(mail);
    cap.stop();
    expect(code).toMatch(/^\d{6}$/);
    expect(cap.lines.length).toBeGreaterThan(0);
    expect(cap.lines.join('\n')).not.toContain(code);
    expect(cap.lines.join('\n')).not.toContain(ADMIN_PASSWORD);
    expect(mail.subject).not.toContain(code);
    expect(JSON.stringify(await OtpModel.find().lean())).not.toContain(code);
  });

  it('the logger redacts secrets even when someone logs a whole body', async () => {
    const { logger } = await import('../src/utils/logger');
    const cap = captureLogs();
    logger.info({ body: { password: 'hunter2hunter2', pin: '654321', code: '999888' }, req: { headers: { authorization: 'Bearer abc', cookie: 'abp_rt_admin=xyz' } } }, 'oops');
    logger.info({ password: 'topsecretvalue', code: '112233' }, 'oops2');
    cap.stop();
    const out = cap.lines.join('\n');
    for (const s of ['hunter2hunter2', '654321', '999888', 'Bearer abc', 'abp_rt_admin=xyz', 'topsecretvalue', '112233']) expect(out).not.toContain(s);
    expect(out).toContain('[REDACTED]');
  });
});

describe('mailer fix #2 - TLS verification stays ON (SECURITY_RISKS #20)', () => {
  it('SMTP options never disable certificate verification and require STARTTLS on non-implicit-TLS ports', () => {
    useEnv(SMTP_ENV);
    const o = buildSmtpOptions();
    expect(o.tls?.rejectUnauthorized).not.toBe(false);
    expect(o.tls?.minVersion).toBe('TLSv1.2');
    expect(o.secure).toBe(false);
    expect(o.requireTLS).toBe(true);
    useEnv({ SMTP_PORT: '465', SMTP_SECURE: 'true' });
    expect(buildSmtpOptions().secure).toBe(true);
  });

  it('source contains no rejectUnauthorized:false anywhere', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(`grep -rn "rejectUnauthorized" src || true`, { cwd: process.cwd() }).toString();
    expect(hits).not.toMatch(/rejectUnauthorized\s*:\s*false/);
  });
});

describe('mailer fix #3 - every interpolated value is escaped (SECURITY_RISKS #21)', () => {
  it('order e-mail: no raw markup from names, address, notes, items, phone href', () => {
    const m = renderOrderNotificationEmail({
      id: 'AB-123456', customerName: HOSTILE, customerEmail: HOSTILE, customerPhone: `01712345678" onmouseover="alert(3)`,
      deliveryAddress: HOSTILE, cityDistrict: HOSTILE, notes: HOSTILE, paymentMethod: HOSTILE, totalAmount: 100,
      items: [{ name: HOSTILE, quantity: 1, price: 100, selectedSize: HOSTILE, selectedColor: HOSTILE }],
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toMatch(/<img[^>]*onerror/i);
    expect(m.html).not.toContain('"><img');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // the tel: href is reduced to digits/+ so an attribute cannot be broken out of
    const href = /href="tel:([^"]*)"/.exec(m.html)![1];
    expect(href).toMatch(/^[+\d]*$/);
    expect(m.html).not.toContain('onmouseover="alert');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it('OTP and invite e-mails escape names and links; mail headers cannot be CRLF-injected', async () => {
    expect(renderOtpEmail({ adminName: HOSTILE, code: '123456', ttlMinutes: 5 }).html).not.toContain('<script>');
    const inv = renderAdminInviteEmail({ name: HOSTILE, link: 'https://x.test/?a="><script>alert(1)</script>', ttlHours: 48 });
    expect(inv.html).not.toContain('<script>');
    await sendMail({ to: 'a@albarakah.test', subject: 'Hi\r\nBcc: attacker@evil.test', text: 't', html: '<p>t</p>' });
    expect(memoryOutbox.at(-1)!.subject).not.toMatch(/[\r\n]/);
    await expect(sendMail({ to: 'a@albarakah.test\r\nBcc: x@evil.test', subject: 's', text: 't', html: 'h' })).rejects.toBeInstanceOf(MailDeliveryError);
  });
});

describe('mailer fix #4 - one configured sender identity (SECURITY_RISKS #22)', () => {
  it('creates ONE transport with ONE credential set and always sends from SMTP_FROM (no candidate-identity loop)', async () => {
    useEnv(SMTP_ENV);
    const sendMailFn = vi.fn().mockResolvedValue({ messageId: '<ok@x>' });
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: sendMailFn } as never);
    await sendMail({ to: 'a@albarakah.test', subject: 's', text: 't', html: 'h' });
    await sendMail({ to: 'b@albarakah.test', subject: 's', text: 't', html: 'h' });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as { auth: { user: string } }).auth.user).toBe('sender@albarakah.test');
    expect(sendMailFn.mock.calls.every((c) => c[0].from === 'Al Barakah <sender@albarakah.test>')).toBe(true);
  });

  it('no hard-coded e-mail addresses or e-mail "typo repair" remain in the mailer source', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/modules/notifications/mailer.ts', 'utf8') + fs.readFileSync('src/modules/notifications/notifications.service.ts', 'utf8');
    expect(src).not.toMatch(/[\w.+-]+@(gmail|yahoo|outlook)\.com/i);
    expect(src).not.toMatch(/gmai\b/);
  });

  it('order-notification recipients come from configuration only', async () => {
    const { sendOrderNotificationEmail } = await import('../src/modules/notifications/notifications.service');
    await sendOrderNotificationEmail({ id: 'AB-1', customerName: 'N', customerPhone: '017', deliveryAddress: 'A', totalAmount: 1, items: [] });
    expect(memoryOutbox.at(-1)!.to).toEqual(['owner@albarakah.test']);
  });
});

describe('mailer fix #5 - failures surface as failures (no fake "delivered")', () => {
  it('a rejecting transport throws MailDeliveryError', async () => {
    __setTransportForTests({ sendMail: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) });
    await expect(sendMail({ to: 'a@albarakah.test', subject: 's', text: 't', html: 'h' })).rejects.toBeInstanceOf(MailDeliveryError);
  });

  it('SMTP not configured -> error, never "success"', async () => {
    useEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' });
    await expect(sendMail({ to: 'a@albarakah.test', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/not configured/);
  });

  it('memory transport is refused in production', async () => {
    const { parseEnv } = await import('../src/config/env');
    expect(() => parseEnv({ ...process.env, NODE_ENV: 'production', MAIL_TRANSPORT: 'memory', BCRYPT_COST: '12' })).toThrow(/memory/);
  });

  it('admin login: when the OTP e-mail cannot be sent the API answers 502 and leaves no OTP behind', async () => {
    __setTransportForTests({ sendMail: vi.fn().mockRejectedValue(new Error('smtp down')) });
    useEnv(SMTP_ENV);
    const a = app();
    await makeUser('admin');
    const res = await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('OTP_DELIVERY_FAILED');
    expect(await OtpModel.countDocuments()).toBe(0);
  });

  it('grant-access: a failed invite e-mail rolls the new admin back and returns 502', async () => {
    const a = app();
    await makeUser('super_admin');
    const sa = await adminSignIn(a);
    __setTransportForTests({ sendMail: vi.fn().mockRejectedValue(new Error('smtp down')) });
    useEnv(SMTP_ENV);
    const res = await request(a).post('/v1/admin-auth/grant-access').set('Authorization', `Bearer ${sa.accessToken}`).send({ name: 'N', email: 'new@albarakah.test' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('INVITE_DELIVERY_FAILED');
    expect(await UserModel.findOne({ email: 'new@albarakah.test' })).toBeNull();
  });
});
