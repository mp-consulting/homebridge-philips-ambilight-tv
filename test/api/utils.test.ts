import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  md5,
  hmacSignature,
  buildUrl,
  parseWwwAuthenticate,
  createDigestAuth,
  parseErrorResponse,
  extractIpv4,
  sendWakeOnLan,
  sanitizeForHomeKit,
  createDeviceInfo,
} from '../../src/api/utils.js';
import type { DiscoveredDevice } from '../../src/api/types.js';

// ============================================================================
// md5
// ============================================================================

describe('md5', () => {
  it('should hash "hello" correctly', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('should hash empty string correctly', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('should produce 32-character hex string', () => {
    const result = md5('test');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

// ============================================================================
// hmacSignature
// ============================================================================

describe('hmacSignature', () => {
  it('should return a base64-encoded string', () => {
    const result = hmacSignature('1234567890', '1234');
    expect(typeof result).toBe('string');
    // Base64 pattern
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('should produce different results for different inputs', () => {
    const sig1 = hmacSignature('1234567890', '1234');
    const sig2 = hmacSignature('1234567890', '5678');
    expect(sig1).not.toBe(sig2);
  });

  it('should be deterministic', () => {
    const sig1 = hmacSignature('12345', '9999');
    const sig2 = hmacSignature('12345', '9999');
    expect(sig1).toBe(sig2);
  });
});

// ============================================================================
// buildUrl
// ============================================================================

describe('buildUrl', () => {
  it('should build correct URL with default port and version', () => {
    expect(buildUrl('192.168.1.1', '/powerstate')).toBe('https://192.168.1.1:1926/6/powerstate');
  });

  it('should handle different endpoints', () => {
    expect(buildUrl('10.0.0.5', '/audio/volume')).toBe('https://10.0.0.5:1926/6/audio/volume');
  });
});

// ============================================================================
// parseWwwAuthenticate
// ============================================================================

describe('parseWwwAuthenticate', () => {
  it('should parse standard Digest auth header', () => {
    const header = 'Digest realm="test-realm", nonce="abc123", qop="auth", opaque="xyz789"';
    const result = parseWwwAuthenticate(header);

    expect(result.realm).toBe('test-realm');
    expect(result.nonce).toBe('abc123');
    expect(result.qop).toBe('auth');
    expect(result.opaque).toBe('xyz789');
  });

  it('should handle missing opaque', () => {
    const header = 'Digest realm="tv", nonce="nonce123", qop="auth"';
    const result = parseWwwAuthenticate(header);

    expect(result.realm).toBe('tv');
    expect(result.nonce).toBe('nonce123');
    expect(result.qop).toBe('auth');
    expect(result.opaque).toBeUndefined();
  });

  it('should handle unquoted values', () => {
    const header = 'Digest realm=unquoted, nonce=abc, qop=auth';
    const result = parseWwwAuthenticate(header);

    expect(result.realm).toBe('unquoted');
    expect(result.nonce).toBe('abc');
    expect(result.qop).toBe('auth');
  });

  it('should return empty strings for missing fields', () => {
    const result = parseWwwAuthenticate('Digest');
    expect(result.realm).toBe('');
    expect(result.nonce).toBe('');
    expect(result.qop).toBe('');
  });
});

// ============================================================================
// createDigestAuth
// ============================================================================

describe('createDigestAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return a Digest auth header string', () => {
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('0123456789abcdef') as unknown as ReturnType<typeof crypto.randomBytes>);

    const result = createDigestAuth(
      'user',
      'pass',
      'Digest realm="tv", nonce="nonce123", qop="auth"',
      'GET',
      '/6/powerstate',
    );

    expect(result).toContain('Digest ');
    expect(result).toContain('username="user"');
    expect(result).toContain('realm="tv"');
    expect(result).toContain('nonce="nonce123"');
    expect(result).toContain('uri="/6/powerstate"');
    expect(result).toContain('response="');
    expect(result).toContain('qop=auth');
    expect(result).toContain('nc=00000001');
    expect(result).toContain('cnonce="');
  });

  it('should include opaque when present', () => {
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('0123456789abcdef') as unknown as ReturnType<typeof crypto.randomBytes>);

    const result = createDigestAuth(
      'user',
      'pass',
      'Digest realm="tv", nonce="n", qop="auth", opaque="opq"',
      'POST',
      '/6/audio/volume',
    );

    expect(result).toContain('opaque="opq"');
  });

  it('should omit qop/nc/cnonce when qop is empty', () => {
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('0123456789abcdef') as unknown as ReturnType<typeof crypto.randomBytes>);

    const result = createDigestAuth(
      'user',
      'pass',
      'Digest realm="tv", nonce="n"',
      'GET',
      '/6/system',
    );

    expect(result).not.toContain('qop=');
    expect(result).not.toContain('nc=');
    expect(result).not.toContain('cnonce=');
  });
});

// ============================================================================
// parseErrorResponse
// ============================================================================

describe('parseErrorResponse', () => {
  it('should return known error message for status 401', () => {
    expect(parseErrorResponse(401)).toContain('Invalid PIN');
  });

  it('should return known error message for status 500', () => {
    expect(parseErrorResponse(500)).toContain('internal error');
  });

  it('should extract title from HTML response', () => {
    const html = '<html><head><title>Custom Error</title></head><body></body></html>';
    expect(parseErrorResponse(418, html)).toBe('Custom Error');
  });

  it('should ignore "Status page" title and use <p> instead', () => {
    const html = '<html><head><title>Status page</title></head><body><p>Detailed error</p></body></html>';
    expect(parseErrorResponse(418, html)).toBe('Detailed error');
  });

  it('should return fallback message for unknown status without HTML', () => {
    expect(parseErrorResponse(418)).toBe('Request failed with status 418');
  });

  it('should return fallback for unknown status with non-HTML text', () => {
    expect(parseErrorResponse(503, 'plain text error')).toContain('TV is temporarily unavailable');
  });
});

// ============================================================================
// extractIpv4
// ============================================================================

describe('extractIpv4', () => {
  it('should return IPv4 address when both IPv4 and IPv6 present', () => {
    const device: DiscoveredDevice = {
      name: 'TV',
      host: 'tv.local',
      addresses: ['fe80::1', '192.168.1.100', '::1'],
      port: 1926,
      type: 'androidtvremote2',
    };
    expect(extractIpv4(device)).toBe('192.168.1.100');
  });

  it('should return first address when no IPv4 found', () => {
    const device: DiscoveredDevice = {
      name: 'TV',
      host: 'tv.local',
      addresses: ['fe80::1', '::1'],
      port: 1926,
      type: 'androidtvremote2',
    };
    expect(extractIpv4(device)).toBe('fe80::1');
  });

  it('should fallback to host when no addresses', () => {
    const device: DiscoveredDevice = {
      name: 'TV',
      host: 'tv.local',
      addresses: [],
      port: 1926,
      type: 'androidtvremote2',
    };
    expect(extractIpv4(device)).toBe('tv.local');
  });
});

// ============================================================================
// sendWakeOnLan
// ============================================================================

describe('sendWakeOnLan', () => {
  it('should reject invalid MAC format', async () => {
    await expect(sendWakeOnLan('invalid')).rejects.toThrow('Invalid MAC address');
  });

  it('should reject MAC with wrong length', async () => {
    await expect(sendWakeOnLan('AA:BB:CC')).rejects.toThrow('Invalid MAC address');
  });

  it('should accept MAC with colons', async () => {
    // This will attempt to send a real UDP packet; we just check it doesn't reject for format
    // The actual send may fail on CI but shouldn't throw a format error
    const promise = sendWakeOnLan('AA:BB:CC:DD:EE:FF');
    // Either resolves or rejects with a non-format error
    try {
      await promise;
    } catch (error) {
      expect((error as Error).message).not.toContain('Invalid MAC address');
    }
  });

  it('should accept MAC with dashes', async () => {
    const promise = sendWakeOnLan('AA-BB-CC-DD-EE-FF');
    try {
      await promise;
    } catch (error) {
      expect((error as Error).message).not.toContain('Invalid MAC address');
    }
  });
});

// ============================================================================
// sanitizeForHomeKit
// ============================================================================

describe('sanitizeForHomeKit', () => {
  it('should replace + with Plus', () => {
    expect(sanitizeForHomeKit('Disney+')).toBe('Disney Plus');
  });

  it('should replace & with and', () => {
    expect(sanitizeForHomeKit('AT&T')).toBe('AT and T');
  });

  it('should replace @ with at', () => {
    expect(sanitizeForHomeKit('user@home')).toBe('user at home');
  });

  it('should collapse multiple spaces', () => {
    expect(sanitizeForHomeKit('  Multiple   Spaces  ')).toBe('Multiple Spaces');
  });

  it('should strip non-alphanumeric characters', () => {
    expect(sanitizeForHomeKit('Hello!World')).toBe('Hello World');
  });

  it('should return Unknown for empty string', () => {
    expect(sanitizeForHomeKit('')).toBe('Unknown');
  });

  it('should strip leading/trailing non-alphanumeric', () => {
    expect(sanitizeForHomeKit('---leading')).toBe('leading');
  });

  it('should preserve apostrophes', () => {
    expect(sanitizeForHomeKit('It\'s a test')).toBe('It\'s a test');
  });
});

// ============================================================================
// createDeviceInfo
// ============================================================================

describe('createDeviceInfo', () => {
  it('should create device info with given name', () => {
    const info = createDeviceInfo('TestBridge');
    expect(info.device_name).toBe('TestBridge');
    expect(info.app_name).toBe('Homebridge Philips TV');
    expect(info.type).toBe('native');
    expect(info.id).toHaveLength(16); // 8 random bytes = 16 hex chars
  });

  it('should generate unique IDs', () => {
    const info1 = createDeviceInfo('Bridge1');
    const info2 = createDeviceInfo('Bridge2');
    expect(info1.id).not.toBe(info2.id);
  });
});
