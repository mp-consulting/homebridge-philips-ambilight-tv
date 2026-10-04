import { describe, it, expect, vi, beforeAll } from 'vitest';

// ============================================================================
// LOAD
//
// helpers.js is a classic browser script that publishes its functions on
// globalThis; importing it for its side effect is enough to read them back.
// ============================================================================

interface Source {
  id: string;
  name?: string;
  order?: number;
  visible?: boolean;
  customName?: string;
  custom?: boolean;
}

interface Helpers {
  escapeHtml: (value: unknown) => string;
  isValidIpv4: (ip: unknown) => boolean;
  normalizeMac: (mac: unknown) => string | null;
  injectCustomApps: (sources: Source[], customApps: unknown) => Source[];
  mergeSourcesWithConfig: (fetched: Source[], config: unknown) => Source[];
  reorderVisible: (sources: Source[], visibleIds: string[]) => Source[];
  moveVisibleSource: (sources: Source[], id: string, delta: number) => Source[] | null;
  toSourceConfig: (sources: Source[]) => Source[];
  debounce: (fn: () => void, ms: number) => (() => void) & { flush: () => void };
  withTimeout: <T>(promise: Promise<T>, ms: number, message: string) => Promise<T>;
  scrubAddresses: (text: unknown) => string;
  assistantTv: (tv: unknown) => Record<string, unknown>;
  tvProblem: (tv: unknown) => string | null;
}

let h: Helpers;

beforeAll(async () => {
  await import('../../homebridge-ui/public/helpers.js');
  h = (globalThis as unknown as { AmbilightHelpers: Helpers }).AmbilightHelpers;
});

// ============================================================================
// TESTS
// ============================================================================

describe('homebridge-ui helpers', () => {
  describe('escapeHtml', () => {
    it('neutralises markup in TV-supplied names', () => {
      const escaped = h.escapeHtml('<img src=x onerror=alert(1)>');
      expect(escaped).toBe('&lt;img src=x onerror=alert(1)&gt;');
      expect(escaped).not.toContain('<');
    });

    it('escapes quotes so values are safe inside attributes', () => {
      expect(h.escapeHtml('a"b\'c`d&e')).toBe('a&quot;b&#39;c&#96;d&amp;e');
    });

    it('renders null and undefined as empty text', () => {
      expect(h.escapeHtml(null)).toBe('');
      expect(h.escapeHtml(undefined)).toBe('');
    });
  });

  describe('isValidIpv4', () => {
    it.each(['192.168.1.10', '10.0.0.1', '255.255.255.255'])('accepts %s', (ip) => {
      expect(h.isValidIpv4(ip)).toBe(true);
    });

    it.each(['256.1.1.1', '1.2.3', 'host/x?#', '-c1', '', null])('rejects %s', (ip) => {
      expect(h.isValidIpv4(ip)).toBe(false);
    });
  });

  describe('normalizeMac', () => {
    it('canonicalises every accepted spelling to lowercase colons', () => {
      expect(h.normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
      expect(h.normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
      expect(h.normalizeMac(' aabbccddeeff ')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns null for anything that is not a MAC', () => {
      expect(h.normalizeMac('aa:bb:cc')).toBeNull();
      expect(h.normalizeMac('zz:bb:cc:dd:ee:ff')).toBeNull();
      expect(h.normalizeMac(undefined)).toBeNull();
    });
  });

  describe('injectCustomApps', () => {
    it('appends custom apps not already listed', () => {
      const result = h.injectCustomApps(
        [{ id: 'com.netflix.ninja', name: 'Netflix' }],
        [{ packageName: 'com.netflix.ninja', name: 'Dup' }, { packageName: 'com.example', name: 'Example' }],
      );
      expect(result.map(s => s.id)).toEqual(['com.netflix.ninja', 'com.example']);
      expect(result[1].custom).toBe(true);
    });
  });

  describe('mergeSourcesWithConfig', () => {
    it('places unsaved sources after the highest saved order instead of colliding', () => {
      const merged = h.mergeSourcesWithConfig(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [{ id: 'c', order: 0, visible: true }, { id: 'b', order: 1, visible: false }],
      );
      expect(merged.map(s => s.id)).toEqual(['c', 'b', 'a']);
      expect(merged.map(s => s.order)).toEqual([0, 1, 2]);
      expect(merged.find(s => s.id === 'b')?.visible).toBe(false);
    });

    it('tolerates a missing config', () => {
      expect(h.mergeSourcesWithConfig([{ id: 'a' }], undefined).map(s => s.order)).toEqual([0]);
    });
  });

  describe('moveVisibleSource', () => {
    const sources: Source[] = [
      { id: 'a', visible: true },
      { id: 'h', visible: false },
      { id: 'b', visible: true },
      { id: 'c', visible: true },
    ];

    it('moves a visible source among the visible ones and renumbers', () => {
      const moved = h.moveVisibleSource(sources, 'c', -1)!;
      const visible = moved.filter(s => s.visible !== false).map(s => s.id);
      expect(visible).toEqual(['a', 'c', 'b']);
      expect(moved.map(s => s.order)).toEqual([0, 1, 2, 3]);
    });

    it('refuses moves past either end', () => {
      expect(h.moveVisibleSource(sources, 'a', -1)).toBeNull();
      expect(h.moveVisibleSource(sources, 'c', 1)).toBeNull();
      expect(h.moveVisibleSource(sources, 'missing', 1)).toBeNull();
    });
  });

  describe('toSourceConfig', () => {
    it('keeps only the persisted fields', () => {
      expect(h.toSourceConfig([{ id: 'a', name: 'A', order: 0, visible: true, custom: true }]))
        .toEqual([{ id: 'a', order: 0, visible: true, customName: undefined }]);
    });
  });

  describe('debounce', () => {
    it('coalesces calls and flushes a pending one immediately', () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn();
        const debounced = h.debounce(fn, 100);
        debounced();
        debounced();
        expect(fn).not.toHaveBeenCalled();
        debounced.flush();
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(200);
        expect(fn).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('withTimeout', () => {
    it('rejects with the given message when the promise is too slow', async () => {
      vi.useFakeTimers();
      try {
        const pending = h.withTimeout(new Promise(() => {}), 50, 'too slow');
        const assertion = expect(pending).rejects.toThrow('too slow');
        await vi.advanceTimersByTimeAsync(60);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
  describe('Assistant helpers', () => {
    const tv = {
      name: 'Living Room TV',
      ip: '192.168.1.42',
      mac: 'AA:BB:CC:DD:EE:FF',
      username: 'a1b2c3d4e5f60718',
      password: 'secret-auth-key',
      certFingerprint: 'ab:cd:ef',
      pollingInterval: 10000,
      sources: [{ id: 'hdmi1' }],
      customApps: [],
    };

    it('scrubs IP and MAC addresses from error text', () => {
      const scrubbed = h.scrubAddresses('Cannot reach TV at 192.168.1.42 (MAC aa-bb-cc-dd-ee-ff, AA:BB:CC:DD:EE:FF)');
      expect(scrubbed).toBe('Cannot reach TV at [TV IP address] (MAC [MAC address], [MAC address])');
      expect(h.scrubAddresses(undefined)).toBe('');
    });

    it('shares only whitelisted TV facts, never addresses or credentials', () => {
      const shared = h.assistantTv(tv);
      expect(shared).toEqual({
        name: 'Living Room TV',
        paired: true,
        certificatePinned: true,
        macConfigured: true,
        wakeOnLanEnabled: true,
        pollingInterval: 10000,
        ambilightMode: undefined,
        configuredSources: 1,
        customApps: 0,
      });
      const json = JSON.stringify(shared);
      for (const secret of ['192.168.1.42', 'AA:BB', 'a1b2c3d4e5f60718', 'secret-auth-key', 'ab:cd:ef']) {
        expect(json).not.toContain(secret);
      }
    });

    it('reports why a configured TV needs attention', () => {
      expect(h.tvProblem(tv)).toBeNull();
      expect(h.tvProblem({ ...tv, password: '' })).toContain('no pairing credentials');
      expect(h.tvProblem({ ...tv, mac: '' })).toContain('Wake-on-LAN');
      expect(h.tvProblem({ ...tv, certFingerprint: undefined })).toContain('not verified');
    });
  });
});
