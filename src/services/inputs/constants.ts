import { HDMI_SOURCES } from '../../api/PhilipsTVClient.js';
import type { RemoteKey } from '../../api/types.js';

// ============================================================================
// LIMITS
// ============================================================================

/** Maximum number of input sources (static + apps). HomeKit allows up to 100
 *  services per accessory but too many causes performance issues. */
export const MAX_INPUT_SOURCES = 30;

/** Number of static sources (Watch TV + Home + HDMI 1-4). Identifiers are
 *  allocated from STATIC_SOURCE_COUNT + 1 upwards (see InputConfigStore). */
export const STATIC_SOURCE_COUNT = 2 + Object.keys(HDMI_SOURCES).length;

/** How long input-config changes are coalesced before they are written to disk.
 *  A HomeKit rename or visibility toggle often arrives as a burst of writes. */
export const SAVE_DEBOUNCE_MS = 500;

// ============================================================================
// SWITCH ARBITRATION TIMINGS
// ============================================================================

/** How long to ignore polls reporting the *previous* app after a manual switch
 *  before accepting the TV's report. Guards the wheel against bouncing back off
 *  the user's selection while the TV is still switching (a cold app start can
 *  take 10s+), without masking a switch that genuinely failed. Time-based
 *  because the long-poll can deliver several contradicting reports within a
 *  couple of seconds of the launch. */
export const PENDING_CONFIRM_TIMEOUT_MS = 20_000;

/** How many consecutive sightings an ambiguous system report (NA / playtv)
 *  needs before it is applied, and how recent the previous sighting must be
 *  to count as consecutive. The TV emits these transiently while switching
 *  between apps — acting on a single sighting ratcheted the state onto the
 *  wrong source (e.g. Disney+ playing but HomeKit stuck on Watch TV). A
 *  report that directly names a registered input is applied immediately. */
export const AMBIGUOUS_CONFIRM_SIGHTINGS = 2;
export const AMBIGUOUS_CONFIRM_WINDOW_MS = 60_000;

/** How long a selection made while the TV was off or waking is held for replay.
 *  A HomeKit scene that turns the TV on and picks a source writes both
 *  characteristics at once, but the TV needs several seconds to finish booting
 *  before it will accept a launch — so the selection is parked and re-applied
 *  once the TV is genuinely reachable. Long enough to cover a cold start from
 *  deep standby, short enough that a selection never surfaces unexpectedly
 *  much later. */
export const WAKE_REPLAY_WINDOW_MS = 90_000;

/** Attempts made when replaying a parked selection. The TV answers /powerstate
 *  while its launcher is still coming up, so a single try at the power-on edge
 *  is not enough. Sized from the logs in issue #14: the earliest launch seen to
 *  succeed after a wake landed 6s past the `Power: On` edge, so the retries run
 *  well past that to leave real margin. Each attempt costs a launch, the settle
 *  below and a retry gap, which puts the last of them past WAKE_WINDOW_MS —
 *  deliberately, since a set that slow is the one still booting. The
 *  confirmation does not lapse with the window, so those attempts are checked
 *  like any other. */
export const WAKE_REPLAY_ATTEMPTS = 5;
export const WAKE_REPLAY_RETRY_MS = 3_000;

/** How long to let the TV settle before checking whether a replayed launch
 *  actually took. Long enough for an app that is genuinely starting to reach
 *  the foreground, so a starting app isn't mistaken for a dropped launch and
 *  relaunched under itself. */
export const WAKE_CONFIRM_SETTLE_MS = 1_500;

/** How long a source picked from its own Switch takes precedence over a
 *  contradicting write to the Television service's ActiveIdentifier.
 *
 *  A Home scene captures both, and the Home app fills the TV's input in from
 *  whatever it happened to be when the scene was created — so a scene built
 *  around a source switch routinely carries an unrelated leftover input as
 *  well. Both land in the same instant with no ordering guarantee, which made
 *  the winner a coin flip (issue #17). The switch is the deliberate half of
 *  the pair: a user adds it on purpose, where the input comes along by
 *  itself. Short enough that changing the input by hand moments after using a
 *  switch still works.
 *
 *  Measured from when the switch was recorded, but read after the coalescing
 *  wait below — so an input is in practice suppressed for SCENE_COALESCE_MS
 *  less than this. That shortens the window a deliberate pick has to clear,
 *  which is the harmless direction to err in. */
export const SWITCH_PRECEDENCE_MS = 1_500;

/** How long an ActiveIdentifier write waits before launching, in case the
 *  source switch from the same scene is still on its way.
 *
 *  The precedence rule above can only suppress a write it can compare against
 *  one already seen, so on its own it settled the scene conflict in exactly
 *  one arrival order. The Home app sends the two halves as separate writes
 *  milliseconds apart, and when the input arrived first it launched before the
 *  switch had been heard from: the TV ran two launches back to back and the
 *  first switch lit up in HomeKit only to go dark again when the second won
 *  (issue #17). Waiting a beat makes the outcome the same either way. Well
 *  under the gap between a real user's taps, and only ever waited when source
 *  switches exist for a scene to carry. */
export const SCENE_COALESCE_MS = 250;

// ============================================================================
// PACKAGES
// ============================================================================

/** Android launcher packages the TV reports as the current activity when it
 *  sits on the home screen — mapped to the "Home" input so the wheel and
 *  switches align after a wake from standby. Newer Philips models run the
 *  Google TV launcher (launcherx); the substring check in isLauncherPackage
 *  catches launcher variants that aren't listed here. */
export const LAUNCHER_PACKAGES: ReadonlySet<string> = new Set([
  'com.google.android.tvlauncher',
  'com.google.android.leanbacklauncher',
  'com.google.android.apps.tv.launcherx',
]);

/** Package the TV reports while showing the tuner or an HDMI passthrough
 *  source. Ambiguous between Watch TV and HDMI 1-4, so it confirms the current
 *  input when that is already a source, and falls back to Watch TV otherwise. */
export const PLAYTV_PACKAGE = 'org.droidtv.playtv';

/** System packages (other than launchers and the tuner) that are never useful
 *  as an input. */
export const SYSTEM_PACKAGES: ReadonlySet<string> = new Set([
  'com.android.vending',
  'com.android.tv.settings',
  'com.google.android.katniss',
  'com.google.android.tvrecommendations',
  'org.droidtv.eum',
  'org.droidtv.contentexplorer',
]);

/** System/launcher packages to exclude from auto-discovered apps */
export const EXCLUDED_PACKAGES: ReadonlySet<string> = new Set([
  ...LAUNCHER_PACKAGES,
  PLAYTV_PACKAGE,
  ...SYSTEM_PACKAGES,
]);

/** The TV's report for "no trackable app in the foreground". */
export const NO_APP_REPORT = 'NA';

/** True for any Android home-screen launcher the TV may report. */
export function isLauncherPackage(app: string): boolean {
  return LAUNCHER_PACKAGES.has(app) || app.toLowerCase().includes('launcher');
}

/** The TV's channel-list activity — like the tuner, not a user app. */
export const CHANNELS_PACKAGE = 'org.droidtv.channels';

/**
 * True when `pkg` is one of the TV's own foreground activities (home screen,
 * live TV, channel list, system apps) rather than an app a user would add as
 * an input. Shared with the settings UI's "Detect current app".
 */
export function isSystemForegroundPackage(pkg: string): boolean {
  return isLauncherPackage(pkg) || EXCLUDED_PACKAGES.has(pkg) || pkg === CHANNELS_PACKAGE;
}

// ============================================================================
// HOMEKIT
// ============================================================================

/** TLV8 tags for DisplayOrder encoding */
export const TLV_ELEMENT_START = 0x01;
export const TLV_ELEMENT_END = 0x00;

/**
 * Localized forms of HomeKit's generic "Input"/"Input Source" placeholder,
 * optionally followed by an index, that tvOS's HomeHub writes back into
 * ConfiguredName (homebridge/homebridge#3703). The Home app localizes this
 * placeholder, so an English-only match let a non-English controller silently
 * overwrite the real app label on the wheel (e.g. Spanish "Entrada 2"). We
 * ignore any write matching one of these so the friendly name survives.
 */
const GENERIC_INPUT_NAMES = [
  'input source', 'input', // English
  'entrada', // Spanish / Portuguese
  'entrée', 'entree', // French
  'eingang', // German
  'ingresso', // Italian
  'ingang', // Dutch
  'ingång', 'inngang', 'indgang', // Swedish / Norwegian / Danish
  'tulo', // Finnish
  'wejście', 'wejscie', // Polish
  'giriş', 'giris', // Turkish
  'вход', 'источник', // Russian
  '入力', '输入', '輸入', '입력', // Japanese / Chinese / Korean
];
export const GENERIC_INPUT_NAME_RE = new RegExp(`^(?:${GENERIC_INPUT_NAMES.join('|')})\\s*\\d*$`, 'iu');

/** HomeKit RemoteKey to Philips TV key mapping (base, without the configurable
 *  back / play-pause / info keys) */
export const HOMEKIT_TO_TV_KEY_BASE: Readonly<Record<number, RemoteKey>> = {
  0: 'Rewind',
  1: 'FastForward',
  2: 'Next',
  3: 'Previous',
  4: 'CursorUp',
  5: 'CursorDown',
  6: 'CursorLeft',
  7: 'CursorRight',
  8: 'Confirm',
  10: 'Home',
};
