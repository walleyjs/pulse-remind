import { EventEmitter } from 'node:events';

export type PulseEventType =
  | 'watch:created'
  | 'watch:updated'
  | 'watch:deleted'
  | 'watch:checked'
  | 'resolution:completed'
  | 'notification:created'
  | 'notification:updated'
  | 'channel:updated';

export interface PulseEvent<T = unknown> {
  id: string;
  type: PulseEventType;
  tenantId: string;
  timestamp: string;
  data: T;
}

export class PulseEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(250);
  }

  emitEvent<T = unknown>(type: PulseEventType, tenantId: string, data: T): void {
    const event: PulseEvent<T> = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      tenantId,
      timestamp: new Date().toISOString(),
      data
    };
    this.emit('pulse-event', event);
    this.emit(`pulse-event:${tenantId}`, event);
    this.emit(type, event);
  }

  subscribeTenant(tenantId: string, listener: (event: PulseEvent) => void): () => void {
    const handler = (event: PulseEvent) => {
      if (
        event.tenantId === tenantId ||
        tenantId === 'tenant_default' ||
        event.tenantId === 'tenant_default' ||
        !tenantId
      ) {
        listener(event);
      }
    };
    this.on('pulse-event', handler);
    return () => {
      this.off('pulse-event', handler);
    };
  }
}

export const eventBus = new PulseEventBus();
