import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhilipsTVClient } from '../../src/api/PhilipsTVClient.js';
import type * as UtilsModule from '../../src/api/utils.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../src/api/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
    sendWakeOnLan: vi.fn().mockResolvedValue(undefined),
  };
});

import { fetchWithTimeout, sendWakeOnLan } from '../../src/api/utils.js';

const mockFetch = vi.mocked(fetchWithTimeout);
const mockWol = vi.mocked(sendWakeOnLan);

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): ReturnType<typeof fetchWithTimeout> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body ? JSON.stringify(body) : ''),
    json: () => Promise.resolve(body),
  } as Awaited<ReturnType<typeof fetchWithTimeout>>);
}

const TEST_CONFIG = {
  ip: '192.168.1.100',
  mac: 'AA:BB:CC:DD:EE:FF',
  username: 'testuser',
  password: 'testpass',
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('PhilipsTVClient', () => {
  let client: PhilipsTVClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new PhilipsTVClient(TEST_CONFIG);
    mockFetch.mockReset();
    mockWol.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // POWER
  // ==========================================================================

  describe('getPowerState', () => {
    it('should return true when TV is On', async () => {
      mockFetch.mockReturnValue(mockResponse({ powerstate: 'On' }));

      const promise = client.getPowerState();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
    });

    it('should return false when TV is in Standby', async () => {
      mockFetch.mockReturnValue(mockResponse({ powerstate: 'Standby' }));

      const promise = client.getPowerState();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(false);
    });

    it('should return false when request fails', async () => {
      mockFetch.mockReturnValue(mockResponse(null, 500));

      const promise = client.getPowerState();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(false);
    });
  });

  describe('setPowerState', () => {
    it('should send WOL packet when turning on', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setPowerState(true);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockWol).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
    });

    it('should not send WOL packet when turning off', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setPowerState(false);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockWol).not.toHaveBeenCalled();
    });

    it('should POST correct powerstate body', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setPowerState(false);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/powerstate'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ powerstate: 'Standby' }),
        }),
        expect.any(Number),
      );
    });
  });

  // ==========================================================================
  // VOLUME
  // ==========================================================================

  describe('getVolume', () => {
    it('should return volume state', async () => {
      const volumeState = { current: 25, min: 0, max: 60, muted: false };
      mockFetch.mockReturnValue(mockResponse(volumeState));

      const promise = client.getVolume();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual(volumeState);
    });

    it('should return null on failure', async () => {
      mockFetch.mockReturnValue(mockResponse(null, 500));

      const promise = client.getVolume();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
    });
  });

  describe('setMuted', () => {
    it('should POST mute state', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setMuted(true);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/audio/volume'),
        expect.objectContaining({
          body: JSON.stringify({ muted: true }),
        }),
        expect.any(Number),
      );
    });
  });

  // ==========================================================================
  // REMOTE
  // ==========================================================================

  describe('sendKey', () => {
    it('should POST key command', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.sendKey('VolumeUp');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/input/key'),
        expect.objectContaining({
          body: JSON.stringify({ key: 'VolumeUp' }),
        }),
        expect.any(Number),
      );
    });
  });

  // ==========================================================================
  // AMBILIGHT
  // ==========================================================================

  describe('getAmbilightPower', () => {
    it('should return true when Ambilight is On', async () => {
      mockFetch.mockReturnValue(mockResponse({ power: 'On' }));

      const promise = client.getAmbilightPower();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
    });

    it('should return false when Ambilight is Off', async () => {
      mockFetch.mockReturnValue(mockResponse({ power: 'Off' }));

      const promise = client.getAmbilightPower();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(false);
    });
  });

  describe('setAmbilightFollowColor', () => {
    it('should POST correct configuration', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const color = { hue: 128, saturation: 200, brightness: 255 };
      const promise = client.setAmbilightFollowColor(color);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ambilight/currentconfiguration'),
        expect.objectContaining({
          body: JSON.stringify({
            styleName: 'FOLLOW_COLOR',
            isExpert: true,
            algorithm: 'MANUAL_HUE',
            speed: 0,
            colorSettings: {
              color: { hue: 128, saturation: 200, brightness: 255 },
              colorDelta: { hue: 0, saturation: 0, brightness: 0 },
              speed: 0,
            },
          }),
        }),
        expect.any(Number),
      );
    });

    it('should use AUTOMATIC_HUE when speed > 0', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const color = { hue: 0, saturation: 255, brightness: 255 };
      const promise = client.setAmbilightFollowColor(color, 128);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('AUTOMATIC_HUE'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('setAmbilightOff', () => {
    it('should try styleName OFF first', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setAmbilightOff();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ambilight/currentconfiguration'),
        expect.objectContaining({
          body: JSON.stringify({ styleName: 'OFF', isExpert: false }),
        }),
        expect.any(Number),
      );
    });

    it('should fall back to ambilight/power if style OFF fails', async () => {
      // First call (styleName OFF) fails, second call (power Off) succeeds
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 500))
        .mockReturnValueOnce(mockResponse({}));

      const promise = client.setAmbilightOff();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining('/ambilight/power'),
        expect.objectContaining({
          body: JSON.stringify({ power: 'Off' }),
        }),
        expect.any(Number),
      );
    });
  });

  describe('setAmbilightBrightness', () => {
    it('should clamp brightness to valid range', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.setAmbilightBrightness(15);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/menuitems/settings/update'),
        expect.objectContaining({
          body: expect.stringContaining('"value":10'),
        }),
        expect.any(Number),
      );
    });
  });

  // ==========================================================================
  // DIGEST AUTH
  // ==========================================================================

  describe('digest authentication', () => {
    it('should retry with digest auth on 401 response', async () => {
      // First call returns 401 with Digest challenge
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="abc123", qop="auth"',
        }))
        // Second call (with auth) returns success
        .mockReturnValueOnce(mockResponse({ powerstate: 'On' }));

      const promise = client.getPowerState();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should include Authorization header
      const secondCallOptions = mockFetch.mock.calls[1][1];
      expect(secondCallOptions.headers).toHaveProperty('Authorization');
      expect((secondCallOptions.headers as Record<string, string>).Authorization).toContain('Digest ');
    });

    it('should cache digest auth and skip 401 round-trip on subsequent requests', async () => {
      // First request: 401 → retry with auth → success (2 fetches)
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="abc123", qop="auth"',
        }))
        .mockReturnValueOnce(mockResponse({ powerstate: 'On' }));

      const p1 = client.getPowerState();
      await vi.runAllTimersAsync();
      await p1;
      expect(mockFetch).toHaveBeenCalledTimes(2);

      mockFetch.mockReset();

      // Second request: should send auth proactively (1 fetch only)
      mockFetch.mockReturnValueOnce(mockResponse({ current: 25, min: 0, max: 60, muted: false }));

      const p2 = client.getVolume();
      await vi.runAllTimersAsync();
      const volume = await p2;

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(volume).toEqual({ current: 25, min: 0, max: 60, muted: false });

      // The single call should include Authorization
      const callOptions = mockFetch.mock.calls[0][1];
      expect((callOptions.headers as Record<string, string>).Authorization).toContain('Digest ');
    });

    it('should increment nc on each cached auth request', async () => {
      // Prime the cache
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="abc123", qop="auth"',
        }))
        .mockReturnValueOnce(mockResponse({ powerstate: 'On' }));

      const p1 = client.getPowerState();
      await vi.runAllTimersAsync();
      await p1;

      mockFetch.mockReset();

      // Make two more requests using cached auth
      mockFetch
        .mockReturnValueOnce(mockResponse({ current: 25, min: 0, max: 60, muted: false }))
        .mockReturnValueOnce(mockResponse({ power: 'On' }));

      const p2 = client.getVolume();
      const p3 = client.getAmbilightPower();
      await vi.runAllTimersAsync();
      await Promise.all([p2, p3]);

      // nc should be 00000002 for the first cached request, 00000003 for the second
      const auth1 = (mockFetch.mock.calls[0][1].headers as Record<string, string>).Authorization;
      const auth2 = (mockFetch.mock.calls[1][1].headers as Record<string, string>).Authorization;
      expect(auth1).toContain('nc=00000002');
      expect(auth2).toContain('nc=00000003');
    });

    it('should refresh cache when nonce expires (401 on cached auth)', async () => {
      // Prime the cache
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="abc123", qop="auth"',
        }))
        .mockReturnValueOnce(mockResponse({ powerstate: 'On' }));

      const p1 = client.getPowerState();
      await vi.runAllTimersAsync();
      await p1;

      mockFetch.mockReset();

      // Cached auth gets 401 (nonce expired), then fresh auth succeeds with new nonce
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="new-nonce-456", qop="auth"',
        }))
        .mockReturnValueOnce(mockResponse({ current: 25, min: 0, max: 60, muted: false }));

      const p2 = client.getVolume();
      await vi.runAllTimersAsync();
      const volume = await p2;

      // Should have made 2 calls: cached auth (401) + fresh auth retry
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(volume).toEqual({ current: 25, min: 0, max: 60, muted: false });

      // The retry should use the new nonce
      const retryAuth = (mockFetch.mock.calls[1][1].headers as Record<string, string>).Authorization;
      expect(retryAuth).toContain('nonce="new-nonce-456"');
    });
  });

  // ==========================================================================
  // REQUEST SERIALIZATION
  // ==========================================================================

  describe('request serialization', () => {
    it('should serialize concurrent requests', async () => {
      const callOrder: number[] = [];

      mockFetch.mockImplementation(async (url) => {
        const endpoint = new URL(url as string).pathname;
        if (endpoint.includes('powerstate')) {
          callOrder.push(1);
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: () => Promise.resolve(JSON.stringify({ powerstate: 'On' })),
          } as Awaited<ReturnType<typeof fetchWithTimeout>>;
        }
        callOrder.push(2);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ current: 25, min: 0, max: 60, muted: false })),
        } as Awaited<ReturnType<typeof fetchWithTimeout>>;
      });

      // Fire both concurrently
      const p1 = client.getPowerState();
      const p2 = client.getVolume();

      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);

      // Both should complete, and first should be called before second
      expect(callOrder).toEqual([1, 2]);
    });
  });

  // ==========================================================================
  // SYSTEM
  // ==========================================================================

  describe('getSystemInfo', () => {
    it('should return system info', async () => {
      const sysInfo = { model: 'PUS8505', softwareversion: '1.2.3' };
      mockFetch.mockReturnValue(mockResponse(sysInfo));

      const promise = client.getSystemInfo();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual(sysInfo);
    });
  });

  describe('isReachable', () => {
    it('should return true when system info is available', async () => {
      mockFetch.mockReturnValue(mockResponse({ model: 'TV' }));

      const promise = client.isReachable();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
    });

    it('should return false when system info fails', async () => {
      mockFetch.mockReturnValue(mockResponse(null, 500));

      const promise = client.isReachable();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // APPLICATIONS
  // ==========================================================================

  describe('getApplications', () => {
    it('should return applications list', async () => {
      const apps = { applications: [{ id: '1', label: 'YouTube' }] };
      mockFetch.mockReturnValue(mockResponse(apps));

      const promise = client.getApplications();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([{ id: '1', label: 'YouTube' }]);
    });

    it('should return empty array on failure', async () => {
      mockFetch.mockReturnValue(mockResponse(null, 500));

      const promise = client.getApplications();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([]);
    });
  });

  describe('launchApplication', () => {
    it('should POST intent with correct action', async () => {
      mockFetch.mockReturnValue(mockResponse({}));

      const promise = client.launchApplication('com.netflix.ninja');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/activities/launch'),
        expect.objectContaining({
          body: expect.stringContaining('android.intent.action.MAIN'),
        }),
        expect.any(Number),
      );
    });

    it('should use cached intent from getApplications', async () => {
      // First call: getApplications caches the intent
      mockFetch.mockReturnValue(mockResponse({
        applications: [{
          id: 'test',
          label: 'Netflix',
          intent: {
            component: { packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity' },
            action: 'android.intent.action.MAIN',
          },
        }],
      }));

      const appsPromise = client.getApplications();
      await vi.runAllTimersAsync();
      await appsPromise;

      // Second call: launchApplication uses cached className
      mockFetch.mockReturnValue(mockResponse({}));

      const launchPromise = client.launchApplication('com.netflix.ninja');
      await vi.runAllTimersAsync();
      await launchPromise;

      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining('/activities/launch'),
        expect.objectContaining({
          body: expect.stringContaining('com.netflix.ninja.MainActivity'),
        }),
        expect.any(Number),
      );
    });
  });
});
