import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module of the custom UI server, no type declarations
import { ASSISTANT_PLUGIN_NAME, PHILIPS_TV_AI_CONTEXT, registerAssistant } from '../../homebridge-ui/assistant.js';

interface ChatRequest {
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
}

const usage = { inputTokens: 10, outputTokens: 5 };

/** Provider stand-in: no network, replies with `reply` (streamed in two chunks). */
function fakeProvider(reply: string) {
  const requests: ChatRequest[] = [];
  const result = (text: string) => ({
    text,
    toolCalls: [],
    usage,
    stopReason: 'end',
    model: 'fake-model',
    message: { role: 'assistant', content: text },
  });
  const provider = {
    name: 'anthropic',
    model: 'fake-model',
    capabilities: { tools: false, streaming: true, contextTokens: 100_000, jsonMode: false },
    async chat(request: ChatRequest) {
      requests.push(request);
      return result(reply);
    },
    async *stream(request: ChatRequest) {
      requests.push(request);
      const half = Math.ceil(reply.length / 2);
      yield { type: 'text', delta: reply.slice(0, half) };
      yield { type: 'text', delta: reply.slice(half) };
      yield { type: 'done', usage, stopReason: 'end', result: result(reply) };
    },
  };
  return { provider, requests };
}

function fakeServer(homebridgeConfigPath?: string) {
  const handlers = new Map<string, (body: unknown) => unknown>();
  const events: Array<[string, unknown]> = [];
  const server = {
    homebridgeConfigPath,
    onRequest: (path: string, fn: (body: unknown) => unknown) => handlers.set(path, fn),
    pushEvent: (event: string, data: unknown) => events.push([event, data]),
  };
  const call = (path: string, body: unknown = {}) => Promise.resolve(handlers.get(path)!(body));
  return { server, handlers, events, call };
}

async function writeConfig(platforms: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'philips-tv-assistant-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ bridge: { name: 'Homebridge' }, platforms }));
  return path;
}

describe('homebridge-ui Assistant routes', () => {
  it('registers the four Assistant routes', () => {
    const ui = fakeServer();
    registerAssistant(ui.server, { loadConfig: async () => null });
    expect([...ui.handlers.keys()].sort()).toEqual(['/ai/ask', '/ai/config', '/ai/explain', '/ai/status']);
  });

  it('reports the Assistant as off when the AI Kit block is missing', async () => {
    const ui = fakeServer(await writeConfig([{ platform: 'PhilipsAmbilightTV', devices: [{ name: 'TV', username: 'u', password: 'p' }] }]));
    registerAssistant(ui.server);
    expect(await ui.call('/ai/status')).toEqual({ enabled: false, provider: null, model: null, capabilities: null });
    await expect(ui.call('/ai/explain', { error: 'x' })).rejects.toThrow('The Assistant is not set up');
  });

  it('reads the shared HomebridgeAiKit block and never returns its key', async () => {
    const ui = fakeServer(await writeConfig([
      { platform: 'PhilipsAmbilightTV', devices: [] },
      { platform: 'HomebridgeAiKit', provider: 'anthropic', apiKey: 'sk-ant-secret-key' },
    ]));
    registerAssistant(ui.server);
    const status = await ui.call('/ai/status');
    expect(status).toMatchObject({ enabled: true, provider: 'anthropic' });
    expect(JSON.stringify(status)).not.toContain('sk-ant-secret-key');
  });

  it('explains a TV error with the Philips TV context and streams it', async () => {
    const { provider, requests } = fakeProvider('Check the Wi-Fi.');
    const ui = fakeServer();
    registerAssistant(ui.server, {
      loadConfig: async () => ({ enabled: true, provider: 'anthropic', model: 'fake-model' }),
      createProvider: () => provider,
    });

    const result = await ui.call('/ai/explain', {
      error: 'Cannot reach TV at [TV IP address]. Please check: 1) TV is powered on',
      context: 'Configured TVs: 1.',
      device: { name: 'Living Room TV', paired: true, certificatePinned: false, macConfigured: true },
      requestId: 'r1',
    });

    expect(result).toEqual({ text: 'Check the Wi-Fi.', usage });
    expect(ui.events).toEqual([
      ['ai:chunk', { requestId: 'r1', delta: 'Check th' }],
      ['ai:chunk', { requestId: 'r1', delta: 'e Wi-Fi.' }],
      ['ai:done', { requestId: 'r1' }],
    ]);
    expect(requests[0].system).toContain(ASSISTANT_PLUGIN_NAME);
    expect(requests[0].system).toContain(PHILIPS_TV_AI_CONTEXT);
    expect(JSON.stringify(requests[0].messages)).toContain('Living Room TV');
  });

  it('describes the JointSpace API, pairing, certificate pinning and Wake-on-LAN in its context', () => {
    expect(ASSISTANT_PLUGIN_NAME).toBe('@mp-consulting/homebridge-philips-ambilight-tv');
    for (const fact of ['JointSpace', '1926', '_androidtvremote2._tcp', 'PIN', '401', '403', '404', 'certFingerprint', 'Wake-on-LAN']) {
      expect(PHILIPS_TV_AI_CONTEXT).toContain(fact);
    }
  });
});
