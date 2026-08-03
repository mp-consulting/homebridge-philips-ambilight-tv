/**
 * Certificate pinning is only meaningful against a real TLS handshake, so
 * these tests run a throwaway self-signed HTTPS server rather than mocking
 * the socket layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { X509Certificate } from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { fetch } from 'undici';

import { TV_API_PORT } from '../../src/api/constants.js';
import { createTvAgent, fetchCertFingerprint, normalizeFingerprint } from '../../src/api/utils.js';

let server: https.Server;
let port: number;
let fingerprint: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philips-pin-test-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');

  // A self-signed cert, exactly what a Philips TV presents.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=philips-tv',
  ], { stdio: 'ignore' });

  const cert = fs.readFileSync(certPath);
  fingerprint = normalizeFingerprint(new X509Certificate(cert).fingerprint256);

  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  );

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = () => `https://127.0.0.1:${port}/system`;

describe('normalizeFingerprint', () => {
  it('should strip colons and lowercase', () => {
    expect(normalizeFingerprint('AB:CD:EF')).toBe('abcdef');
  });

  it('should strip whitespace', () => {
    expect(normalizeFingerprint(' AB CD\tEF ')).toBe('abcdef');
  });

  it('should leave an already-normalized value untouched', () => {
    expect(normalizeFingerprint('abcdef')).toBe('abcdef');
  });
});

describe('createTvAgent', () => {
  it('should connect and report the observed fingerprint when unpinned', async () => {
    let observed: string | null = null;
    const agent = createTvAgent({ onCertObserved: (f) => (observed = f) });

    const response = await fetch(url(), { dispatcher: agent });

    expect(response.status).toBe(200);
    expect(observed).toBe(fingerprint);
    await agent.close();
  });

  it('should warn once when connecting without a pin', async () => {
    let warnings = 0;
    const agent = createTvAgent({ onUnpinned: () => warnings++ });

    await fetch(url(), { dispatcher: agent });
    await fetch(url(), { dispatcher: agent });

    expect(warnings).toBe(1);
    await agent.close();
  });

  it('should connect when the pinned fingerprint matches', async () => {
    const agent = createTvAgent({ certFingerprint: fingerprint });

    const response = await fetch(url(), { dispatcher: agent });

    expect(response.status).toBe(200);
    await agent.close();
  });

  it('should accept a colon-separated pin from config', async () => {
    const colonForm = (fingerprint.match(/../g) ?? []).join(':').toUpperCase();
    const agent = createTvAgent({ certFingerprint: colonForm });

    const response = await fetch(url(), { dispatcher: agent });

    expect(response.status).toBe(200);
    await agent.close();
  });

  it('should refuse to connect when the fingerprint does not match', async () => {
    const agent = createTvAgent({ certFingerprint: 'ab'.repeat(32) });

    await expect(fetch(url(), { dispatcher: agent })).rejects.toThrow();
    await agent.close();
  });

  it('should not report a mismatched certificate as observed', async () => {
    let observed: string | null = null;
    const agent = createTvAgent({
      certFingerprint: 'ab'.repeat(32),
      onCertObserved: (f) => (observed = f),
    });

    await expect(fetch(url(), { dispatcher: agent })).rejects.toThrow();

    expect(observed).toBeNull();
    await agent.close();
  });

  it('should capture the fingerprint at pairing time', async () => {
    // fetchCertFingerprint targets the real JointSpace port, so bind a second
    // server there. Skip rather than fail if the port is already taken.
    const pairServer = https.createServer(
      { key: fs.readFileSync(path.join(tmpDir, 'key.pem')), cert: fs.readFileSync(path.join(tmpDir, 'cert.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      },
    );

    const listening = await new Promise<boolean>((resolve) => {
      pairServer.once('error', () => resolve(false));
      pairServer.listen(TV_API_PORT, '127.0.0.1', () => resolve(true));
    });

    if (!listening) {
      return;
    }

    try {
      expect(await fetchCertFingerprint('127.0.0.1')).toBe(fingerprint);
    } finally {
      await new Promise<void>(resolve => pairServer.close(() => resolve()));
    }
  });

  it('should return null when the TV cannot be reached', async () => {
    // 127.0.0.2 has nothing listening on the JointSpace port.
    expect(await fetchCertFingerprint('127.0.0.2', 500)).toBeNull();
  });

  it('should refuse plaintext HTTP once a certificate is pinned', async () => {
    // A plain HTTP server has no certificate to check, so a pinned agent must
    // reject it rather than silently downgrading.
    const plain = await new Promise<{ server: http.Server; port: number }>((resolve) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      s.listen(0, '127.0.0.1', () => resolve({ server: s, port: (s.address() as AddressInfo).port }));
    });

    const agent = createTvAgent({ certFingerprint: fingerprint });
    await expect(
      fetch(`http://127.0.0.1:${plain.port}/system`, { dispatcher: agent }),
    ).rejects.toThrow();

    await agent.close();
    await new Promise<void>(resolve => plain.server.close(() => resolve()));
  });
});
