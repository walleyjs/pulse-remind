import { db } from '../../pkg/db/sqlite.ts';
import type { DemoPortalRecord } from './model.ts';

export class DemoPortalRepository {
  seedDefaults(): void {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO demo_portal_state (
        slug, title, organization, is_open, open_date_text, deadline_text, award_amount, custom_banner, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      'global-ai-fellowship',
      'Global AI & STEM Graduate Scholarship 2027',
      'Horizon Science Foundation',
      0,
      'End of October 2026',
      'January 15, 2027',
      '$45,000 Full Tuition + Stipend',
      'Applications for the 2027 cohort are currently CLOSED and will open at the end of October 2026. Check back soon.',
      now
    );

    stmt.run(
      'chevening-emerging-leaders',
      'Emerging Leaders International Master’s Grant 2027',
      'Commonwealth Academic Trust',
      0,
      'Early January 2027',
      'March 31, 2027',
      '£38,000 Full Award + Travel',
      'The 2027 application cycle has not yet opened. Portal opens early next year (January 2027).',
      now
    );
  }

  list(): DemoPortalRecord[] {
    const rows = db.prepare('SELECT * FROM demo_portal_state ORDER BY slug ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      organization: String(r.organization),
      is_open: Boolean(r.is_open),
      open_date_text: String(r.open_date_text),
      deadline_text: String(r.deadline_text),
      award_amount: String(r.award_amount),
      custom_banner: r.custom_banner ? String(r.custom_banner) : null,
      updated_at: String(r.updated_at)
    }));
  }

  getBySlug(slug: string): DemoPortalRecord | null {
    const r = db
      .prepare('SELECT * FROM demo_portal_state WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      slug: String(r.slug),
      title: String(r.title),
      organization: String(r.organization),
      is_open: Boolean(r.is_open),
      open_date_text: String(r.open_date_text),
      deadline_text: String(r.deadline_text),
      award_amount: String(r.award_amount),
      custom_banner: r.custom_banner ? String(r.custom_banner) : null,
      updated_at: String(r.updated_at)
    };
  }

  setOpenState(slug: string, isOpen: boolean, customBanner?: string): DemoPortalRecord | null {
    const existing = this.getBySlug(slug);
    if (!existing) return null;
    const now = new Date().toISOString();
    const banner =
      customBanner !== undefined
        ? customBanner
        : isOpen
          ? `Applications for ${existing.title} are NOW OPEN! Submit your online application before ${existing.deadline_text}.`
          : `Applications for ${existing.title} are currently CLOSED and will open ${existing.open_date_text}. Check back soon.`;

    db.prepare(`
      UPDATE demo_portal_state
      SET is_open = ?, custom_banner = ?, updated_at = ?
      WHERE slug = ?
    `).run(isOpen ? 1 : 0, banner, now, slug);

    return this.getBySlug(slug);
  }
}

export const demoPortalRepository = new DemoPortalRepository();
