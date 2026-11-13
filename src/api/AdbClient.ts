/**
 * Minimal ADB-over-network client.
 *
 * Recent Philips firmwares only expose a handful of system apps through
 * JointSpace `/applications` and reject `/activities/launch` for anything else
 * (HTTP 400). When "Network debugging" is enabled on the TV, ADB can list and
 * launch every installed app. Shells out to the `adb` binary.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TVApplication } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const run = promisify(execFile);

const ADB_PORT = 5555;
const ADB_TIMEOUT_MS = 8000;

const LIST_APPS_CMD = 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER';
const CURRENT_APP_CMD = 'dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"';

/** ADB cannot read app labels, so name the common ones; others derive from the package */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
  'com.google.android.youtube.tv': 'YouTube',
  'com.netflix.ninja': 'Netflix',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.spotify.tv.android': 'Spotify',
  'tv.twitch.android.app': 'Twitch',
  'com.canal.android.canal': 'Canal+',
  'fr.francetv.pluzz': 'france.tv',
  'fr.tf1.mytf1': 'TF1+',
  'fr.m6.m6replay': 'M6+',
  'org.smarttube.stable': 'SmartTube',
  'com.google.android.play.games': 'Play Games',
  'com.android.vending': 'Play Store',
};

/** Package segments that never make a good label */
const GENERIC_SEGMENTS = new Set(['com', 'org', 'net', 'fr', 'tv', 'android', 'androidtv', 'app', 'stable', 'livingroom', 'google']);

// ============================================================================
// HELPERS
// ============================================================================

/** Parse `query-activities --brief` output into launchable components */
export function parseActivities(stdout: string): { packageName: string; className: string }[] {
  const result: { packageName: string; className: string }[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^([\w.]+)\/([\w.$]+)$/);
    if (match) {
      const [, packageName, cls] = match;
      result.push({ packageName, className: cls.startsWith('.') ? packageName + cls : cls });
    }
  }
  return result;
}

/** Extract the foreground package from a `dumpsys activity` ActivityRecord line */
export function parseCurrentPackage(stdout: string): string | null {
  return stdout.match(/u\d+ ([\w.]+)\//)?.[1] ?? null;
}

export function labelForPackage(packageName: string): string {
  if (KNOWN_LABELS[packageName]) {
    return KNOWN_LABELS[packageName];
  }
  // ponytail: naive heuristic, users can rename via customName in the sources UI
  const segment = packageName.split('.').reverse().find(s => !GENERIC_SEGMENTS.has(s)) ?? packageName;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

// ============================================================================
// CLIENT CLASS
// ============================================================================

export class AdbClient {
  private readonly serial: string;

  constructor(ip: string, private readonly adbPath = 'adb') {
    this.serial = `${ip}:${ADB_PORT}`;
  }

  private async shell(command: string): Promise<string> {
    // `adb connect` is idempotent and cheap when already connected
    await run(this.adbPath, ['connect', this.serial], { timeout: ADB_TIMEOUT_MS });
    const { stdout } = await run(this.adbPath, ['-s', this.serial, 'shell', command], { timeout: ADB_TIMEOUT_MS });
    return stdout;
  }

  async getApplications(): Promise<TVApplication[]> {
    return parseActivities(await this.shell(LIST_APPS_CMD)).map(component => ({
      id: `${component.className}-${component.packageName}`,
      label: labelForPackage(component.packageName),
      type: 'app',
      intent: { component, action: 'android.intent.action.MAIN' },
    }));
  }

  /** Launch an app by package; no activity name needed */
  async launch(packageName: string): Promise<boolean> {
    if (!/^[\w.]+$/.test(packageName)) {
      return false;
    }
    const out = await this.shell(`monkey -p ${packageName} -c android.intent.category.LEANBACK_LAUNCHER 1`);
    return out.includes('Events injected: 1');
  }

  async getCurrentPackage(): Promise<string | null> {
    return parseCurrentPackage(await this.shell(CURRENT_APP_CMD));
  }
}
