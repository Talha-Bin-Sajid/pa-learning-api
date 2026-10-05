export interface EmailMessage {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
