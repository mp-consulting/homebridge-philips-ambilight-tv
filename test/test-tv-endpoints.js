#!/usr/bin/env node
/**
 * Interactive TV API Debug Script
 *
 * Tests every API endpoint used by the plugin one-by-one, showing full
 * request/response payloads and headers. After each test, prompts you
 * to confirm whether the result looks correct.
 *
 * Generates a debug report JSON file for sharing in GitHub issues.
 *
 * Usage: node test/test-tv-endpoints.js
 */

import {
  buildUrl,
  fetchWithTimeout,
  httpsAgent,
  createDigestAuth,
} from '../dist/api/utils.js';
import fs from 'fs';
import path from 'path';
import readline from 'node:readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// ANSI COLORS
// =============================================================================

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

// =============================================================================
// CONFIG
// =============================================================================

const TV_API_VERSION = 6;
const DEFAULT_TIMEOUT = 5000;
const MAX_BODY_LENGTH = 5000;

const configPath = path.join(__dirname, 'hbConfig/config.json');
if (!fs.existsSync(configPath)) {
  console.error(`${c.red}Config not found: ${configPath}${c.reset}`);
  console.error('Create test/hbConfig/config.json with your TV configuration.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tvConfig = config.platforms.find(p => p.platform === 'PhilipsAmbilightTV')?.devices?.[0];

if (!tvConfig) {
  console.error(`${c.red}No TV device found in config.json${c.reset}`);
  process.exit(1);
}

// =============================================================================
// READLINE
// =============================================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function askVerdict() {
  const prompt = `\n  ${c.bold}Result OK?${c.reset}`
    + ` (${c.green}y${c.reset})es`
    + ` / (${c.red}n${c.reset})o`
    + ` / (${c.yellow}s${c.reset})kip: `;

  while (true) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      return 'pass';
    }
    if (answer === 'n' || answer === 'no') {
      return 'fail';
    }
    if (answer === 's' || answer === 'skip') {
      return 'skip';
    }
    console.log(`  ${c.dim}Please enter y, n, or s${c.reset}`);
  }
}

// =============================================================================
// RAW HTTP REQUEST
// =============================================================================

function headersToObject(headers) {
  const obj = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

function truncate(text, max = MAX_BODY_LENGTH) {
  if (text.length <= max) {
    return text;
  }
  return text.substring(0, max)
    + `\n... (${text.length - max} more characters truncated)`;
}

function formatJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function rawRequest(method, endpoint, body) {
  const url = buildUrl(tvConfig.ip, endpoint);
  const uri = `/${TV_API_VERSION}${endpoint}`;
  const requestHeaders = {};
  if (body) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  const requestBody = body ? JSON.stringify(body) : undefined;

  const start = Date.now();

  try {
    // First request (may get 401)
    const initialResponse = await fetchWithTimeout(
      url,
      {
        method,
        headers: { ...requestHeaders },
        body: requestBody,
        dispatcher: httpsAgent,
      },
      DEFAULT_TIMEOUT,
    );

    if (initialResponse.ok) {
      const responseText = await initialResponse.text();
      return {
        url,
        method,
        requestHeaders,
        requestBody: body ?? null,
        responseStatus: initialResponse.status,
        responseHeaders: headersToObject(initialResponse.headers),
        responseBody: responseText || '(empty)',
        duration: Date.now() - start,
        error: null,
        authType: 'none',
      };
    }

    // Digest auth
    if (initialResponse.status === 401) {
      const wwwAuth = initialResponse.headers.get('www-authenticate');
      if (!wwwAuth?.toLowerCase().startsWith('digest')) {
        return {
          url, method, requestHeaders, requestBody: body ?? null,
          responseStatus: 401,
          responseHeaders: headersToObject(initialResponse.headers),
          responseBody: await initialResponse.text(),
          duration: Date.now() - start,
          error: 'Got 401 but no digest challenge',
          authType: 'failed',
        };
      }

      const authHeader = createDigestAuth(
        tvConfig.username, tvConfig.password, wwwAuth, method, uri,
      );

      const authedHeaders = { ...requestHeaders, Authorization: authHeader };
      const authResponse = await fetchWithTimeout(
        url,
        {
          method,
          headers: authedHeaders,
          body: requestBody,
          dispatcher: httpsAgent,
        },
        DEFAULT_TIMEOUT,
      );

      const responseText = await authResponse.text();
      return {
        url,
        method,
        requestHeaders: authedHeaders,
        requestBody: body ?? null,
        responseStatus: authResponse.status,
        responseHeaders: headersToObject(authResponse.headers),
        responseBody: responseText || '(empty)',
        duration: Date.now() - start,
        error: authResponse.ok ? null : `HTTP ${authResponse.status} after digest auth`,
        authType: 'digest',
      };
    }

    // Other error status
    const responseText = await initialResponse.text();
    return {
      url, method, requestHeaders, requestBody: body ?? null,
      responseStatus: initialResponse.status,
      responseHeaders: headersToObject(initialResponse.headers),
      responseBody: responseText || '(empty)',
      duration: Date.now() - start,
      error: `HTTP ${initialResponse.status}`,
      authType: 'none',
    };

  } catch (err) {
    return {
      url, method, requestHeaders, requestBody: body ?? null,
      responseStatus: null,
      responseHeaders: null,
      responseBody: null,
      duration: Date.now() - start,
      error: err.message,
      authType: 'none',
    };
  }
}

// =============================================================================
// DISPLAY & TEST
// =============================================================================

function printRequest(result) {
  const statusColor = result.error ? c.red : c.green;
  const statusText = result.responseStatus
    ? `${result.responseStatus}${result.error ? ` (${result.error})` : ''}`
    : result.error;

  console.log(`\n  ${c.cyan}REQUEST${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(60)}${c.reset}`);
  console.log(`  ${c.bold}${result.method}${c.reset} ${result.url}`);
  console.log(`  ${c.dim}Auth: ${result.authType}${c.reset}`);

  // Request headers (skip Authorization for readability, show it's digest)
  const displayHeaders = { ...result.requestHeaders };
  if (displayHeaders.Authorization) {
    displayHeaders.Authorization = 'Digest ...';
  }
  if (Object.keys(displayHeaders).length > 0) {
    console.log(`  ${c.dim}Headers: ${JSON.stringify(displayHeaders)}${c.reset}`);
  }

  if (result.requestBody) {
    console.log(`  ${c.dim}Body:${c.reset}`);
    console.log(`  ${c.magenta}${JSON.stringify(result.requestBody, null, 2).split('\n').join('\n  ')}${c.reset}`);
  }

  console.log(`\n  ${c.cyan}RESPONSE${c.reset} ${c.dim}(${result.duration}ms)${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(60)}${c.reset}`);
  console.log(`  ${c.bold}Status:${c.reset} ${statusColor}${statusText}${c.reset}`);

  if (result.responseHeaders) {
    const relevantHeaders = {};
    for (const [key, value] of Object.entries(result.responseHeaders)) {
      if (['content-type', 'content-length', 'server', 'www-authenticate'].includes(key.toLowerCase())) {
        relevantHeaders[key] = value;
      }
    }
    if (Object.keys(relevantHeaders).length > 0) {
      console.log(`  ${c.dim}Headers: ${JSON.stringify(relevantHeaders)}${c.reset}`);
    }
  }

  if (result.responseBody && result.responseBody !== '(empty)') {
    const formatted = truncate(formatJson(result.responseBody));
    console.log(`  ${c.dim}Body:${c.reset}`);
    console.log(`  ${c.green}${formatted.split('\n').join('\n  ')}${c.reset}`);
  } else {
    console.log(`  ${c.dim}Body: (empty)${c.reset}`);
  }
}

const results = [];

async function testEndpoint(name, method, endpoint, body) {
  console.log(`\n${c.bold}${c.cyan}[${'─'.repeat(60)}]${c.reset}`);
  console.log(`${c.bold}  ${name}${c.reset}`);
  console.log(`${c.bold}${c.cyan}[${'─'.repeat(60)}]${c.reset}`);

  const result = await rawRequest(method, endpoint, body);
  printRequest(result);

  const verdict = await askVerdict();

  const icons = {
    pass: `${c.green}PASS${c.reset}`,
    fail: `${c.red}FAIL${c.reset}`,
    skip: `${c.yellow}SKIP${c.reset}`,
  };
  const icon = icons[verdict];
  console.log(`  ${c.bold}Verdict: ${icon}${c.reset}`);

  results.push({
    name,
    method,
    endpoint,
    requestBody: result.requestBody,
    responseStatus: result.responseStatus,
    responseBody: result.responseBody,
    duration: result.duration,
    error: result.error,
    authType: result.authType,
    verdict,
  });

  return result;
}

// =============================================================================
// TEST DEFINITIONS
// =============================================================================

const GET_TESTS = [
  { name: 'System Info', endpoint: '/system' },
  { name: 'Power State', endpoint: '/powerstate' },
  { name: 'Audio Volume', endpoint: '/audio/volume' },
  { name: 'Input Sources', endpoint: '/sources' },
  { name: 'Current Activity', endpoint: '/activities/current' },
  { name: 'Applications', endpoint: '/applications' },
  { name: 'TV Channels', endpoint: '/channeldb/tv/channelLists/all' },
  { name: 'Ambilight Power', endpoint: '/ambilight/power' },
  { name: 'Ambilight Configuration', endpoint: '/ambilight/currentconfiguration' },
  { name: 'Ambilight Topology', endpoint: '/ambilight/topology' },
  { name: 'Ambilight Mode', endpoint: '/ambilight/mode' },
  { name: 'Settings Structure', endpoint: '/menuitems/settings/structure' },
];

const POST_TESTS = [
  {
    name: 'Set Power On',
    endpoint: '/powerstate',
    body: { powerstate: 'On' },
  },
  {
    name: 'Unmute Audio',
    endpoint: '/audio/volume',
    body: { muted: false },
  },
  {
    name: 'Send Key (VolumeUp)',
    endpoint: '/input/key',
    body: { key: 'VolumeUp' },
  },
  {
    name: 'Ambilight Power On',
    endpoint: '/ambilight/power',
    body: { power: 'On' },
  },
  {
    name: 'Ambilight Power Off',
    endpoint: '/ambilight/power',
    body: { power: 'Off' },
  },
  {
    name: 'Ambilight Style (FOLLOW_VIDEO)',
    endpoint: '/ambilight/currentconfiguration',
    body: { styleName: 'FOLLOW_VIDEO', isExpert: true, algorithm: 'STANDARD' },
  },
  {
    name: 'Ambilight Style (OFF)',
    endpoint: '/ambilight/currentconfiguration',
    body: { styleName: 'OFF', isExpert: false },
  },
  {
    name: 'Launch Watch TV',
    endpoint: '/activities/launch',
    body: {
      intent: {
        component: {
          packageName: 'org.droidtv.playtv',
          className: 'org.droidtv.playtv.PlayTvActivity',
        },
        action: 'Intent.ACTION_MAIN',
      },
    },
  },
];

// =============================================================================
// REPORT
// =============================================================================

function printSummary() {
  console.log(`\n${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log(`${c.bold}  DEBUG REPORT SUMMARY${c.reset}`);
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log(`  TV: ${tvConfig.name} (${tvConfig.ip})\n`);

  const pad = (s, n) => s.toString().padEnd(n);
  console.log(`  ${c.dim}${pad('Endpoint', 40)} ${pad('Status', 8)} ${pad('Time', 8)} Verdict${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(70)}${c.reset}`);

  for (const r of results) {
    const statusColor = r.error ? c.red : c.green;
    const verdictColors = { pass: c.green, fail: c.red, skip: c.yellow };
    const verdictColor = verdictColors[r.verdict] || c.reset;
    const status = r.error
      ? `${r.responseStatus || 'ERR'}`
      : `${r.responseStatus}`;
    const endpoint = pad(`${r.method} ${r.endpoint}`, 40);
    const time = pad(r.duration + 'ms', 8);
    const verdict = r.verdict.toUpperCase();
    console.log(
      `  ${endpoint} ${statusColor}${pad(status, 8)}${c.reset}`
      + ` ${time} ${verdictColor}${verdict}${c.reset}`,
    );
  }

  const passed = results.filter(r => r.verdict === 'pass').length;
  const failed = results.filter(r => r.verdict === 'fail').length;
  const skipped = results.filter(r => r.verdict === 'skip').length;
  const httpErrors = results.filter(r => r.error).length;

  console.log(
    `\n  ${c.green}Passed: ${passed}${c.reset}`
    + `  ${c.red}Failed: ${failed}${c.reset}`
    + `  ${c.yellow}Skipped: ${skipped}${c.reset}`
    + `  ${c.red}HTTP Errors: ${httpErrors}${c.reset}`,
  );
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);

  return { passed, failed, skipped, httpErrors };
}

function saveReport() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(__dirname, `debug-report-${timestamp}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    tv: {
      name: tvConfig.name,
      ip: tvConfig.ip,
      mac: tvConfig.mac,
    },
    results,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  ${c.dim}Report saved to: ${reportPath}${c.reset}`);
  return reportPath;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log(`${c.bold}  Philips TV API Debug Script${c.reset}`);
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log(`  TV:  ${tvConfig.name}`);
  console.log(`  IP:  ${tvConfig.ip}`);
  console.log(`  MAC: ${tvConfig.mac}`);
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log('\n  For each endpoint, review the request/response and confirm');
  console.log('  whether the result looks correct.\n');

  // GET tests
  console.log(`${c.bold}${c.cyan}\n  === GET ENDPOINTS (read-only, safe) ===${c.reset}\n`);

  for (const test of GET_TESTS) {
    await testEndpoint(test.name, 'GET', test.endpoint);
  }

  // POST tests (opt-in)
  console.log(`\n${c.bold}${c.yellow}  === POST ENDPOINTS (will send commands to your TV) ===${c.reset}`);
  const runPosts = (await ask(`\n  Run POST tests? (${c.green}y${c.reset}/${c.red}n${c.reset}): `)).trim().toLowerCase();

  if (runPosts === 'y' || runPosts === 'yes') {
    for (const test of POST_TESTS) {
      await testEndpoint(test.name, 'POST', test.endpoint, test.body);
    }
  } else {
    console.log(`  ${c.dim}Skipping POST tests.${c.reset}`);
  }

  // Summary & report
  printSummary();
  saveReport();

  rl.close();
}

main().catch(err => {
  console.error(`${c.red}Fatal error: ${err.message}${c.reset}`);
  rl.close();
  process.exit(1);
});
