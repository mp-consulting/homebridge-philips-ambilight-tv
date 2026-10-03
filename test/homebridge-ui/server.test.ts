import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type * as UtilsModule from '../../src/api/utils.js';
import type * as ClientModule from '../../src/api/PhilipsTVClient.js';

// ============================================================================
// MOCKS
//
// server.js instantiates its UiServer on import. The plugin-ui-utils base
// class is replaced with one that records each registered request handler, so
// the handlers can be called directly. Network-facing helpers are stubbed;
// everything else (digest auth, HMAC, MAC parsing) is the real implementation.
// ============================================================================

type Handler = (data?: unknown) => Promise<Record<string, unknown>>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  server: null as unknown as {
    pairingSessions: Map<string, unknown>;
  },
  fetch: vi.fn(),
  agents: [] as Array<{ options: { certFingerprint?: string; onCertObserved?: (fp: string) => void }; close: ReturnType<typeof vi.fn> }>,
  getMAC: vi.fn(),
  wol: vi.fn(),
  client: {
    getSources: vi.fn(),
    getBuiltInSources: vi.fn(),
    getApplications: vi.fn(),
    getCurrentActivityIntent: vi.fn(),
    close: vi.fn(),
  },
  clientConfigs: [] as unknown[],
}));

vi.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {
    constructor() {
      mocks.server = this as unknown as typeof mocks.server;
    }
    onRequest(path: string, handler: Handler) {
      mocks.handlers.set(path, handler);
    }
    ready() {}
  },
}));

vi.mock('bonjour-service', () => ({ Bonjour: class {} }));

vi.mock('node-arp', () => ({ default: { getMAC: mocks.getMAC } }));

vi.mock('../../src/api/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof UtilsModule>()),
  fetchWithTimeout: mocks.fetch,
  sendWakeOnLan: mocks.wol,
  createTvAgent: (options: { certFingerprint?: string; onCertObserved?: (fp: string) => void } = {}) => {
    const agent = { options, close: vi.fn().mockResolvedValue(undefined) };
    mocks.agents.push(agent);
    return agent;
  },
}));

vi.mock('../../src/api/PhilipsTVClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  PhilipsTVClient: class {
    constructor(config: unknown) {
      mocks.clientConfigs.push(config);
    }
    getSources = mocks.client.getSources;
    getBuiltInSources = mocks.client.getBuiltInSources;
    getApplications = mocks.client.getApplications;
    getCurrentActivityIntent = mocks.client.getCurrentActivityIntent;
    close = mocks.client.close;
  },
}));

// ============================================================================
// HELPERS
// ============================================================================

const call = (path: string, data?: unknown) => mocks.handlers.get(path)!(data);

const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

const DIGEST_CHALLENGE = 'Digest realm="XTV", nonce="abc123", qop="auth"';

/** Answer /pair/request, reporting `fingerprint` on the connection like the real agent would. */
const answerPairRequest = (fingerprint: string | null) => {
  mocks.fetch.mockImplementationOnce((_url: string, options: { dispatcher: typeof mocks.agents[number] }) => {
    if (fingerprint) {
      options.dispatcher.options.onCertObserved?.(fingerprint);
    }
    return Promise.resolve(response(200, { auth_key: 'secret-key', timestamp: 12345 }));
  });
};

let PAIRING_SESSION_TTL_MS: number;
let MAX_PAIRING_SESSIONS: number;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const mod = await import('../../homebridge-ui/server.js');
  PAIRING_SESSION_TTL_MS = mod.PAIRING_SESSION_TTL_MS;
  MAX_PAIRING_SESSIONS = mod.MAX_PAIRING_SESSIONS;
});

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.getMAC.mockReset();
  mocks.wol.mockReset();
  mocks.agents.length = 0;
  mocks.clientConfigs.length = 0;
  Object.values(mocks.client).forEach(fn => fn.mockReset());
  mocks.client.close.mockResolvedValue(undefined);
  mocks.server.pairingSessions.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// TESTS
// ============================================================================

describe('homebridge-ui server', () => {
  describe('input validation', () => {
    it.each(['/pair', '/pair-grant', '/get-sources', '/current-app'])('%s rejects an address that is not IPv4', async (path) => {
      for (const ip of ['host/x?#', '-c1', '999.1.1.1', '', undefined]) {
        const result = await call(path, { ip, pin: '1234' });
        expect(result.success).toBe(false);
      }
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.clientConfigs).toHaveLength(0);
    });

    it('never hands an option-like value to ping/arp', async () => {
      const result = await call('/get-mac', '-c1');
      expect(result.success).toBe(false);
      expect(mocks.getMAC).not.toHaveBeenCalled();
    });

    it('rejects a malformed PIN', async () => {
      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '12a4' });
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('PIN') });
    });

    it('rejects Wake-on-LAN for an invalid MAC', async () => {
      const result = await call('/wake-on-lan', { mac: 'not-a-mac' });
      expect(result.success).toBe(false);
      expect(mocks.wol).not.toHaveBeenCalled();
    });
  });

  describe('/get-mac', () => {
    it('returns the canonical MAC spelling', async () => {
      mocks.getMAC.mockImplementation((_ip: string, cb: (err: Error | null, mac?: string) => void) => cb(null, 'AA-BB-CC-DD-EE-FF'));
      expect(await call('/get-mac', '192.168.1.5')).toEqual({ success: true, mac: 'aa:bb:cc:dd:ee:ff' });
    });

    it('gives up when the ARP lookup never answers', async () => {
      vi.useFakeTimers();
      mocks.getMAC.mockImplementation(() => {});
      const pending = call('/get-mac', '192.168.1.5');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ success: false });
    });
  });

  describe('pairing', () => {
    it('completes pair → grant with a digest retry and pins the observed certificate', async () => {
      answerPairRequest('fp-from-pairing');
      expect(await call('/pair', { ip: '192.168.1.5', deviceName: 'HB' })).toMatchObject({ success: true });

      mocks.fetch
        .mockResolvedValueOnce(response(401, '', { 'www-authenticate': DIGEST_CHALLENGE }))
        .mockResolvedValueOnce(response(200, {}));

      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' });

      expect(result).toMatchObject({ success: true, password: 'secret-key', certFingerprint: 'fp-from-pairing' });
      expect(result.certWarning).toBeUndefined();

      // The grant ran over an agent pinned to the fingerprint seen at /pair/request.
      const grantAgent = mocks.fetch.mock.calls[1][1].dispatcher;
      expect(grantAgent.options.certFingerprint).toBe('fp-from-pairing');

      const retryHeaders = mocks.fetch.mock.calls[2][1].headers as Record<string, string>;
      expect(retryHeaders.Authorization).toMatch(/^Digest username="[0-9a-f]+", realm="XTV", nonce="abc123"/);

      // The session is spent and its connections released.
      expect(mocks.server.pairingSessions.size).toBe(0);
      expect(grantAgent.close).toHaveBeenCalled();
      expect((await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' })).success).toBe(false);
    });

    it('does not send the auth key back to the browser before the PIN is confirmed', async () => {
      answerPairRequest('fp');
      const result = await call('/pair', { ip: '192.168.1.5' });
      expect(JSON.stringify(result)).not.toContain('secret-key');
    });

    it('flags a pairing whose certificate could not be recorded', async () => {
      answerPairRequest(null);
      await call('/pair', { ip: '192.168.1.5' });
      mocks.fetch.mockResolvedValueOnce(response(200, {}));

      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' });
      expect(result).toMatchObject({ success: true, certWarning: true });
    });

    it('stops pairing when the TV presents a different certificate at grant', async () => {
      answerPairRequest('fp-original');
      await call('/pair', { ip: '192.168.1.5' });
      mocks.fetch.mockRejectedValueOnce(new TypeError('fetch failed', {
        cause: new Error('TV certificate does not match the pinned fingerprint (expected a, got b)'),
      }));

      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' });
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('different certificate') });
      expect(mocks.server.pairingSessions.size).toBe(0);
    });

    it('reports a TV-side error_id as a failure', async () => {
      answerPairRequest('fp');
      await call('/pair', { ip: '192.168.1.5' });
      mocks.fetch.mockResolvedValueOnce(response(200, { error_id: 'INVALID_PIN', error_text: 'bad\npin' }));

      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' });
      expect(result).toMatchObject({ success: false, error: 'Pairing failed: INVALID_PIN - bad pin' });
    });

    it('expires an abandoned pairing session', async () => {
      vi.useFakeTimers();
      answerPairRequest('fp');
      await call('/pair', { ip: '192.168.1.5' });

      vi.setSystemTime(Date.now() + PAIRING_SESSION_TTL_MS + 1);
      const result = await call('/pair-grant', { ip: '192.168.1.5', pin: '1234' });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('No active pairing session') });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('caps the number of concurrent pairing sessions', async () => {
      for (let i = 1; i <= MAX_PAIRING_SESSIONS + 4; i++) {
        answerPairRequest('fp');
        await call('/pair', { ip: `192.168.1.${i}` });
      }
      expect(mocks.server.pairingSessions.size).toBe(MAX_PAIRING_SESSIONS);
      // Oldest sessions are the ones evicted.
      expect(mocks.server.pairingSessions.has('192.168.1.1')).toBe(false);
      expect(mocks.server.pairingSessions.has(`192.168.1.${MAX_PAIRING_SESSIONS + 4}`)).toBe(true);
    });

    it('explains an unreachable TV', async () => {
      mocks.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const result = await call('/pair', { ip: '192.168.1.5' });
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('Cannot reach TV') });
      expect(mocks.agents[0].close).toHaveBeenCalled();
    });
  });

  describe('/get-sources', () => {
    it('de-duplicates apps reported more than once and passes the pinned certificate', async () => {
      mocks.client.getSources.mockResolvedValue([{ id: 'content://android.media.tv/channel', name: 'Watch TV' }]);
      mocks.client.getApplications.mockResolvedValue([
        { label: 'YouTube', intent: { component: { packageName: 'com.google.android.youtube.tv' } } },
        { label: 'YouTube Kids', intent: { component: { packageName: 'com.google.android.youtube.tv' } } },
      ]);

      const result = await call('/get-sources', { ip: '192.168.1.5', certFingerprint: 'fp' });

      expect(result.success).toBe(true);
      expect((result.sources as Array<{ id: string }>).map(s => s.id)).toEqual([
        'content://android.media.tv/channel',
        'com.google.android.youtube.tv',
      ]);
      expect(mocks.clientConfigs[0]).toMatchObject({ certFingerprint: 'fp' });
      expect(mocks.client.close).toHaveBeenCalled();
    });

    it('falls back to built-in sources and default apps when the TV does not answer', async () => {
      mocks.client.getSources.mockRejectedValue(new Error('timeout'));
      mocks.client.getBuiltInSources.mockReturnValue([{ id: 'virtual:home', name: 'Home' }]);
      mocks.client.getApplications.mockResolvedValue([]);

      const result = await call('/get-sources', { ip: '192.168.1.5' });

      const sources = result.sources as Array<{ id: string; icon: string }>;
      expect(sources[0]).toMatchObject({ id: 'virtual:home', icon: 'home' });
      expect(sources.some(s => s.id === 'com.netflix.ninja')).toBe(true);
    });
  });

  describe('/current-app', () => {
    it.each(['org.droidtv.playtv', 'com.google.android.apps.tv.launcherx', 'org.droidtv.channels'])(
      'refuses the system activity %s',
      async (packageName) => {
        mocks.client.getCurrentActivityIntent.mockResolvedValue({ packageName, className: null, action: null });
        expect(await call('/current-app', { ip: '192.168.1.5' })).toMatchObject({ success: false, notAnApp: true });
      },
    );

    it('returns a user app', async () => {
      const app = { packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity', action: null };
      mocks.client.getCurrentActivityIntent.mockResolvedValue(app);
      expect(await call('/current-app', { ip: '192.168.1.5' })).toEqual({ success: true, app });
    });

    it('asks the user to open an app when nothing is in the foreground', async () => {
      mocks.client.getCurrentActivityIntent.mockResolvedValue(null);
      expect(await call('/current-app', { ip: '192.168.1.5' })).toMatchObject({ success: false });
    });
  });
});
