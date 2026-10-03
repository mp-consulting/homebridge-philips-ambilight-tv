/**
 * Philips Ambilight TV Configuration Wizard — pure helpers.
 *
 * Loaded as a classic <script> before app.js and exposed as
 * `globalThis.AmbilightHelpers`. Kept free of DOM and Homebridge access so the
 * logic can be unit-tested in Node (tests import this file for its side effect
 * and read the global back).
 */

(() => {
  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  // ============================================================================
  // ESCAPING
  // ============================================================================

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
    '`': '&#96;',
  };

  /** Escape a value for interpolation into HTML text or a quoted attribute. */
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);

  // ============================================================================
  // VALIDATION / NORMALIZATION
  // ============================================================================

  const isValidIpv4 = (ip) => typeof ip === 'string' && IPV4_PATTERN.test(ip.trim());

  /**
   * Canonical MAC spelling (lowercase, colon-separated) — mirrors
   * normalizeMacAddress in src/api/utils.ts. Returns null when the input is
   * not a MAC address (accepts colon, hyphen or bare 12-hex-digit forms).
   */
  const normalizeMac = (mac) => {
    if (typeof mac !== 'string') {
      return null;
    }
    const hex = mac.trim().replace(/[:-]/g, '').toLowerCase();
    return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/.{2}/g).join(':') : null;
  };

  // ============================================================================
  // SOURCES
  // ============================================================================

  /** Append the TV's custom apps that the fetched list doesn't already contain. */
  const injectCustomApps = (sources, customApps) => {
    if (!Array.isArray(customApps) || customApps.length === 0) {
      return sources;
    }
    const existingIds = new Set(sources.map(s => s.id));
    const extra = customApps
      .filter(a => a.packageName && !existingIds.has(a.packageName))
      .map(a => ({ id: a.packageName, name: a.name || a.packageName, type: 'app', icon: 'app', custom: true }));
    return [...sources, ...extra];
  };

  /**
   * Merge fetched sources with the saved per-source config. Saved sources keep
   * their order; sources with no saved entry are appended after the highest
   * saved order (in fetched order) so they never collide with saved ones.
   */
  const mergeSourcesWithConfig = (fetchedSources, existingConfig) => {
    const config = Array.isArray(existingConfig) ? existingConfig : [];
    const configMap = new Map(config.map(s => [s.id, s]));
    const savedOrders = config.map(s => s.order).filter(o => typeof o === 'number' && Number.isFinite(o));
    let nextOrder = savedOrders.length ? Math.max(...savedOrders) + 1 : 0;

    const merged = fetchedSources.map((source) => {
      const existing = configMap.get(source.id);
      const hasOrder = typeof existing?.order === 'number' && Number.isFinite(existing.order);
      return {
        ...source,
        order: hasOrder ? existing.order : nextOrder++,
        visible: existing?.visible ?? true,
        customName: existing?.customName,
      };
    });

    // Array.prototype.sort is stable, so equal orders keep fetched order.
    merged.sort((a, b) => a.order - b.order);
    return merged;
  };

  /**
   * Reorder sources so visible ones follow `visibleIds`, then renumber orders
   * 0..n-1. Sources not in `visibleIds` (hidden ones) keep their relative order
   * and are placed first, matching the drag-and-drop behaviour.
   */
  const reorderVisible = (sources, visibleIds) => {
    const position = new Map(visibleIds.map((id, i) => [id, i]));
    const rank = (s) => (position.has(s.id) ? position.get(s.id) : -1);
    const sorted = [...sources].sort((a, b) => rank(a) - rank(b));
    return sorted.map((s, i) => ({ ...s, order: i }));
  };

  /**
   * Move one visible source up (delta < 0) or down (delta > 0) among the
   * visible sources. Returns null when the move is not possible.
   */
  const moveVisibleSource = (sources, id, delta) => {
    const visibleIds = sources.filter(s => s.visible !== false).map(s => s.id);
    const from = visibleIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visibleIds.length) {
      return null;
    }
    visibleIds.splice(from, 1);
    visibleIds.splice(to, 0, id);
    return reorderVisible(sources, visibleIds);
  };

  /** The subset of a source persisted to config. */
  const toSourceConfig = (sources) => sources.map(s => ({
    id: s.id,
    order: s.order,
    visible: s.visible,
    customName: s.customName,
  }));

  // ============================================================================
  // ASYNC UTILITIES
  // ============================================================================

  /**
   * Debounce a function, coalescing rapid calls into a single trailing
   * invocation. `.flush()` runs any pending call immediately.
   */
  const debounce = (fn, ms) => {
    let timer = null;
    const debounced = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    };
    debounced.flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        fn();
      }
    };
    return debounced;
  };

  /** Rejects with `message` if `promise` doesn't settle within `ms`. */
  const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

  // ============================================================================
  // EXPORT
  // ============================================================================

  globalThis.AmbilightHelpers = Object.freeze({
    escapeHtml,
    isValidIpv4,
    normalizeMac,
    injectCustomApps,
    mergeSourcesWithConfig,
    reorderVisible,
    moveVisibleSource,
    toSourceConfig,
    debounce,
    withTimeout,
  });
})();
