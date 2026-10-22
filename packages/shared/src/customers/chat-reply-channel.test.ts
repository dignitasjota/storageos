import { describe, expect, it } from 'vitest';

import { chatReplyChannel } from './types';

const now = new Date('2026-10-22T12:00:00Z');
const at = (h: number) => new Date(now.getTime() - h * 3600 * 1000).toISOString();

describe('chatReplyChannel', () => {
  it('sin mensajes del inquilino, solo portal', () => {
    expect(chatReplyChannel([], now)).toBeNull();
    expect(
      chatReplyChannel([{ senderType: 'staff', channel: 'portal', createdAt: at(1) }], now),
    ).toBeNull();
  });

  it('usa el canal del último mensaje del inquilino', () => {
    expect(
      chatReplyChannel(
        [
          { senderType: 'customer', channel: 'whatsapp', createdAt: at(5) },
          { senderType: 'customer', channel: 'email', createdAt: at(2) },
        ],
        now,
      ),
    ).toBe('email');
    expect(
      chatReplyChannel([{ senderType: 'customer', channel: 'portal', createdAt: at(1) }], now),
    ).toBeNull();
  });

  it('WhatsApp solo dentro de las 24 h', () => {
    expect(
      chatReplyChannel([{ senderType: 'customer', channel: 'whatsapp', createdAt: at(23) }], now),
    ).toBe('whatsapp');
    expect(
      chatReplyChannel([{ senderType: 'customer', channel: 'whatsapp', createdAt: at(25) }], now),
    ).toBeNull();
  });
});
