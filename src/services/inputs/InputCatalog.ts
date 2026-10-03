import { HDMI_SOURCES, HOME_URI, WATCH_TV_URI } from '../../api/PhilipsTVClient.js';
import type { CustomAppConfig, InputConfig, SourceConfig, TVApplication } from '../../api/types.js';
import { EXCLUDED_PACKAGES, MAX_INPUT_SOURCES } from './constants.js';
import type { InputData, InputSourceConfig } from './types.js';

// ============================================================================
// STATIC SOURCES
// ============================================================================

/** Sources that are always present, in registration order: Watch TV, Home,
 *  HDMI 1-4. */
export const STATIC_INPUTS: readonly InputData[] = [
  { id: WATCH_TV_URI, name: 'Watch TV', type: 'source' },
  { id: HOME_URI, name: 'Home', type: 'source' },
  ...Object.entries(HDMI_SOURCES).map(([id, name]) => ({ id, name, type: 'source' as const })),
];

const STATIC_IDS: ReadonlySet<string> = new Set(STATIC_INPUTS.map(i => i.id));

/** Keep the first occurrence of every id. Two inputs sharing an id would share
 *  a cache entry and therefore a HomeKit subtype, so later duplicates are
 *  dropped wherever input lists are assembled. */
export function dedupeById<T extends { readonly id: string }>(inputs: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const input of inputs) {
    if (!byId.has(input.id)) {
      byId.set(input.id, input);
    }
  }
  return [...byId.values()];
}

/** Every package the TV reported, whether or not it becomes an input. */
export function reportedPackages(tvApps: readonly TVApplication[]): Set<string> {
  const packages = new Set<string>();
  for (const app of tvApps) {
    const pkg = app.intent?.component?.packageName;
    if (pkg) {
      packages.add(pkg);
    }
  }
  return packages;
}

// ============================================================================
// INPUT CATALOG
// ============================================================================

export interface InputCatalogOptions {
  readonly userInputs?: readonly InputConfig[];
  readonly customApps?: readonly CustomAppConfig[];
  /** Sources config (Homebridge UI) indexed by id. */
  readonly sourceConfigs: ReadonlyMap<string, SourceConfig>;
}

/**
 * Decides *which* inputs exist, independent of HomeKit: the static sources,
 * the user's explicit inputs[] or custom apps, cached and TV-discovered apps
 * and every source the user marked visible. Pure — no services, no I/O.
 */
export class InputCatalog {
  private readonly customAppInputs: readonly InputData[];
  private readonly customAppIds: ReadonlySet<string>;

  constructor(private readonly options: InputCatalogOptions) {
    this.customAppInputs = dedupeById(
      (options.customApps ?? [])
        .filter(a => a.packageName)
        .map(a => ({
          id: a.packageName,
          name: a.name || a.packageName,
          type: 'app' as const,
          className: a.className,
          action: a.action,
        })),
    );
    this.customAppIds = new Set(this.customAppInputs.map(a => a.id));
  }

  /** True when the user maintains an explicit inputs[] list (no discovery). */
  get hasUserInputs(): boolean {
    return (this.options.userInputs?.length ?? 0) > 0;
  }

  isStaticId(id: string): boolean {
    return STATIC_IDS.has(id);
  }

  /** True for app ids the user asked for explicitly — a custom app or a source
   *  marked visible — which must survive the TV no longer reporting them. */
  isUserRequested(id: string): boolean {
    return this.customAppIds.has(id) || this.options.sourceConfigs.get(id)?.visible === true;
  }

  /**
   * Every input to register at startup: the static sources followed by the
   * initial app inputs, de-duplicated by id (a static source always wins) and
   * capped at MAX_INPUT_SOURCES.
   *
   * App inputs are sorted so user-configured visible sources are registered
   * first within the cap — except for an explicit inputs[] list, whose order is
   * deliberate.
   */
  startupInputs(cachedConfigs: readonly InputSourceConfig[]): InputData[] {
    const apps = this.initialAppInputs(cachedConfigs);
    const ordered = this.hasUserInputs ? apps : this.sortBySourcePriority(apps);
    return dedupeById([...STATIC_INPUTS, ...ordered]).slice(0, MAX_INPUT_SOURCES);
  }

  /**
   * Turn a getApplications response into app inputs: drop entries without a
   * package and excluded system packages (unless the user marked them visible),
   * collapse apps with several launcher activities to one input per package,
   * and sort by name.
   */
  appsFromTV(tvApps: readonly TVApplication[]): InputData[] {
    const inputs: InputData[] = [];
    for (const app of tvApps) {
      const pkg = app.intent?.component?.packageName;
      if (!pkg) {
        continue;
      }
      // User intent wins: never drop a package the user has explicitly marked
      // visible in the sources config, even a system/launcher package.
      if (EXCLUDED_PACKAGES.has(pkg) && this.options.sourceConfigs.get(pkg)?.visible !== true) {
        continue;
      }
      inputs.push({ id: pkg, name: app.label || pkg, type: 'app' });
    }
    return dedupeById(inputs).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Sort inputs so user-configured visible sources come first, pushing
   * explicitly-hidden and unconfigured sources toward the end. This ensures
   * visible sources are never accidentally dropped when the list is truncated
   * at MAX_INPUT_SOURCES.
   *
   * Priority order: explicitly visible (0) → no config entry (1) → explicitly hidden (2).
   * Sort is stable — relative order within each priority group is preserved.
   */
  sortBySourcePriority<T extends { readonly id: string }>(inputs: readonly T[]): T[] {
    const priority = (id: string): number => {
      const config = this.options.sourceConfigs.get(id);
      return config === undefined ? 1 : config.visible === true ? 0 : 2;
    };
    return [...inputs].sort((a, b) => priority(a.id) - priority(b.id));
  }

  /**
   * Returns the initial set of app inputs for startup:
   * 1. If user configured inputs[] → use those (explicit list, self-managed)
   * 2. Else combine cached apps (previous TV fetch) + custom apps + every source
   *    the user marked visible in the sources config.
   *
   * Seeding from the visible sources config is what guarantees a selected source
   * always becomes an input even when the TV was asleep/slow at boot and hasn't
   * been discovered or cached yet — the app label is filled in later when the TV
   * is reachable.
   */
  private initialAppInputs(cachedConfigs: readonly InputSourceConfig[]): InputData[] {
    if (this.hasUserInputs) {
      const inputs = (this.options.userInputs ?? []).map(i => ({ id: i.identifier, name: i.name, type: i.type }));
      return this.mergeCustomApps(inputs);
    }

    const cachedApps = cachedConfigs
      .filter(c => c.type === 'app')
      .map(c => ({ id: c.id, name: c.name, type: c.type }));
    return this.mergeConfiguredVisibleSources(this.mergeCustomApps(cachedApps));
  }

  /**
   * Merge custom apps into a base app list. Custom apps win on id collision
   * (so their explicit launch intent overrides any cached/discovered entry)
   * and are placed first so they are never dropped by the MAX_INPUT_SOURCES cap.
   */
  private mergeCustomApps(base: readonly InputData[]): InputData[] {
    return dedupeById([...this.customAppInputs, ...base]);
  }

  /**
   * Append an app input for every source the user marked visible in the sources
   * config that isn't already present. Static sources (Watch TV / Home / HDMI)
   * are skipped — they're always registered as sources. This decouples the
   * user's visible selection from the TV's boot-time responsiveness.
   */
  private mergeConfiguredVisibleSources(base: readonly InputData[]): InputData[] {
    const extra: InputData[] = [];
    for (const cfg of this.options.sourceConfigs.values()) {
      if (cfg.visible !== true || STATIC_IDS.has(cfg.id)) {
        continue;
      }
      // Real label is unknown until the TV is reachable; the customName (if any)
      // takes over via resolveDisplayName, otherwise fall back to the id.
      extra.push({ id: cfg.id, name: cfg.customName ?? cfg.id, type: 'app' });
    }
    return dedupeById([...base, ...extra]);
  }
}
