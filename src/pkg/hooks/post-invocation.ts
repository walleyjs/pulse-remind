import fs from 'node:fs';
import { initDatabase } from '../db/bootstrap.ts';
import { chatExtractorService } from '../../internal/extractor/service.ts';
import { watchService } from '../../internal/watch/service.ts';
import { executeMcpTool } from '../mcp/tools.ts';
import { isDisallowedAmbientEmail } from '../privacy/minimizer.ts';

export interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  content?: string;
  tool_calls?: Array<{
    name?: string;
    arguments?: Record<string, unknown>;
  }>;
}

export interface HookInputPayload {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  modelName?: string;
}

export interface HookOutputPayload {
  injectSteps?: Array<
    | { ephemeralMessage: string }
    | { userMessage: string }
    | { systemMessage: { systemMessage: string; metadata?: Record<string, unknown> } }
  >;
  terminationBehavior?: 'force_continue' | 'terminate' | '';
  hookAction?: 'auto_captured_watch' | 'auto_bound_email' | 'noop';
  capturedTitles?: string[];
  boundEmail?: string | null;
}

const EVENT_INTENT_CUE =
  /\b(opens?\b|opening\b|deadline\b|due\b|register|registration|tickets?\b|on\s+sale|launch|scholarship|fellowship|grant|conference|summit|wwdc|fulbright|chevening|gates\s+cambridge|rhodes|knight[\s\-]hennessy|y\s+combinator|end\s+of\s+(?:this\s+|the\s+)?month|early\s+next\s+year|next\s+month|next\s+(?:monday|tuesday|wednesday|thursday|friday)|aoe\b)/i;

const EMAIL_EXTRACT_REGEX = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/;

/**
 * Deterministically inspects raw Antigravity `transcript.jsonl` content for the latest turn:
 * 1. If an unbound watch exists and the user replied with an email address (and the LLM skipped `set_notification_destination`),
 *    automatically binds the email in SQLite and saves it as the persistent default.
 * 2. If the user mentioned an upcoming event, conference, ticket drop, launch, registration, deadline, or scholarship
 *    (and the LLM skipped `create_opportunity_watch` / `extract_watches_from_chat`), automatically captures the watch
 *    and injects an `ephemeralMessage` step when `ACTION_REQUIRED_ASK_USER_FOR_EMAIL` is triggered.
 */
export async function evaluateTranscriptTurnForHook(
  transcriptJsonlText: string
): Promise<HookOutputPayload> {
  initDatabase(false);

  const lines = transcriptJsonlText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const steps: TranscriptStep[] = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line) as TranscriptStep);
    } catch {
      // Ignore malformed JSONL lines
    }
  }

  // Locate the most recent USER_INPUT step
  let lastUserIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === 'USER_INPUT' && steps[i].content) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    return { hookAction: 'noop' };
  }

  const userText = (steps[lastUserIdx].content || '').trim();
  // Skip slash commands or plugin-authoring meta prompts
  if (userText.startsWith('/plugin') || userText.includes('<USER_REQUEST>\n/plugin')) {
    return { hookAction: 'noop' };
  }

  // Collect tool calls emitted by the model after this USER_INPUT
  const calledTools = new Set<string>();
  for (let i = lastUserIdx + 1; i < steps.length; i++) {
    const tcList = steps[i].tool_calls || [];
    for (const tc of tcList) {
      if (tc.name) {
        calledTools.add(tc.name);
      }
    }
  }

  const toolAlreadyCalled = (shortName: string) =>
    Array.from(calledTools).some((t) => t === shortName || t.endsWith(`_${shortName}`));

  // 1. Check if the user is replying with their email address to bind an unbound watch
  const existingWatches = watchService.listWatches();
  const hasUnboundWatches = existingWatches.some(
    (w) => !w.recipient_email || isDisallowedAmbientEmail(w.recipient_email)
  );

  const isNegativeEmailContext =
    /\b(?:not\s+(?:my|the|your)|wrong\s+email|isn'?t\s+(?:my|the)|is\s+not\s+(?:my|the)|don'?t\s+use|remove\s+email|stop\s+using|alert\s+i\s+got|why\s+did\s+you)\b/i.test(
      userText
    );

  const emailMatch = userText.match(EMAIL_EXTRACT_REGEX);
  const candidateEmail = emailMatch ? emailMatch[1].trim() : null;
  const isPureEmailInput = candidateEmail ? /^\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*$/.test(userText.trim()) : false;
  const hasExplicitBindingPhrase =
    /\b(?:(?:my\s+)?email\s+(?:is|address\s+is)|send\s+(?:my\s+|the\s+)?(?:alerts?|reminders?|updates?|notifications?)\s+to|notify\s+(?:me\s+at)?|use\s+email)\b/i.test(
      userText
    );

  const isAffirmativeBinding =
    !isNegativeEmailContext &&
    hasUnboundWatches &&
    candidateEmail !== null &&
    (isPureEmailInput || hasExplicitBindingPhrase) &&
    !isDisallowedAmbientEmail(candidateEmail);

  if (
    isAffirmativeBinding &&
    candidateEmail &&
    !toolAlreadyCalled('set_notification_destination') &&
    !toolAlreadyCalled('create_opportunity_watch')
  ) {
    await executeMcpTool('set_notification_destination', {
      recipient_email: candidateEmail,
      save_as_default: true
    });
    return {
      hookAction: 'auto_bound_email',
      boundEmail: candidateEmail,
      injectSteps: [
        {
          ephemeralMessage: `[PulseRemind Hook] Bound ${candidateEmail} as the user's persistent default email across their active reminder watch(es).`
        }
      ]
    };
  }

  // 2. Check if the user mentioned an upcoming event/deadline/opportunity and the model forgot to call the MCP capture tool
  if (
    !toolAlreadyCalled('create_opportunity_watch') &&
    !toolAlreadyCalled('extract_watches_from_chat') &&
    EVENT_INTENT_CUE.test(userText)
  ) {
    const candidates = chatExtractorService.extractWatchesFromTranscript(userText);
    const existingTitles = new Set(existingWatches.map((w) => w.title.toLowerCase()));
    const novelCandidates = candidates.filter(
      (c) => !existingTitles.has(c.title.toLowerCase())
    );

    if (novelCandidates.length > 0) {
      const res = (await executeMcpTool('extract_watches_from_chat', {
        transcript: userText,
        auto_create: true,
        recipient_email: isAffirmativeBinding && candidateEmail ? candidateEmail : undefined
      })) as {
        delivery_status: string;
        bound_email: string | null;
        created_watches: Array<{ title: string }>;
        calendar_links?: { google_calendar_url: string } | null;
      };

      const titles = res.created_watches.map((w) => w.title);
      const gcalUrl = res.calendar_links?.google_calendar_url || '';

      if (res.delivery_status === 'ACTION_REQUIRED_ASK_USER_FOR_EMAIL') {
        return {
          hookAction: 'auto_captured_watch',
          capturedTitles: titles,
          boundEmail: null,
          injectSteps: [
            {
              ephemeralMessage: `[PulseRemind Hook] Auto-captured reminder watch for "${titles.join(
                ', '
              )}" (1-Click Google Calendar: ${gcalUrl}). Delivery status is ACTION_REQUIRED_ASK_USER_FOR_EMAIL: ask the user once for their email address in chat so PulseRemind can bind it via set_notification_destination.`
            }
          ]
        };
      }

      return {
        hookAction: 'auto_captured_watch',
        capturedTitles: titles,
        boundEmail: res.bound_email,
        injectSteps: [
          {
            ephemeralMessage: `[PulseRemind Hook] Auto-captured reminder watch for "${titles.join(
              ', '
            )}" bound to ${res.bound_email} (1-Click Google Calendar: ${gcalUrl}).`
          }
        ]
      };
    }
  }

  return { hookAction: 'noop' };
}

async function runCliHook(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const rawStdin = Buffer.concat(chunks).toString('utf-8').trim();
  if (!rawStdin) {
    process.stdout.write('{}\n');
    return;
  }

  try {
    const payload = JSON.parse(rawStdin) as HookInputPayload;
    const transcriptPath = payload.transcriptPath;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.stdout.write('{}\n');
      return;
    }
    const transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
    const result = await evaluateTranscriptTurnForHook(transcriptText);
    const out: Record<string, unknown> = {};
    if (result.injectSteps && result.injectSteps.length > 0) {
      out.injectSteps = result.injectSteps;
    }
    if (result.terminationBehavior) {
      out.terminationBehavior = result.terminationBehavior;
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch {
    process.stdout.write('{}\n');
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCliHook();
}
