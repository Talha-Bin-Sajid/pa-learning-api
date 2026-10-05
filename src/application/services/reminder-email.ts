import type { PlanEntry } from '../../domain/services/learning-progress.js';
import type { EmailMessage } from '../ports/email-sender.js';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ukDate = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'no due date';

export interface ReminderEmailInput {
  to: string;
  cc: string[];
  firstName: string;
  outstanding: PlanEntry[];
  appUrl: string;
  /** Optional note from the Learning Team (manual reminders). */
  note?: string | null;
}

/** Builds the reminder email (plain text + simple, escaped HTML). Pure function. */
export function composeReminderEmail(input: ReminderEmailInput): EmailMessage {
  const overdue = input.outstanding.filter((e) => e.status === 'overdue');
  const subject = overdue.length
    ? `Action needed: ${overdue.length} overdue learning item${overdue.length === 1 ? '' : 's'}`
    : `Reminder: ${input.outstanding.length} learning item${input.outstanding.length === 1 ? '' : 's'} to complete`;

  const rejectedNote = (e: PlanEntry) =>
    e.rejected ? `Evidence rejected${e.rejected.reviewNotes ? `: ${e.rejected.reviewNotes}` : ''} - please upload the correct certificate` : null;
  const line = (e: PlanEntry) =>
    `${e.item.title} - ${e.item.hours} h - ${e.status === 'overdue' ? `OVERDUE (due ${ukDate(e.item.dueDate)})` : `due ${ukDate(e.item.dueDate)}`}${e.item.isMandatory ? ' - mandatory' : ''}${rejectedNote(e) ? `\n    ${rejectedNote(e)}` : ''}`;

  const text = [
    `Hi ${input.firstName},`,
    '',
    'You have learning to complete on the Project Accountants Learning Platform:',
    '',
    ...input.outstanding.map((e) => `• ${line(e)}`),
    '',
    ...(input.note ? ['Note from the Learning Team:', input.note, ''] : []),
    `Open your learning plan: ${input.appUrl}/my/plan`,
    'Upload your certificate or screenshot to mark each item complete.',
    '',
    'Project Accountants Learning Team',
  ].join('\n');

  const rows = input.outstanding
    .map(
      (e) =>
        `<tr><td style="padding:6px 12px 6px 0">${escapeHtml(e.item.title)}${e.item.isMandatory ? ' <b style="color:#ec4f3c">MANDATORY</b>' : ''}` +
        `${rejectedNote(e) ? `<br><span style="color:#ec4f3c;font-size:12px">${escapeHtml(rejectedNote(e)!)}</span>` : ''}</td>` +
        `<td style="padding:6px 12px 6px 0">${e.item.hours} h</td>` +
        `<td style="padding:6px 0;color:${e.status === 'overdue' ? '#ec4f3c' : '#262719'}">${e.status === 'overdue' ? 'Overdue · ' : 'Due '}${ukDate(e.item.dueDate)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="font-family:Poppins,Arial,sans-serif;color:#262719;font-size:14px">
<p>Hi ${escapeHtml(input.firstName)},</p>
<p>You have learning to complete on the Project Accountants Learning Platform:</p>
<table style="border-collapse:collapse">${rows}</table>
${input.note ? `<p style="margin-top:16px"><b>Note from the Learning Team:</b><br>${escapeHtml(input.note).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin-top:20px"><a href="${escapeHtml(input.appUrl)}/my/plan" style="background:#2d8dfe;color:#fff;padding:10px 18px;text-decoration:none;font-weight:600">OPEN MY LEARNING PLAN</a></p>
<p style="color:#888;font-size:12px">Upload your certificate or screenshot to mark each item complete.</p>
</body></html>`;

  return { to: input.to, cc: input.cc, subject, text, html };
}

export interface ReviewDigestInput {
  to: string;
  firstName: string;
  /** Everything waiting for a decision, and how many of those are older than `overDays`. */
  waiting: number;
  stale: { personName: string; title: string; daysWaiting: number; reason: string | null }[];
  overDays: number;
  appUrl: string;
}

/** Weekly nudge to the Learning Team about evidence nobody has reviewed yet. Pure function. */
export function composeReviewDigestEmail(input: ReviewDigestInput): EmailMessage {
  const n = input.stale.length;
  const subject = `${n} evidence submission${n === 1 ? '' : 's'} waiting for review over ${input.overDays} days`;
  const shown = input.stale.slice(0, 20);
  const more = n - shown.length;
  const text = [
    `Hi ${input.firstName},`,
    '',
    `${input.waiting} submission${input.waiting === 1 ? ' is' : 's are'} waiting for a decision; ${n} ${n === 1 ? 'has' : 'have'} waited more than ${input.overDays} days:`,
    '',
    ...shown.map((s) => `• ${s.personName} - ${s.title} - ${s.daysWaiting} days${s.reason ? `\n    ${s.reason}` : ''}`),
    ...(more > 0 ? [`…and ${more} more`] : []),
    '',
    `Review them: ${input.appUrl}/evidence`,
    '',
    'Project Accountants Learning Platform',
  ].join('\n');
  const rows = shown
    .map(
      (s) =>
        `<tr><td style="padding:6px 12px 6px 0">${escapeHtml(s.personName)}</td><td style="padding:6px 12px 6px 0">${escapeHtml(s.title)}` +
        `${s.reason ? `<br><span style="color:#888;font-size:12px">${escapeHtml(s.reason)}</span>` : ''}</td>` +
        `<td style="padding:6px 0;white-space:nowrap">${s.daysWaiting} days</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="font-family:Poppins,Arial,sans-serif;color:#262719;font-size:14px">
<p>Hi ${escapeHtml(input.firstName)},</p>
<p>${input.waiting} submission${input.waiting === 1 ? ' is' : 's are'} waiting for a decision; <b>${n}</b> ${n === 1 ? 'has' : 'have'} waited more than ${input.overDays} days:</p>
<table style="border-collapse:collapse">${rows}</table>
${more > 0 ? `<p style="color:#888">…and ${more} more</p>` : ''}
<p style="margin-top:20px"><a href="${escapeHtml(input.appUrl)}/evidence" style="background:#2d8dfe;color:#fff;padding:10px 18px;text-decoration:none;font-weight:600">OPEN EVIDENCE REVIEW</a></p>
</body></html>`;
  return { to: input.to, cc: [], subject, text, html };
}
