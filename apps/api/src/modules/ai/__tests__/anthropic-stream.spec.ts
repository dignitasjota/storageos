import { AnthropicStreamAccumulator } from '../anthropic-ai-provider';

const ev = (data: Record<string, unknown>) =>
  `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}`;

describe('AnthropicStreamAccumulator', () => {
  it('entrega el texto según llega y reconstruye texto + herramienta con su JSON troceado', () => {
    const deltas: string[] = [];
    const acc = new AnthropicStreamAccumulator((d) => deltas.push(d));
    for (const raw of [
      ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 120 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Voy a ' } }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'mirarlo.' },
      }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'get_monthly_revenue', input: {} },
      }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"mon' },
      }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'ths": 6}' },
      }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 34 },
      }),
      ev({ type: 'message_stop' }),
      'event: ping\ndata: {"type": "ping"}',
    ]) {
      acc.handleEvent(raw);
    }
    expect(deltas).toEqual(['Voy a ', 'mirarlo.']);
    expect(acc.result()).toEqual({
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Voy a mirarlo.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_monthly_revenue', input: { months: 6 } },
      ],
      usage: { inputTokens: 120, outputTokens: 34 },
    });
  });

  it('un evento de error de la API corta el stream', () => {
    const acc = new AnthropicStreamAccumulator(() => undefined);
    expect(() =>
      acc.handleEvent(ev({ type: 'error', error: { type: 'overloaded_error', message: 'x' } })),
    ).toThrow('anthropic_stream_error_overloaded_error');
  });
});
