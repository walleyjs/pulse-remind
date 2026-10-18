export interface DemoPortalRecord {
  slug: string;
  title: string;
  organization: string;
  is_open: boolean;
  open_date_text: string;
  deadline_text: string;
  award_amount: string;
  custom_banner: string | null;
  updated_at: string;
}
