import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotifyChangeClient } from '../../src/services/NotifyChangeClient.js';
import type * as UtilsModule from '../../src/api/utils.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../src/api/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
  };
});

vi.mock('../../src/api/DigestAuthSession.js', () => ({
  DigestAuthSession: class MockDigestAuthSession {
    buildHeader() {
      return null;
    }

    cacheFromChallenge() {
      return true;
    }

    clear() {
      // no-op
    }
  },
}));

import { fetchWithTimeout } from '../../src/api/utils.js';

const mockFetch = vi.mocked(fetchWithTimeout);

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
  username: 'testuser',
  password: 'testpass',
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('NotifyChangeClient', () => {
  let client: NotifyChangeClient;
  const debugLog = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    client = new NotifyChangeClient(TEST_CONFIG, debugLog);
    mockFetch.mockReset();
    debugLog.mockReset();
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  describe('start/stop', () => {
    it('should start polling and emit notifications', async () => {
      const notification = vi.fn();
      client.on('notification', notification);

      const changeData = { powerstate: { powerstate: 'On' } };
      mockFetch.mockReturnValue(mockResponse(changeData));

      client.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(notification).toHaveBeenCalledWith(changeData);
    });

    it('should not start twice', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
      client.start();
      client.start(); // second call should be no-op
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should stop polling', async () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
      client.start();
      client.stop();

      // After stop, no more poll attempts
      mockFetch.mockReset();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PROTOCOL DETECTION
  // ==========================================================================

  describe('protocol detection', () => {
    it('should try HTTPS first, then HTTP', async () => {
      // HTTPS fails, HTTP succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('HTTPS fail'))
        .mockReturnValueOnce(mockResponse({ test: true }));

      client.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstUrl = mockFetch.mock.calls[0][0] as string;
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      expect(firstUrl).toContain('https://');
      expect(secondUrl).toContain('http://');
    });

    it('should remember working protocol', async () => {
      // First round: HTTPS works
      mockFetch.mockReturnValueOnce(mockResponse({ test: true }));

      client.start();
      await vi.advanceTimersByTimeAsync(100);

      // Second round: should only try HTTPS (known working)
      mockFetch.mockReturnValueOnce(mockResponse({ test: true }));
      await vi.advanceTimersByTimeAsync(3000);

      // All calls should be HTTPS
      for (const call of mockFetch.mock.calls) {
        expect(call[0]).toContain('https://');
      }
    });
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  describe('error handling', () => {
    it('should emit failed after MAX_CONSECUTIVE_FAILURES', async () => {
      const failed = vi.fn();
      client.on('failed', failed);

      // All attempts fail (both HTTPS and HTTP per cycle)
      mockFetch.mockRejectedValue(new Error('network error'));

      client.start();

      // Need to advance through backoff delays + poll attempts
      // 5 failures with exponential backoff: 1s, 2s, 4s, 8s, 16s
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(35_000);
      }

      expect(failed).toHaveBeenCalled();
    });

    it('should reset failure count on success', async () => {
      const failed = vi.fn();
      client.on('failed', failed);

      // Fail a few times (both protocols fail), then succeed
      mockFetch
        .mockRejectedValueOnce(new Error('fail')) // HTTPS attempt 1
        .mockRejectedValueOnce(new Error('fail')) // HTTP attempt 1
        .mockRejectedValueOnce(new Error('fail')) // HTTPS attempt 2
        .mockRejectedValueOnce(new Error('fail')) // HTTP attempt 2
        .mockReturnValue(mockResponse({ test: true })); // success

      client.start();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(failed).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON gracefully', async () => {
      mockFetch.mockReturnValue(Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('not valid json{{{'),
      } as Awaited<ReturnType<typeof fetchWithTimeout>>));

      const notification = vi.fn();
      client.on('notification', notification);

      client.start();
      await vi.advanceTimersByTimeAsync(100);

      // Should not emit notification for malformed JSON
      expect(notification).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DIGEST AUTH
  // ==========================================================================

  describe('digest authentication', () => {
    it('should handle 401 challenge and retry', async () => {
      // First: 401 with challenge, Second: success with auth
      mockFetch
        .mockReturnValueOnce(mockResponse(null, 401, {
          'www-authenticate': 'Digest realm="tv", nonce="abc123", qop="auth"',
        }))
        .mockReturnValueOnce(mockResponse({ test: true }));

      const notification = vi.fn();
      client.on('notification', notification);

      client.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(notification).toHaveBeenCalledWith({ test: true });
    });
  });

  // ==========================================================================
  // MINIMUM POLL INTERVAL
  // ==========================================================================

  describe('minimum poll interval', () => {
    it('should enforce minimum delay between polls', async () => {
      const timestamps: number[] = [];

      mockFetch.mockImplementation(async () => {
        timestamps.push(Date.now());
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ test: true })),
        } as Awaited<ReturnType<typeof fetchWithTimeout>>;
      });

      client.start();
      // First poll
      await vi.advanceTimersByTimeAsync(100);
      // Wait for min interval + second poll
      await vi.advanceTimersByTimeAsync(3000);

      if (timestamps.length >= 2) {
        const gap = timestamps[1] - timestamps[0];
        expect(gap).toBeGreaterThanOrEqual(2000);
      }
    });
  });
});
