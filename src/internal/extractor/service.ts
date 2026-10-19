import type { CreateWatchInput } from '../watch/model.ts';
import { resolveTimeframeWindow } from './timeframe.ts';

export interface ExtractedChatOpportunity {
  title: string;
  category: string;
  chat_context: string;
  target_url: string | null;
  window_start_date: string | null;
  window_label: string;
  condition_text: string;
  confidence: number;
  reasoning: string;
}

interface CanonicalRegistryEntry {
  canonicalTitle: string;
  category: string;
  keywords: RegExp;
  defaultSlug: string;
  defaultTimeframe?: string;
}

const CANONICAL_OPPORTUNITY_REGISTRY: CanonicalRegistryEntry[] = [
  {
    canonicalTitle: 'Chevening Emerging Leaders Scholarship 2027',
    category: 'scholarship',
    keywords: /\bchevening\b/i,
    defaultSlug: 'chevening-emerging-leaders',
    defaultTimeframe: 'early next year'
  },
  {
    canonicalTitle: 'Fulbright Foreign Student Fellowship 2027',
    category: 'scholarship',
    keywords: /\bfulbright\b/i,
    defaultSlug: 'chevening-emerging-leaders',
    defaultTimeframe: 'early next year'
  },
  {
    canonicalTitle: 'Gates Cambridge Graduate Scholarship 2027',
    category: 'scholarship',
    keywords: /\bgates\s+cambridge\b/i,
    defaultSlug: 'global-ai-fellowship',
    defaultTimeframe: 'end of this month'
  },
  {
    canonicalTitle: 'Rhodes Global Postgraduate Scholarship 2027',
    category: 'scholarship',
    keywords: /\brhodes\b/i,
    defaultSlug: 'global-ai-fellowship',
    defaultTimeframe: 'end of this month'
  },
  {
    canonicalTitle: 'Knight-Hennessy Stanford Scholars Program 2027',
    category: 'scholarship',
    keywords: /\bknight[\s\-]hennessy\b/i,
    defaultSlug: 'global-ai-fellowship',
    defaultTimeframe: 'end of this month'
  },
  {
    canonicalTitle: 'Y Combinator Startup Batch Application',
    category: 'accelerator',
    keywords: /\b(?:y\s+combinator|yc\s+batch|yc\s+application)\b/i,
    defaultSlug: 'global-ai-fellowship',
    defaultTimeframe: 'early next year'
  },
  {
    canonicalTitle: 'Apple WWDC Developer Conference Registration',
    category: 'event',
    keywords: /\bwwdc\b/i,
    defaultSlug: 'global-ai-fellowship',
    defaultTimeframe: 'next month'
  }
];

export function inferCategoryFromText(text: string): string {
  if (/ticket|concert|festival|presale|on sale/i.test(text)) return 'tickets';
  if (/conference|summit|hackathon|expo/i.test(text)) return 'conference';
  if (/meetup|event|workshop|registration/i.test(text)) return 'event';
  if (/launch|release|drop|preorder|restock|beta/i.test(text)) return 'product_launch';
  if (/accelerator|combinator|pitch|incubat/i.test(text)) return 'accelerator';
  if (/grant/i.test(text)) return 'grant';
  if (/scholarship|fellowship|tuition|university|admission|bursary|phd|master/i.test(text)) return 'scholarship';
  return 'reminder';
}

export class ChatExtractorService {
  resolveCanonicalUrl(
    titleOrText: string,
    windowLabel: string,
    defaultDemoBaseUrl = 'http://localhost:3456'
  ): string {
    for (const entry of CANONICAL_OPPORTUNITY_REGISTRY) {
      if (entry.keywords.test(titleOrText)) {
        return `${defaultDemoBaseUrl}/demo/scholarships/${entry.defaultSlug}`;
      }
    }
    if (
      windowLabel.toLowerCase().includes('next year') ||
      titleOrText.toLowerCase().includes('emerging') ||
      titleOrText.toLowerCase().includes('chevening')
    ) {
      return `${defaultDemoBaseUrl}/demo/scholarships/chevening-emerging-leaders`;
    }
    return `${defaultDemoBaseUrl}/demo/scholarships/global-ai-fellowship`;
  }

  extractWatchesFromTranscript(
    transcript: string,
    defaultDemoBaseUrl = 'http://localhost:3456'
  ): ExtractedChatOpportunity[] {
    const results: ExtractedChatOpportunity[] = [];
    const clean = transcript.trim();
    if (!clean) return results;

    const urlMatches = clean.match(/https?:\/\/[^\s)"'>]+/gi) || [];

    const namedPatterns = [
      /([A-Z][A-Za-z0-9&’'\-]+(?:\s+[A-Z0-9][A-Za-z0-9&’'\-]+){0,5}\s+(?:Scholarship|Fellowship|Grant|Program|Award|Admission|Bursary|Fund|Conference|Summit|Hackathon|Festival|Concert|Tickets|Registration|Launch|Accelerator|Cohort|Event)(?:\s+202\d)?)/g
    ];

    const foundTitles = new Set<string>();
    const matches: Array<{ title: string; index: number }> = [];

    for (const regex of namedPatterns) {
      let m: RegExpExecArray | null;
      while ((m = regex.exec(clean)) !== null) {
        const candidate = m[1].replace(/^(?:the|for|about|apply to|apply for|attend|join)\s+/i, '').trim();
        if (candidate.length >= 6 && !foundTitles.has(candidate.toLowerCase())) {
          foundTitles.add(candidate.toLowerCase());
          matches.push({ title: candidate, index: m.index });
        }
      }
    }

    // Match implicit shorthand mentions from our Canonical Opportunity & Event Registry
    for (const entry of CANONICAL_OPPORTUNITY_REGISTRY) {
      const m = entry.keywords.exec(clean);
      if (m) {
        const alreadyCovered = Array.from(foundTitles).some((t) => entry.keywords.test(t));
        if (!alreadyCovered) {
          foundTitles.add(entry.canonicalTitle.toLowerCase());
          matches.push({ title: entry.canonicalTitle, index: m.index });
        }
      }
    }

    matches.sort((a, b) => a.index - b.index);

    if (matches.length === 0) {
      const windowInfo = resolveTimeframeWindow(clean);
      const targetUrl =
        urlMatches[0] || this.resolveCanonicalUrl(clean, windowInfo.window_label, defaultDemoBaseUrl);
      const category = inferCategoryFromText(clean);

      results.push({
        title:
          category === 'scholarship'
            ? 'Graduate School Scholarship Application'
            : category === 'event'
              ? 'Upcoming Event Registration Reminder'
              : category === 'ticket_drop'
                ? 'Event Ticket On-Sale Reminder'
                : 'Planned Event & Opportunity Reminder',
        category,
        chat_context: clean.slice(0, 360),
        target_url: targetUrl,
        window_start_date: windowInfo.window_start_date,
        window_label: windowInfo.window_label,
        condition_text: `Event or registration opens (${windowInfo.window_label})`,
        confidence: 0.85,
        reasoning: `Detected future-dated event/planning intent ("${windowInfo.window_label}") in conversation.`
      });
      return results;
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const startIdx = Math.max(0, current.index - 80);
      const endIdx =
        i + 1 < matches.length
          ? Math.min(clean.length, matches[i + 1].index + 40)
          : Math.min(clean.length, current.index + 280);
      const localContext = clean.slice(startIdx, endIdx).trim();

      const clauseEndIdx =
        i + 1 < matches.length ? matches[i + 1].index : Math.min(clean.length, current.index + 220);
      const clauseForWindow = clean.slice(current.index, clauseEndIdx);
      const windowInfo = resolveTimeframeWindow(clauseForWindow);

      const localUrlMatch = localContext.match(/https?:\/\/[^\s)"'>]+/i);
      let targetUrl = localUrlMatch ? localUrlMatch[0] : urlMatches[i] || null;
      if (!targetUrl) {
        targetUrl = this.resolveCanonicalUrl(
          current.title,
          windowInfo.window_label,
          defaultDemoBaseUrl
        );
      }

      results.push({
        title: current.title,
        category: inferCategoryFromText(current.title),
        chat_context: `From AI chat session: "${localContext}"`,
        target_url: targetUrl,
        window_start_date: windowInfo.window_start_date,
        window_label: windowInfo.window_label,
        condition_text: `${current.title} transitions to open/live (${windowInfo.window_label})`,
        confidence: 0.94,
        reasoning: `Extracted "${current.title}" with target window "${windowInfo.window_label}" and linked monitor target.`
      });
    }

    return results;
  }

  toWatchInput(extracted: ExtractedChatOpportunity, recipientEmail?: string): CreateWatchInput {
    return {
      title: extracted.title,
      category: extracted.category,
      chat_context: extracted.chat_context,
      source_chat_client: 'AI Chat Auto-Extractor',
      target_url: extracted.target_url,
      trigger_type: extracted.target_url ? 'hybrid' : 'scheduled_date',
      condition_text: extracted.condition_text,
      window_start_date: extracted.window_start_date,
      window_label: extracted.window_label,
      notify_channels: ['in_app', 'email'],
      recipient_email: recipientEmail || 'student@university.edu'
    };
  }
}

export const chatExtractorService = new ChatExtractorService();

export function extractWatchesFromChatTranscript(
  transcript: string,
  defaultDemoBaseUrl = 'http://localhost:3456'
): ExtractedChatOpportunity[] {
  return chatExtractorService.extractWatchesFromTranscript(transcript, defaultDemoBaseUrl);
}

export function convertExtractedToWatchInput(
  extracted: ExtractedChatOpportunity,
  recipientEmail?: string
): CreateWatchInput {
  return chatExtractorService.toWatchInput(extracted, recipientEmail);
}
