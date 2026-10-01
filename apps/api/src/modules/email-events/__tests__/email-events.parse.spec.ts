import { messageIdVariants, parseBrevoEvents, parseResendEvent } from '../email-events.parse';

describe('parseBrevoEvents', () => {
  it('traduce entregas, rebotes y errores; ignora aperturas y rebotes temporales', () => {
    const events = parseBrevoEvents([
      {
        event: 'delivered',
        'message-id': '<a@mailin.fr>',
        email: 'x@y.es',
        date: '2026-10-01 10:00:00',
      },
      {
        event: 'hard_bounce',
        'message-id': '<b@mailin.fr>',
        email: 'x@y.es',
        reason: 'mailbox full',
      },
      {
        event: 'error',
        'message-id': '<c@mailin.fr>',
        email: 'x@y.es',
        reason: 'the sender you used no-reply@trasteros.pro is not valid',
      },
      { event: 'opened', 'message-id': '<d@mailin.fr>' },
      { event: 'soft_bounce', 'message-id': '<e@mailin.fr>' },
      { event: 'delivered' },
    ]);
    expect(events.map((e) => [e.messageId, e.outcome])).toEqual([
      ['<a@mailin.fr>', 'delivered'],
      ['<b@mailin.fr>', 'bounced'],
      ['<c@mailin.fr>', 'failed'],
    ]);
    expect(events[1]!.reason).toBe('Rebote permanente: mailbox full');
    expect(events[2]!.reason).toContain('is not valid');
    expect(events[0]!.reason).toBeNull();
  });

  it('acepta un objeto suelto', () => {
    expect(parseBrevoEvents({ event: 'blocked', 'message-id': 'm1' })).toHaveLength(1);
    expect(parseBrevoEvents(null)).toEqual([]);
  });
});

describe('parseResendEvent', () => {
  it('rebote con motivo y entrega', () => {
    const [b] = parseResendEvent({
      type: 'email.bounced',
      created_at: '2026-10-01T10:00:00Z',
      data: { email_id: 're_1', to: ['x@y.es'], bounce: { message: 'Mailbox does not exist' } },
    });
    expect(b).toMatchObject({ messageId: 're_1', outcome: 'bounced', recipient: 'x@y.es' });
    expect(b!.reason).toBe('Rebote: Mailbox does not exist');
    expect(
      parseResendEvent({ type: 'email.delivered', data: { email_id: 're_2' } })[0]!.outcome,
    ).toBe('delivered');
    expect(parseResendEvent({ type: 'email.opened', data: { email_id: 're_3' } })).toEqual([]);
  });
});

describe('messageIdVariants', () => {
  it('con y sin ángulos', () => {
    expect(messageIdVariants('<a@b>')).toEqual(['<a@b>', 'a@b']);
    expect(messageIdVariants('a@b')).toEqual(['a@b', '<a@b>']);
  });
});
