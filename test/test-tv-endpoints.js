#!/usr/bin/env node
/**
 * Test script for Philips TV API endpoints
 * Usage: node test/test-tv-endpoints.js [--raw]
 *
 * Options:
 *   --raw    Test TV directly without using PhilipsTVClient
 */

 

import { PhilipsTVClient } from '../dist/api/PhilipsTVClient.js';
import {
  buildUrl,
  fetchWithTimeout,
  httpsAgent,
  createDigestAuth,
} from '../dist/api/utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isRawMode = process.argv.includes('--raw');

// Load config
const configPath = path.join(__dirname, 'hbConfig/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tvConfig = config.platforms.find(p => p.platform === 'PhilipsAmbilightTV')?.devices?.[0];

if (!tvConfig) {
  console.error('❌ No TV configuration found in config.json');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Philips TV API Endpoint Test ${isRawMode ? '(RAW MODE)' : '(Client Mode)'}`);
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  TV Name: ${tvConfig.name}`);
console.log(`  IP: ${tvConfig.ip}`);
console.log(`  MAC: ${tvConfig.mac}`);
console.log('═══════════════════════════════════════════════════════════════\n');

const results = [];

async function testEndpoint(name, fn) {
  process.stdout.write(`Testing ${name}... `);
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    console.log(`✅ OK (${duration}ms)`);
    results.push({ name, success: true, duration, result });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.log(`❌ FAILED (${duration}ms) - ${error.message}`);
    results.push({ name, success: false, duration, error: error.message });
    return null;
  }
}

// ============================================================================
// RAW API HELPERS (Direct HTTP calls without PhilipsTVClient)
// ============================================================================

const TV_API_VERSION = 6;
const DEFAULT_TIMEOUT = 5000;

async function rawGet(endpoint, timeout = DEFAULT_TIMEOUT) {
  const url = buildUrl(tvConfig.ip, endpoint);
  const uri = `/${TV_API_VERSION}${endpoint}`;

  // First request (may get 401)
  const initialResponse = await fetchWithTimeout(
    url,
    { method: 'GET', dispatcher: httpsAgent },
    timeout,
  );

  if (initialResponse.ok) {
    const text = await initialResponse.text();
    return text ? JSON.parse(text) : null;
  }

  // Handle digest auth
  if (initialResponse.status === 401) {
    const wwwAuth = initialResponse.headers.get('www-authenticate');
    if (wwwAuth?.toLowerCase().startsWith('digest')) {
      const authHeader = createDigestAuth(
        tvConfig.username,
        tvConfig.password,
        wwwAuth,
        'GET',
        uri,
      );

      const authResponse = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Authorization: authHeader },
          dispatcher: httpsAgent,
        },
        timeout,
      );

      if (authResponse.ok) {
        const text = await authResponse.text();
        return text ? JSON.parse(text) : null;
      }
      throw new Error(`HTTP ${authResponse.status} after auth`);
    }
  }

  throw new Error(`HTTP ${initialResponse.status}`);
}

async function _rawPost(endpoint, body, timeout = DEFAULT_TIMEOUT) {
  const url = buildUrl(tvConfig.ip, endpoint);
  const uri = `/${TV_API_VERSION}${endpoint}`;

  // First request (may get 401)
  const initialResponse = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: httpsAgent,
    },
    timeout,
  );

  if (initialResponse.ok) {
    const text = await initialResponse.text();
    return text ? JSON.parse(text) : null;
  }

  // Handle digest auth
  if (initialResponse.status === 401) {
    const wwwAuth = initialResponse.headers.get('www-authenticate');
    if (wwwAuth?.toLowerCase().startsWith('digest')) {
      const authHeader = createDigestAuth(
        tvConfig.username,
        tvConfig.password,
        wwwAuth,
        'POST',
        uri,
      );

      const authResponse = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: JSON.stringify(body),
          dispatcher: httpsAgent,
        },
        timeout,
      );

      if (authResponse.ok) {
        const text = await authResponse.text();
        return text ? JSON.parse(text) : null;
      }
      throw new Error(`HTTP ${authResponse.status} after auth`);
    }
  }

  throw new Error(`HTTP ${initialResponse.status}`);
}

// ============================================================================
// RAW MODE TESTS
// ============================================================================

async function runRawTests() {
  // System
  console.log('\n📺 SYSTEM ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const systemInfo = await testEndpoint('GET /system', () => rawGet('/system'));
  if (systemInfo) {
    console.log(`   └─ Model: ${systemInfo.model || 'N/A'}`);
    console.log(`   └─ Serial: ${systemInfo.serialnumber || 'N/A'}`);
    console.log(`   └─ Software: ${systemInfo.softwareversion || 'N/A'}`);
    console.log(`   └─ API Version: ${systemInfo.api_version?.Major || 'N/A'}.${systemInfo.api_version?.Minor || 'N/A'}`);
  }

  // Power
  console.log('\n⚡ POWER ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const powerState = await testEndpoint('GET /powerstate', () => rawGet('/powerstate'));
  if (powerState) {
    console.log(`   └─ Power is: ${powerState.powerstate}`);
  }

  // Volume
  console.log('\n🔊 VOLUME ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const volume = await testEndpoint('GET /audio/volume', () => rawGet('/audio/volume'));
  if (volume) {
    console.log(`   └─ Current: ${volume.current}/${volume.max}`);
    console.log(`   └─ Muted: ${volume.muted}`);
    console.log(`   └─ Min: ${volume.min}`);
  }

  // Applications
  console.log('\n📱 APPLICATION ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const appsResponse = await testEndpoint('GET /applications', () => rawGet('/applications'));
  if (appsResponse?.applications) {
    const apps = appsResponse.applications;
    console.log(`   └─ Found ${apps.length} apps:`);
    apps.slice(0, 10).forEach(app => {
      const pkg = app.intent?.component?.packageName || 'N/A';
      console.log(`      • ${app.label} (${pkg})`);
    });
    if (apps.length > 10) {
      console.log(`      ... and ${apps.length - 10} more`);
    }
  }

  const currentActivity = await testEndpoint('GET /activities/current', () => rawGet('/activities/current'));
  if (currentActivity) {
    console.log(`   └─ Package: ${currentActivity.component?.packageName || 'N/A'}`);
    console.log(`   └─ Class: ${currentActivity.component?.className || 'N/A'}`);
  }

  // Channels
  console.log('\n📺 CHANNEL ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const channelsResponse = await testEndpoint('GET /channeldb/tv/channelLists/all', () =>
    rawGet('/channeldb/tv/channelLists/all'),
  );
  if (channelsResponse?.Channel) {
    const channels = channelsResponse.Channel;
    console.log(`   └─ Found ${channels.length} channels:`);
    channels.slice(0, 5).forEach(ch => {
      console.log(`      • ${ch.name} (ccid: ${ch.ccid}, preset: ${ch.preset})`);
    });
    if (channels.length > 5) {
      console.log(`      ... and ${channels.length - 5} more`);
    }
  }

  // Ambilight
  console.log('\n💡 AMBILIGHT ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const ambilightPower = await testEndpoint('GET /ambilight/power', () => rawGet('/ambilight/power'));
  if (ambilightPower) {
    console.log(`   └─ Power: ${ambilightPower.power}`);
  }

  const ambilightMode = await testEndpoint('GET /ambilight/mode', () => rawGet('/ambilight/mode'));
  if (ambilightMode) {
    console.log(`   └─ Mode: ${ambilightMode.current}`);
  }

  const ambilightTopology = await testEndpoint('GET /ambilight/topology', () => rawGet('/ambilight/topology'));
  if (ambilightTopology) {
    console.log(`   └─ Layers: ${ambilightTopology.layers}`);
    console.log(`   └─ Left: ${ambilightTopology.left}`);
    console.log(`   └─ Top: ${ambilightTopology.top}`);
    console.log(`   └─ Right: ${ambilightTopology.right}`);
    console.log(`   └─ Bottom: ${ambilightTopology.bottom}`);
  }

  // Additional raw endpoints
  console.log('\n🔧 ADDITIONAL ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  const menuitemsSettings = await testEndpoint('GET /menuitems/settings/structure', () =>
    rawGet('/menuitems/settings/structure'),
  );
  if (menuitemsSettings) {
    console.log('   └─ Settings structure retrieved');
  }

  const sources = await testEndpoint('GET /sources', () => rawGet('/sources'));
  if (sources) {
    console.log(`   └─ Sources: ${JSON.stringify(sources).substring(0, 100)}...`);
  }

  const input = await testEndpoint('GET /input/pointer', () => rawGet('/input/pointer'));
  if (input) {
    console.log(`   └─ Pointer: ${JSON.stringify(input)}`);
  }

  // Test POST endpoint (send a harmless key)
  console.log('\n⌨️ INPUT ENDPOINTS (RAW)');
  console.log('─────────────────────────────────────────────────────────────────');

  // Note: This sends an actual key press - commenting out to avoid unintended actions
  // const keyResult = await testEndpoint('POST /input/key (VolumeUp)', () =>
  //   rawPost('/input/key', { key: 'VolumeUp' })
  // );

  console.log('   └─ Skipping key press tests to avoid unintended TV actions');
  console.log('   └─ Uncomment in code to test POST /input/key');

  return printSummary();
}

// ============================================================================
// CLIENT MODE TESTS
// ============================================================================

async function runClientTests() {
  const client = new PhilipsTVClient({
    ip: tvConfig.ip,
    mac: tvConfig.mac,
    username: tvConfig.username,
    password: tvConfig.password,
  });

  // System
  console.log('\n📺 SYSTEM ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  await testEndpoint('isReachable()', () => client.isReachable());

  const systemInfo = await testEndpoint('getSystemInfo()', () => client.getSystemInfo());
  if (systemInfo) {
    console.log(`   └─ Model: ${systemInfo.model || 'N/A'}`);
    console.log(`   └─ Serial: ${systemInfo.serialnumber || 'N/A'}`);
    console.log(`   └─ Software: ${systemInfo.softwareversion || 'N/A'}`);
  }

  // Power
  console.log('\n⚡ POWER ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const powerState = await testEndpoint('getPowerState()', () => client.getPowerState());
  if (powerState !== null) {
    console.log(`   └─ Power is: ${powerState ? 'ON' : 'STANDBY'}`);
  }

  // Volume
  console.log('\n🔊 VOLUME ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const volume = await testEndpoint('getVolume()', () => client.getVolume());
  if (volume) {
    console.log(`   └─ Current: ${volume.current}/${volume.max}`);
    console.log(`   └─ Muted: ${volume.muted}`);
  }

  // Sources
  console.log('\n📡 SOURCE ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const sources = await testEndpoint('getSources()', () => client.getSources());
  if (sources) {
    console.log(`   └─ Found ${sources.length} sources:`);
    sources.forEach(s => {
      const idPreview = s.id.length > 40 ? `${s.id.substring(0, 40)}...` : s.id;
      console.log(`      • ${s.name} (${idPreview})`);
    });
  }

  const builtInSources = await testEndpoint('getBuiltInSources() [static]', () => Promise.resolve(client.getBuiltInSources()));
  if (builtInSources) {
    console.log(`   └─ Found ${builtInSources.length} built-in sources (hardcoded)`);
  }

  // Applications
  console.log('\n📱 APPLICATION ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const apps = await testEndpoint('getApplications()', () => client.getApplications());
  if (apps && apps.length > 0) {
    console.log(`   └─ Found ${apps.length} apps:`);
    apps.slice(0, 10).forEach(app => {
      const pkg = app.intent?.component?.packageName || 'N/A';
      console.log(`      • ${app.label} (${pkg})`);
    });
    if (apps.length > 10) {
      console.log(`      ... and ${apps.length - 10} more`);
    }
  }

  const currentActivity = await testEndpoint('getCurrentActivity()', () => client.getCurrentActivity());
  if (currentActivity) {
    console.log(`   └─ Current: ${currentActivity}`);
  }

  // Channels
  console.log('\n📺 CHANNEL ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const channels = await testEndpoint('getChannels()', () => client.getChannels());
  if (channels && channels.length > 0) {
    console.log(`   └─ Found ${channels.length} channels:`);
    channels.slice(0, 5).forEach(ch => {
      console.log(`      • ${ch.name} (ccid: ${ch.ccid})`);
    });
    if (channels.length > 5) {
      console.log(`      ... and ${channels.length - 5} more`);
    }
  }

  // Ambilight
  console.log('\n💡 AMBILIGHT ENDPOINTS');
  console.log('─────────────────────────────────────────────────────────────────');

  const ambilightPower = await testEndpoint('getAmbilightPower()', () => client.getAmbilightPower());
  if (ambilightPower !== null) {
    console.log(`   └─ Ambilight is: ${ambilightPower ? 'ON' : 'OFF'}`);
  }

  return printSummary();
}

// ============================================================================
// SUMMARY
// ============================================================================

function printSummary() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⏱️  Total time: ${totalDuration}ms`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  • ${r.name}: ${r.error}`);
    });
  }

  return {
    tv: {
      name: tvConfig.name,
      ip: tvConfig.ip,
      mac: tvConfig.mac,
    },
    summary: {
      passed,
      failed,
      totalDuration,
    },
    tests: results,
  };
}

// ============================================================================
// RUN TESTS
// ============================================================================

const runTests = isRawMode ? runRawTests : runClientTests;

runTests()
  .then(results => {
    process.exit(results.summary.failed > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
