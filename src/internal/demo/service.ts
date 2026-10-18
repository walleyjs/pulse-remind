import { demoPortalRepository, DemoPortalRepository } from './repository.ts';
import type { DemoPortalRecord } from './model.ts';

export class DemoPortalService {
  private readonly repo: DemoPortalRepository;

  constructor(repo: DemoPortalRepository = demoPortalRepository) {
    this.repo = repo;
  }

  listPortals(): DemoPortalRecord[] {
    return this.repo.list();
  }

  getPortal(slug: string): DemoPortalRecord | null {
    return this.repo.getBySlug(slug);
  }

  setPortalOpenState(slug: string, isOpen: boolean, customBanner?: string): DemoPortalRecord | null {
    return this.repo.setOpenState(slug, isOpen, customBanner);
  }

  renderScholarshipHtml(portal: DemoPortalRecord): string {
    const statusAttr = portal.is_open ? 'open' : 'closed';
    const badgeColor = portal.is_open ? '#059669' : '#d97706';
    const badgeBg = portal.is_open ? '#d1fae5' : '#fef3c7';
    const badgeText = portal.is_open
      ? 'APPLICATIONS ARE NOW OPEN FOR 2027 COHORT'
      : `APPLICATIONS CURRENTLY CLOSED • OPENS ${portal.open_date_text.toUpperCase()}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${portal.title} — ${portal.organization}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Georgia', 'Times New Roman', serif;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.65;
    }
    .sim-bar {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e293b;
      color: #f8fafc;
      padding: 10px 24px;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #38bdf8;
    }
    .sim-bar a { color: #38bdf8; text-decoration: none; font-weight: 600; }
    .container { max-width: 820px; margin: 40px auto; padding: 0 24px; }
    .uni-header {
      border-bottom: 3px solid #1e3a8a;
      padding-bottom: 18px;
      margin-bottom: 28px;
    }
    .org-name {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #1e3a8a;
      font-weight: 700;
      font-size: 13px;
    }
    h1 { margin: 8px 0 12px; font-size: 32px; color: #0f172a; }
    .status-banner {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: ${badgeBg};
      border-left: 5px solid ${badgeColor};
      padding: 18px 22px;
      border-radius: 8px;
      margin: 24px 0;
    }
    .status-pill {
      display: inline-block;
      color: ${badgeColor};
      font-weight: 800;
      font-size: 12px;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.05);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin: 24px 0;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .stat {
      background: #f1f5f9;
      padding: 14px 16px;
      border-radius: 8px;
    }
    .stat-label { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
    .stat-value { font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 4px; }
    .apply-btn {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      display: inline-block;
      background: #059669;
      color: #ffffff;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 16px;
      margin-top: 12px;
    }
    .closed-btn {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      display: inline-block;
      background: #cbd5e1;
      color: #475569;
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 15px;
      margin-top: 12px;
      cursor: not-allowed;
    }
  </style>
</head>
<body data-portal-status="${statusAttr}">
  <div class="sim-bar">
    <span>🔬 <strong>Simulated External Scholarship Webpage</strong> (Monitored by PulseRemind Web Scraper)</span>
    <a href="/">&larr; Back to PulseRemind Dashboard</a>
  </div>
  <div class="container">
    <div class="uni-header">
      <div class="org-name">${portal.organization} • Official Scholarship Portal</div>
      <h1>${portal.title}</h1>
    </div>

    <div class="status-banner">
      <div class="status-pill">${badgeText}</div>
      <div style="font-size: 15px; color: #1e293b;">
        ${portal.custom_banner || ''}
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Program Overview & Eligibility</h2>
      <p>
        The <strong>${portal.title}</strong> supports outstanding graduate students pursuing advanced degrees.
        Recipients receive full tuition coverage, a living stipend, and an international research allowance.
      </p>

      <div class="grid">
        <div class="stat">
          <div class="stat-label">Award Value</div>
          <div class="stat-value">${portal.award_amount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Opening Window</div>
          <div class="stat-value">${portal.open_date_text}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Submission Deadline</div>
          <div class="stat-value">${portal.deadline_text}</div>
        </div>
      </div>

      ${
        portal.is_open
          ? `<p><strong>Applications are now open!</strong> Please prepare your academic transcripts, CV, statement of purpose, and two letters of recommendation. Submission deadline: ${portal.deadline_text}.</p>
             <a class="apply-btn" href="/demo/scholarships/${portal.slug}/apply">Apply Now — Start Your 2027 Application &rarr;</a>`
          : `<p><strong>Applications are currently closed.</strong> The online portal will open ${portal.open_date_text}. Check back soon to start your application.</p>
             <span class="closed-btn">Portal Locked Until ${portal.open_date_text}</span>`
      }
    </div>
  </div>
</body>
</html>`;
  }
}

export const demoPortalService = new DemoPortalService();
