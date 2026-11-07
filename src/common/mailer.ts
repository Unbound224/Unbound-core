/** Outbound email port. Core has NO real email provider yet (README status). */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * OutboxMailer - DEV/TEST ADAPTER. It never sends email: messages are kept in memory (and, in the
 * dev server, printed to the console) so a developer can follow a reset link locally.
 */
export class OutboxMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(private readonly echo?: (mail: Mail) => void) {}
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    this.echo?.(mail);
  }
}
