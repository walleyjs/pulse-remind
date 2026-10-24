import type { NotificationChannelType } from '../watch/model.ts';

export type EscalationPriority = 'standard' | 'high' | 'critical';

export interface EscalationRule {
  priority: EscalationPriority;
  channels: NotificationChannelType[];
  delaySecondsBetweenStages: number;
}

export const DEFAULT_ESCALATION_POLICIES: Record<EscalationPriority, EscalationRule> = {
  standard: {
    priority: 'standard',
    channels: ['in_app', 'email'],
    delaySecondsBetweenStages: 0
  },
  high: {
    priority: 'high',
    channels: ['in_app', 'web_push', 'email', 'slack'],
    delaySecondsBetweenStages: 60
  },
  critical: {
    priority: 'critical',
    channels: ['in_app', 'web_push', 'email', 'slack', 'discord', 'telegram', 'whatsapp'],
    delaySecondsBetweenStages: 0
  }
};

export function resolveEscalationChannels(
  configuredChannels: NotificationChannelType[],
  priority: EscalationPriority = 'standard'
): NotificationChannelType[] {
  const policy = DEFAULT_ESCALATION_POLICIES[priority] || DEFAULT_ESCALATION_POLICIES.standard;
  const merged = new Set<NotificationChannelType>(['in_app']);

  for (const ch of configuredChannels) {
    merged.add(ch);
  }

  if (priority === 'high' || priority === 'critical') {
    for (const ch of policy.channels) {
      merged.add(ch);
    }
  }

  return Array.from(merged);
}
