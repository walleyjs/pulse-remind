import { config } from '../../config/index.ts';
import { demoPortalRepository } from '../../internal/demo/repository.ts';
import { notificationRepository } from '../../internal/notification/repository.ts';
import { watchRepository } from '../../internal/watch/repository.ts';
import { runSchemaMigrations } from './sqlite.ts';

export function initDatabase(seedIfEmpty = true): void {
  runSchemaMigrations();
  notificationRepository.seedDefaultChannels();
  demoPortalRepository.seedDefaults();

  if (seedIfEmpty && watchRepository.count() === 0) {
    const port = config.port;
    watchRepository.create({
      title: 'Global AI & STEM Graduate Scholarship 2027',
      category: 'scholarship',
      chat_context:
        'User is planning their Fall 2027 MSc in Computer Science applications. In the LLM chat, we drafted their statement of purpose and noted that the Horizon Global AI & STEM Scholarship ($45k) does not open until the end of this month.',
      source_chat_client: 'Claude Desktop (MCP)',
      target_url: `http://localhost:${port}/demo/scholarships/global-ai-fellowship`,
      trigger_type: 'web_monitor',
      condition_text: 'Applications open for the 2027 cohort with an active Apply Now button',
      expected_keywords: ['applications are now open', 'apply now', 'start your application', 'submit application'],
      closed_keywords: ['currently closed', 'will open at the end of', 'check back soon', 'not yet open'],
      window_start_date: '2026-10-28',
      window_label: 'End of Month (Oct 2026)',
      check_interval_minutes: 30,
      notify_channels: ['in_app', 'email'],
      recipient_email: config.defaultRecipientEmail
    });

    watchRepository.create({
      title: 'Emerging Leaders International Master’s Grant 2027',
      category: 'scholarship',
      chat_context:
        'During school planning session, user asked about full-funding options in the UK. We identified the Emerging Leaders Grant (£38,000) which opens early next year (January 2027) and requires two academic references.',
      source_chat_client: 'ChatGPT Tool Action',
      target_url: `http://localhost:${port}/demo/scholarships/chevening-emerging-leaders`,
      trigger_type: 'hybrid',
      condition_text: '2027 application portal opens in early 2027',
      expected_keywords: ['applications are now open', 'apply online now', 'portal is open'],
      closed_keywords: ['has not yet opened', 'opens early next year', 'currently closed'],
      window_start_date: '2027-01-05',
      window_label: 'Early Next Year (Jan 2027)',
      check_interval_minutes: 120,
      notify_channels: ['in_app', 'email'],
      recipient_email: config.defaultRecipientEmail
    });
  }
}
