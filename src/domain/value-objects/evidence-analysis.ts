/**
 * What an AI model reports after reading a certificate, independent of which
 * provider produced it. The model only *reads and compares*; the firm's rules
 * that turn this into a decision live in EvidencePolicy.
 */

/** Result of one comparison between the certificate and what we expected. */
export type CheckResult = 'match' | 'partial' | 'mismatch' | 'not_found';

export interface EvidenceAnalysis {
  /** Is this plausibly a completion certificate / attendance record at all? */
  isCertificate: boolean;
  /** One line on what the document is ("ICAEW course certificate", "screenshot of an email", …). */
  documentType: string;
  extracted: {
    participantName: string | null;
    courseTitle: string | null;
    provider: string | null;
    /** YYYY-MM-DD if a completion/issue date is shown. */
    completionDate: string | null;
    /** CPD hours/units shown on the certificate, if any. */
    hours: number | null;
    certificateId: string | null;
  };
  checks: {
    /** Name on the certificate vs the person submitting it. */
    name: CheckResult;
    /** Course title/topic vs the learning item — same subject counts as a match even if worded differently. */
    title: CheckResult;
    provider: CheckResult;
  };
  /** Visible signs of editing or forgery (mismatched fonts, pasted text, cropped names…). */
  tamperingSigns: string[];
  /** 0–1: how sure the model is about its reading and comparison. */
  confidence: number;
  /** Short plain-English explanation for reviewers. */
  summary: string;
}

/** What the submission claims — the model compares the document against this. */
export interface EvidenceExpectation {
  personName: string;
  itemTitle: string;
  itemDescription: string | null;
  provider: string;
  hours: number;
  /** Date the person entered as their completion date. */
  completedOn: string;
  category: string;
  deliveryType: string;
}
