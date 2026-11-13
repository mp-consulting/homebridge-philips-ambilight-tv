/**
 * Minimal ADB-over-network client.
 *
 * Recent Philips firmwares only expose a handful of system apps through
 * JointSpace `/applications` and reject `/activities/launch` for anything else
 * (HTTP 400). When "Network debugging" is enabled on the TV, ADB can list and
 * launch every installed app. Shells out to the `adb` binary.
 */

import { execFile } from 'node:child_process';

import { MIN_EXECUTION_MS } from './constants.js';
import type { TVApplication } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const ADB_BINARY = 'adb';
const ADB_PORT = 5555;

/** After a failed command, fail fast for this long rather than spawning adb
 *  again (adb not installed, network debugging off, TV still waking...). */
export const ADB_RETRY_MS = 60_000;

const LIST_APPS_CMD = 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER';
const CURRENT_APP_CMD = 'dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"';

/** Android package and class names; anything else never reaches the remote shell */
const PACKAGE = '[\\w.]+';
const CLASS = '[\\w.$]+';
const PACKAGE_PATTERN = new RegExp(`^${PACKAGE}$`);
const CLASS_PATTERN = new RegExp(`^${CLASS}$`);
const COMPONENT_LINE = new RegExp(`^(${PACKAGE})/(${CLASS})$`);
const RESUMED_RECORD = new RegExp(`u\\d+ (${PACKAGE})/(${CLASS})`);

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
// TYPES
// ============================================================================

export interface AdbComponent {
  packageName: string;
  className: string;
}

/** Thrown while ADB is backing off after a failure — expected, not worth logging again. */
export class AdbUnavailableError extends Error {}

// ============================================================================
// HELPERS
// ============================================================================

/** Resolve a class name relative to its package (`.MainActivity` → `pkg.MainActivity`) */
function absoluteClass(packageName: string, className: string): string {
  return className.startsWith('.') ? packageName + className : className;
}

function toComponent(match: RegExpMatchArray | null): AdbComponent | null {
  if (!match) {
    return null;
  }
  const [, packageName, className] = match;
  return { packageName, className: absoluteClass(packageName, className) };
}

/** Parse `query-activities --brief` output into launchable components */
export function parseActivities(stdout: string): AdbComponent[] {
  return stdout.split('\n')
    .map(line => toComponent(line.trim().match(COMPONENT_LINE)))
    .filter((component): component is AdbComponent => component !== null);
}

/** Extract the foreground component from a `dumpsys activity` ActivityRecord line */
export function parseCurrentComponent(stdout: string): AdbComponent | null {
  return toComponent(stdout.match(RESUMED_RECORD));
}

export function labelForPackage(packageName: string): string {
  if (KNOWN_LABELS[packageName]) {
    return KNOWN_LABELS[packageName];
  }
  // Naive heuristic; users can rename the input in the sources UI
  const segment = packageName.split('.').reverse().find(s => !GENERIC_SEGMENTS.has(s)) ?? packageName;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

// ============================================================================
// CLIENT CLASS
// ============================================================================

/**
 * Every operation takes an absolute `deadline` (ms since epoch) covering the
 * connect and the shell command together.
 */
export class AdbClient {
  private readonly serial: string;

  /** The `adb connect` that succeeded or is in flight, shared by concurrent callers; null to reconnect */
  private connection: Promise<void> | null = null;

  /** No command before this time, after a failed one */
  private unavailableUntil = 0;

  constructor(ip: string) {
    this.serial = `${ip}:${ADB_PORT}`;
  }

  /** Run the adb binary, resolving with stdout + stderr. */
  private exec(args: string[], deadline: number): Promise<string> {
    // A zero timeout would mean "no timeout" to execFile
    const timeout = Math.max(1, deadline - Date.now());
    return new Promise((resolve, reject) => {
      execFile(ADB_BINARY, args, { timeout }, (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          reject(missing ? new Error('adb binary not found — install adb on the Homebridge host') : error);
          return;
        }
        resolve(`${stdout}${stderr}`);
      });
    });
  }

  private connect(deadline: number): Promise<void> {
    if (!this.connection) {
      // `adb connect` exits 0 even when it fails, so read its answer
      const connection = this.exec(['connect', this.serial], deadline).then(out => {
        if (!out.includes('connected to') || out.includes('failed')) {
          throw new Error(out.trim() || `adb could not connect to ${this.serial}`);
        }
      });
      connection.catch(() => {
        if (this.connection === connection) {
          this.connection = null;
        }
      });
      this.connection = connection;
    }
    return this.connection;
  }

  /**
   * Run a shell command on the TV. A connection that went stale (TV rebooted,
   * network debugging toggled) is re-established once; any failure makes the
   * following commands fail fast for {@link ADB_RETRY_MS}.
   */
  private async shell(command: string, deadline: number): Promise<string> {
    if (Date.now() < this.unavailableUntil) {
      throw new AdbUnavailableError('adb unavailable after a recent failure');
    }
    if (deadline - Date.now() < MIN_EXECUTION_MS) {
      throw new Error('no time left for adb');
    }
    const run = () => this.exec(['-s', this.serial, 'shell', command], deadline);
    try {
      const reused = this.connection !== null;
      await this.connect(deadline);
      try {
        return await run();
      } catch (error) {
        this.connection = null;
        if (!reused) {
          throw error;
        }
        await this.connect(deadline);
        return await run();
      }
    } catch (error) {
      this.unavailableUntil = Date.now() + ADB_RETRY_MS;
      throw error;
    }
  }

  async getApplications(deadline: number): Promise<TVApplication[]> {
    return parseActivities(await this.shell(LIST_APPS_CMD, deadline)).map(component => ({
      id: component.packageName,
      label: labelForPackage(component.packageName),
      intent: { component, action: 'android.intent.action.MAIN' },
    }));
  }

  /**
   * Launch an app. With a className the exact activity is started (works for
   * sideloaded apps that have no Leanback launcher entry); without one the
   * app's Leanback launcher activity is used.
   */
  async launch(packageName: string, className: string | undefined, deadline: number): Promise<boolean> {
    if (!PACKAGE_PATTERN.test(packageName) || (className !== undefined && !CLASS_PATTERN.test(className))) {
      return false;
    }
    if (className) {
      // Single quotes: `$` is legal in class names but would expand in the remote shell
      const out = await this.shell(`am start -n '${packageName}/${absoluteClass(packageName, className)}'`, deadline);
      return !/\bError\b/.test(out);
    }
    const out = await this.shell(`monkey -p ${packageName} -c android.intent.category.LEANBACK_LAUNCHER 1`, deadline);
    return out.includes('Events injected: 1');
  }

  async getCurrentComponent(deadline: number): Promise<AdbComponent | null> {
    return parseCurrentComponent(await this.shell(CURRENT_APP_CMD, deadline));
  }
}
