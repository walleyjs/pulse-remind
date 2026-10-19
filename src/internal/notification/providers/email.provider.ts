import type { WatchRecord } from '../../watch/model.ts';
import type { EvaluationResult } from '../../resolution/types.ts';
import { buildWatchIcsFeed } from '../../../pkg/calendar/ics.ts';

const emailHtmlStore = new Map<string, string>();

export interface EmailSendResult {
  deliveryStatus: 'delivered' | 'simulated' | 'failed';
  provider: 'resend_api' | 'in_app_preview';
  externalId?: string;
  retryAfterSeconds?: number;
  error?: string;
}

export class EmailProvider {
  storeRenderedHtml(notificationId: string, html: string): void {
    emailHtmlStore.set(notificationId, html);
  }

  getRenderedHtml(notificationId: string): string | null {
    return emailHtmlStore.get(notificationId) || null;
  }

  /**
   * Sends a real transactional HTML email via Resend (`RESEND_API_KEY`) with RFC 5545 `.ics` attachment if configured,
   * or falls back to storing the rendered HTML preview in the dashboard.
   */
  async sendEmail(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    fromEmail?: string;
    icsAttachmentContent?: string;
    icsFilename?: string;
  }): Promise<EmailSendResult> {
    const resendApiKey = process.env.RESEND_API_KEY || '';
    const fromAddress =
      params.fromEmail ||
      process.env.RESEND_FROM_EMAIL ||
      'PulseRemind Alerts <onboarding@resend.dev>';

    if (!resendApiKey || params.to === 'student@university.edu') {
      return {
        deliveryStatus: 'simulated',
        provider: 'in_app_preview'
      };
    }

    try {
      const payload: Record<string, unknown> = {
        from: fromAddress,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text
      };

      if (params.icsAttachmentContent) {
        payload.attachments = [
          {
            filename: params.icsFilename || 'invite.ics',
            content: Buffer.from(params.icsAttachmentContent, 'utf-8').toString('base64')
          }
        ];
      }

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) || 60 : undefined;
        const errBody = await res.text().catch(() => res.statusText);
        return {
          deliveryStatus: 'failed',
          provider: 'resend_api',
          retryAfterSeconds,
          error: `Resend HTTP ${res.status}: ${errBody.slice(0, 180)}`
        };
      }

      const data = (await res.json()) as { id?: string };
      return {
        deliveryStatus: 'delivered',
        provider: 'resend_api',
        externalId: data.id
      };
    } catch (err) {
      return {
        deliveryStatus: 'failed',
        provider: 'resend_api',
        error: (err as Error).message
      };
    }
  }

  buildWatchIcsAttachment(watch: WatchRecord, baseUrl = 'https://pulse-remind.onrender.com'): string {
    return buildWatchIcsFeed([watch], baseUrl);
  }

  buildOpportunityOpenHtml(watch: WatchRecord, evaluation: EvaluationResult): string {
    const applyUrl = evaluation.detectedApplyUrl || watch.target_url || '#';
    const deadline = evaluation.detectedDeadline || 'See official portal';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Reminder Triggered: ${watch.title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 32px; margin: 0; }
    .card { max-width: 600px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 14px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    .banner { background: linear-gradient(135deg, #10b981, #059669); padding: 24px 28px; color: #ffffff; }
    .badge { display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .content { padding: 28px; line-height: 1.6; color: #cbd5e1; }
    .context-box { background: #0f172a; border-left: 4px solid #38bdf8; padding: 14px 16px; border-radius: 6px; margin: 16px 0; font-size: 14px; color: #e2e8f0; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0; background: #0f172a; padding: 16px; border-radius: 8px; }
    .meta-label { font-size: 11px; text-transform: uppercase; color: #94a3b8; }
    .meta-val { font-size: 14px; font-weight: 700; color: #f8fafc; margin-top: 4px; }
    .btn { display: inline-block; background: #10b981; color: #052e16; font-weight: 700; text-decoration: none; padding: 14px 24px; border-radius: 8px; margin-top: 12px; }
    .footer { padding: 18px 28px; background: #0f172a; font-size: 12px; color: #64748b; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="banner">
      <span class="badge">PulseRemind Alert • Live Now</span>
      <h1 style="margin: 10px 0 4px; font-size: 22px;">${watch.title}</h1>
      <p style="margin: 0; opacity: 0.9; font-size: 14px;">Detected by PulseRemind Resolution Engine</p>
    </div>
    <div class="content">
      <p>Good news! During your earlier conversation in <strong>${watch.source_chat_client}</strong>, you set a reminder for <strong>${watch.title}</strong> (${watch.window_label || 'scheduled window'}).</p>
      <div class="context-box">
        <strong>Your Action Checklist:</strong><br/>
        ${watch.chat_context}
      </div>
      <p><strong>What our Resolution Engine detected:</strong><br/>
      <em>"${evaluation.extractedSnippet || evaluation.summary}"</em></p>
      <div class="meta-grid">
        <div>
          <div class="meta-label">Status</div>
          <div class="meta-val" style="color: #34d399;">OPEN / LIVE (${Math.round(evaluation.confidence * 100)}% Match)</div>
        </div>
        <div>
          <div class="meta-label">Detected Deadline</div>
          <div class="meta-val">${deadline}</div>
        </div>
      </div>
      <a class="btn" href="${applyUrl}" target="_blank" rel="noopener">Open Official Page &rarr;</a>
    </div>
    <div class="footer">
      Watch ID: ${watch.id} • Monitored URL: ${watch.target_url || 'Scheduled Date Reminder'}
    </div>
  </div>
</body>
</html>`;
  }
}

export const emailProvider = new EmailProvider();
