import crypto from 'node:crypto';
import { config } from '../../config/index.ts';

export interface MinimalPersonalContext {
  sanitizedNote: string;
  actionItems: string[];
  redactedCount: number;
  subscriberToken: string;
  claimUrl: string;
}

const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  // Email addresses embedded inside conversational text
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]'
  },
  // International & US Phone numbers
  {
    name: 'phone',
    regex: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    replacement: '[REDACTED_PHONE]'
  },
  // SSN / National ID / Passport-like sequences
  {
    name: 'id_number',
    regex: /\b\d{3}-\d{2}-\d{4}\b|\b(?:passport|ssn|nin|bvn|student\s*id)[:\s#]*[A-Z0-9-]{5,15}\b/gi,
    replacement: '[REDACTED_ID]'
  },
  // Explicit self-identification ("My name is ...", "I am [Full Name] and I live at ...")
  {
    name: 'self_name',
    regex: /\b(?:my full name is|my name is|i live at|my address is|my gpa is|my family income is)\s+[^.,;\n]+/gi,
    replacement: '[REDACTED_PERSONAL_DETAIL]'
  }
];

const ACTIONABLE_KEYWORDS =
  /\b(prepare|draft|write|request|upload|submit|contact|gather|transcript|essay|proposal|reference|recommendation|cv|resume|portfolio|test|ielts|toefl|gre)\b/i;

/**
 * PrivacyMinimizer enforces strict Data Minimization between AI Chats and PulseRemind:
 * 1. Scrubs accidental PII (names, phone numbers, IDs, GPA/income, embedded emails) from chat context.
 * 2. Distills raw chat text into a short, non-PII "Personal Action Checklist" so the reminder
 *    remains personal ("Remember to submit your 2-page proposal & 2 references") without storing raw chat logs.
 * 3. Generates opaque `subscriber_token` & 1-click `claim_url` so users don't even have to type
 *    their email/phone into the LLM chat if they prefer to claim the reminder out-of-band.
 */
export class PrivacyMinimizer {
  sanitizeAndDistillContext(
    rawContext: string,
    baseUrl = config.cloud.renderExternalUrl || 'http://localhost:3456'
  ): MinimalPersonalContext {
    let text = (rawContext || '').trim();
    let redactedCount = 0;

    for (const rule of PII_PATTERNS) {
      const matches = text.match(rule.regex);
      if (matches) {
        redactedCount += matches.length;
        text = text.replace(rule.regex, rule.replacement);
      }
    }

    // Extract only actionable preparation items (e.g., essays, references, transcripts)
    const sentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.replace(/^(?:User|Assistant|AI|Human):\s*/i, '').trim())
      .filter(Boolean);

    const actionItems: string[] = [];
    for (const sentence of sentences) {
      if (ACTIONABLE_KEYWORDS.test(sentence) && sentence.length <= 160) {
        actionItems.push(sentence);
      }
    }

    // Keep the stored note strictly minimal (max 240 chars)
    const sanitizedNote =
      text.length > 240 ? `${text.slice(0, 237).trim()}...` : text || 'Monitor opening window.';

    const subscriberToken = `prm_${crypto.randomBytes(6).toString('hex')}`;
    const claimUrl = `${baseUrl}/claim/${subscriberToken}`;

    return {
      sanitizedNote,
      actionItems: actionItems.slice(0, 4),
      redactedCount,
      subscriberToken,
      claimUrl
    };
  }

  /**
   * Masks a delivery target (email or phone/webhook) for safe UI/audit display
   * e.g., "student@university.edu" -> "st***t@university.edu"
   */
  maskDeliveryTarget(target: string | null | undefined): string {
    if (!target) return 'anonymous-claim-token';
    const trimmed = target.trim();
    const atIndex = trimmed.indexOf('@');
    if (atIndex > 2) {
      const local = trimmed.slice(0, atIndex);
      const domain = trimmed.slice(atIndex);
      return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
    }
    if (trimmed.length > 8) {
      return `${trimmed.slice(0, 4)}***${trimmed.slice(-2)}`;
    }
    return '***';
  }
}

const DEFAULT_DISALLOWED_EMAILS = [
  'student@university.edu',
  'developer@example.com',
  'ambient-developer@example.com',
  'demo@example.com'
];

export const DISALLOWED_AMBIENT_EMAILS = new Set([
  ...DEFAULT_DISALLOWED_EMAILS,
  ...(process.env.DISALLOWED_AMBIENT_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
]);

export function isDisallowedAmbientEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== 'string') return true;
  const normalized = email.trim().toLowerCase();
  return DISALLOWED_AMBIENT_EMAILS.has(normalized);
}

export const privacyMinimizer = new PrivacyMinimizer();
