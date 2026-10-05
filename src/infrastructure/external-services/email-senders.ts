import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '../../application/ports/email-sender.js';
import type { Logger } from '../../shared/utils/logger.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Sends through any SMTP server (Microsoft 365, SendGrid, Mailgun, …). */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(private readonly options: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    });
  }

  async send(m: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.options.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html });
  }
}

/** Development fallback when no SMTP server is configured: logs instead of sending. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  async send(m: EmailMessage): Promise<void> {
    this.logger.info('email (not sent: SMTP not configured)', { to: m.to, cc: m.cc, subject: m.subject });
  }
}
