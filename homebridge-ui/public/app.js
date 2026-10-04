/**
 * Philips Ambilight TV Configuration Wizard
 * Handles device discovery, pairing, and configuration management
 */

(async () => {
  // Confirm theme from Homebridge settings (overrides the early OS-preference detection)
  try {
    const settings = await homebridge.getUserSettings();
    const scheme = settings.colorScheme;
    if (scheme === 'dark' || scheme === 'light') {
      document.documentElement.dataset.bsTheme = scheme;
    } else if (scheme === 'auto') {
      document.documentElement.dataset.bsTheme =
        window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    // getUserSettings not available in older versions — keep the early-detected theme
  }

  // ============================================================================
  // CONSTANTS & STATE
  // ============================================================================

  const SCREENS = ['wizardStep1', 'wizardStep2', 'wizardStep3', 'successScreen', 'editScreen', 'editSourcesScreen'];
  const PLATFORM_NAME = 'PhilipsAmbilightTV';
  const DISPLAY_NAME = 'Philips Ambilight TV';

  /** Keys accepted by the TV's /input/key endpoint — keep in sync with REMOTE_KEYS in src/api/types.ts. */
  const REMOTE_KEYS = [
    'Standby', 'Back', 'Find', 'RedColour', 'GreenColour', 'YellowColour', 'BlueColour', 'Home',
    'VolumeUp', 'VolumeDown', 'Mute', 'Options', 'Dot', 'Digit0', 'Digit1', 'Digit2',
    'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Info',
    'CursorUp', 'CursorDown', 'CursorLeft', 'CursorRight', 'Confirm', 'Next', 'Previous', 'Adjust',
    'WatchTV', 'Viewmode', 'Teletext', 'Subtitle', 'ChannelStepUp', 'ChannelStepDown', 'Source', 'AmbilightOnOff',
    'PlayPause', 'Pause', 'FastForward', 'Stop', 'Rewind', 'Record', 'Online',
  ];

  const {
    escapeHtml,
    normalizeMac,
    isValidIpv4,
    injectCustomApps,
    mergeSourcesWithConfig,
    reorderVisible,
    moveVisibleSource,
    toSourceConfig,
    debounce,
    withTimeout,
    scrubAddresses,
    assistantTv,
    tvProblem,
  } = window.AmbilightHelpers;

  /** Client-side ceiling on mDNS discovery (server scans for ~5s). */
  const DISCOVER_TIMEOUT_MS = 15000;
  /** State sensor keys, in display order, with the checkbox id suffix for each. */
  const STATE_SENSORS = [['power', 'SensorPower'], ['ambilight', 'SensorAmbilight'], ['mute', 'SensorMute']];

  const state = {
    currentConfig: { name: '', ip: '', mac: '', username: '', password: '' },
    configuredTvs: [],
    editingTvIndex: null,
    editingSourcesTvIndex: null,
    /** Index of the TV being re-paired in place, or null for a new pairing. */
    repairingTvIndex: null,
    sources: [],
    draggedItem: null,
    /** True while a device row's /pair request is in flight. */
    pairingInFlight: false,
  };

  // ============================================================================
  // DOM HELPERS
  // ============================================================================

  const $ = (id) => document.getElementById(id);

  const setButtonLoading = (btn, loading, loadingText = 'Loading...', originalContent = null) => {
    if (loading) {
      btn.dataset.originalContent = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> ${loadingText}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = originalContent || btn.dataset.originalContent;
    }
  };

  /** Render an alert. `message` is untrusted, so it is set as text, never HTML. */
  const showAlert = (container, type, message) => {
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    container.replaceChildren(alert);
  };

  // ============================================================================
  // ASSISTANT (Homebridge AI Kit)
  // ============================================================================
  // Shown only when the shared HomebridgeAiKit platform is set up and enabled
  // (checked at initialization). Errors go out with IP and MAC addresses
  // scrubbed; TVs only as the assistantTv() whitelist.

  let assistantEnabled = false;

  /** Plugin facts the Assistant may see, as one sentence (no addresses or credentials). */
  const assistantContext = (extra) => [
    extra,
    `Configured TVs: ${state.configuredTvs.length}.`,
  ].filter(Boolean).join(' ');

  /** Streams an explanation of `error` into `answerEl`. */
  const explainWithAssistant = async (button, answerEl, { error, context, device, title }) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    answerEl.style.display = '';
    const answer = MpKit.ai.renderAnswer(answerEl, { title });
    try {
      const res = await MpKit.ai.explain({ error: scrubAddresses(error), context, device }, { onChunk: answer.append });
      answer.done(res);
    } catch (e) {
      answer.error(e);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };

  /** Renders an "Explain" button plus an answer panel into `container` (nothing when the Assistant is off). */
  const renderExplain = (container, { error, context, device, title }) => {
    container.replaceChildren();
    if (!assistantEnabled) {
      return;
    }
    container.innerHTML = `
      ${MpKit.ai.renderButton({ label: 'Explain', size: 'sm', className: 'js-explain' })}
      <div class="assistant-answer mt-2" style="display: none;"></div>
    `;
    const button = container.querySelector('.js-explain');
    const answerEl = container.querySelector('.assistant-answer');
    button.addEventListener('click', () => explainWithAssistant(button, answerEl, {
      error,
      context: assistantContext(context),
      device,
      title,
    }));
  };

  /**
   * Shows an error in `containerId` with an "Explain" button when the Assistant
   * is on. Callers keep their toast; without the Assistant this stays hidden so
   * the wizard looks as before.
   */
  const showProblem = (containerId, { message, context, device, title }) => {
    const container = $(containerId);
    if (!assistantEnabled) {
      return;
    }
    container.style.display = '';
    container.innerHTML = `
      <div class="alert alert-danger mb-0">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="problem-message"><i class="bi bi-exclamation-triangle me-1"></i></div>
          <div class="problem-action flex-shrink-0"></div>
        </div>
      </div>
    `;
    // `message` may quote TV-supplied text: set as text, never HTML
    container.querySelector('.problem-message').append(String(message));
    const action = container.querySelector('.problem-action');
    action.innerHTML = MpKit.ai.renderButton({ label: 'Explain', size: 'sm', className: 'js-explain' });
    const answerEl = document.createElement('div');
    answerEl.className = 'assistant-answer mt-2';
    answerEl.style.display = 'none';
    container.appendChild(answerEl);
    const button = action.querySelector('.js-explain');
    button.addEventListener('click', () => explainWithAssistant(button, answerEl, {
      error: message,
      context: assistantContext(context),
      device,
      title,
    }));
  };

  const clearProblem = (containerId) => {
    $(containerId).style.display = 'none';
    $(containerId).replaceChildren();
  };

  // ============================================================================
  // NAVIGATION
  // ============================================================================

  const COMPACT_SCREENS = new Set(['editScreen', 'editSourcesScreen']);

  const showScreen = (screenId) => {
    SCREENS.forEach((id) => {
      $(id).style.display = id === screenId ? 'block' : 'none';
    });
    const header = document.querySelector('.mp-header');
    if (header) {
      header.style.display = COMPACT_SCREENS.has(screenId) ? 'none' : '';
    }
    if (screenId === 'successScreen') {
      renderConfiguredTvs();
    }
  };

  // ============================================================================
  // UTILITIES
  // ============================================================================

  const getDeviceIp = (device) => device.host || device.addresses[0];

  const resetCurrentConfig = () => {
    state.currentConfig = { name: '', ip: '', mac: '', username: '', password: '' };
    state.repairingTvIndex = null;
  };

  const getPinValue = () => {
    const digits = document.querySelectorAll('.pin-digit');
    return Array.from(digits).map(d => d.value).join('');
  };

  const clearPinInputs = () => {
    const digits = document.querySelectorAll('.pin-digit');
    digits.forEach(d => d.value = '');
  };

  const focusFirstPinInput = () => {
    const first = document.querySelector('.pin-digit');
    if (first) {
      first.focus();
    }
  };

  // ============================================================================
  // API HELPERS
  // ============================================================================

  const api = {
    discover: () => withTimeout(
      homebridge.request('/discover'),
      DISCOVER_TIMEOUT_MS,
      'Timed out searching for TVs. Check that the TV is on and on the same network, then try again.',
    ),
    pair: (ip, deviceName) => homebridge.request('/pair', { ip, deviceName }),
    pairGrant: (ip, pin) => homebridge.request('/pair-grant', { ip, pin }),
    getMac: (ip) => homebridge.request('/get-mac', ip),
    wakeOnLan: (mac, ip) => homebridge.request('/wake-on-lan', { mac, ip }),
    // The TV's pinned certificate travels with its credentials so these
    // connections are verified like the plugin's own.
    getSources: (tv) => homebridge.request('/get-sources', {
      ip: tv.ip, username: tv.username, password: tv.password, mac: tv.mac, certFingerprint: tv.certFingerprint,
    }),
    currentApp: (tv) => homebridge.request('/current-app', {
      ip: tv.ip, username: tv.username, password: tv.password, mac: tv.mac, certFingerprint: tv.certFingerprint,
    }),
  };

  // ============================================================================
  // CONFIG MANAGEMENT
  // ============================================================================

  /** Push the current config to Config UI X in memory only (no disk write, no
   *  settings-view re-render). Cheap and safe to call on every keystroke/toggle. */
  const pushPluginConfig = async () => {
    const existing = (await homebridge.getPluginConfig())[0] || {};
    await homebridge.updatePluginConfig([{
      platform: PLATFORM_NAME,
      name: existing.name || DISPLAY_NAME,
      devices: state.configuredTvs,
    }]);
  };

  const saveConfig = async () => {
    await pushPluginConfig();
    await homebridge.savePluginConfig();
  };

  /**
   * Persist the sources config to disk, debounced. Saving on every show/hide
   * toggle or drag calls savePluginConfig() repeatedly, and each disk-save
   * re-renders the Config UI X settings view — which can invalidate the plugin
   * iframe and make Config UI X drop in-flight /get-sources responses (the
   * "Timed out fetching sources" hang, issue #14). Debouncing the disk write
   * keeps the churn to a single save after the user stops fiddling.
   */
  const flushSourcesSave = debounce(() => {
    homebridge.savePluginConfig().catch(() => homebridge.toast.error('Failed to save source configuration'));
  }, 1000);

  const addTv = async () => {
    state.configuredTvs.push({ ...state.currentConfig });
    await saveConfig();
  };

  const updateTv = async (index, updates) => {
    state.configuredTvs[index] = { ...state.configuredTvs[index], ...updates };
    await saveConfig();
  };

  const deleteTv = async (index) => {
    state.configuredTvs.splice(index, 1);
    await saveConfig();
    homebridge.toast.success('TV removed successfully');
    showScreen(state.configuredTvs.length ? 'successScreen' : 'wizardStep1');
  };

  // ============================================================================
  // UI COMPONENTS
  // ============================================================================

  const createTvListItem = (tv, index) => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.dataset.tvIndex = String(index);
    const problem = assistantEnabled ? tvProblem(tv) : null;
    const explainButton = problem
      ? MpKit.ai.renderButton({ label: 'Explain', size: 'sm', className: 'js-explain-tv me-2', title: 'Explain this TV problem' })
      : '';
    li.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1"><i class="bi bi-tv me-2" aria-hidden="true"></i> ${escapeHtml(tv.name)}</h6>
          <small class="text-muted"><i class="bi bi-hdd-network me-1" aria-hidden="true"></i> ${escapeHtml(tv.ip)}</small>
        </div>
        <div>
          ${explainButton}
          <button type="button" class="btn btn-sm btn-secondary edit-sources-btn me-2"><i class="bi bi-list" aria-hidden="true"></i> Sources</button>
          <button type="button" class="btn btn-sm btn-primary edit-tv-btn me-2"><i class="bi bi-pencil" aria-hidden="true"></i> Edit</button>
          <button type="button" class="btn btn-sm btn-danger delete-tv-btn"><i class="bi bi-trash" aria-hidden="true"></i> Delete</button>
        </div>
      </div>
      <div class="assistant-answer mt-2" style="display: none;"></div>
    `;

    li.querySelector('.edit-sources-btn').addEventListener('click', () => openEditSourcesScreen(index));
    li.querySelector('.edit-tv-btn').addEventListener('click', () => openEditScreen(index));
    li.querySelector('.delete-tv-btn').addEventListener('click', async function () {
      if (!window.confirm(`Remove "${tv.name || tv.ip}" from Homebridge? This cannot be undone.`)) {
        return;
      }
      setButtonLoading(this, true, 'Deleting...');
      try {
        await deleteTv(index);
      } catch (e) {
        setButtonLoading(this, false, null, '<i class="bi bi-trash"></i> Delete');
        homebridge.toast.error('Failed to delete TV: ' + e.message);
      }
    });

    return li;
  };

  const renderConfiguredTvs = () => {
    const container = $('configuredTvList');
    const noTvsMessage = $('noTvsMessage');

    if (!state.configuredTvs.length) {
      noTvsMessage.style.display = 'block';
      container.style.display = 'none';
      return;
    }

    noTvsMessage.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '';
    state.configuredTvs.forEach((tv, i) => container.appendChild(createTvListItem(tv, i)));
  };

  // ============================================================================
  // DISCOVERY & PAIRING
  // ============================================================================

  const setupWolButtons = (listItem) => {
    const wolBtn = listItem.querySelector('.wol-btn');
    const retryBtn = listItem.querySelector('.wol-retry-btn');

    wolBtn.onclick = async () => {
      if (!state.currentConfig.mac) {
        homebridge.toast.error('No MAC address available for this TV');
        return;
      }
      setButtonLoading(wolBtn, true, 'Sending...');
      try {
        const result = await api.wakeOnLan(state.currentConfig.mac, state.currentConfig.ip);
        if (result.success) {
          homebridge.toast.success('Wake-on-LAN packet sent! Wait a few seconds for the TV to wake up.');
        } else {
          homebridge.toast.error(result.error);
        }
      } catch (e) {
        homebridge.toast.error('Failed: ' + e.message);
      } finally {
        setButtonLoading(wolBtn, false);
      }
    };

    retryBtn.onclick = async () => {
      setButtonLoading(retryBtn, true, 'Retrying...');
      const collapse = listItem.querySelector('.wol-collapse');
      if (collapse) {
        collapse.style.display = 'none';
      }
      try {
        await startPairing(state.currentConfig.ip, listItem);
      } finally {
        setButtonLoading(retryBtn, false);
      }
    };
  };

  const showWolCollapse = (listItem) => {
    const collapse = listItem?.querySelector('.wol-collapse');
    if (collapse) {
      collapse.style.display = 'block';
      setupWolButtons(listItem);
    }
  };

  const selectDevice = async (device, listItem) => {
    const ip = getDeviceIp(device);
    state.currentConfig.ip = ip;
    state.currentConfig.name = device.name || 'Philips TV';
    // Never carry a previously-selected TV's MAC over to this one.
    state.currentConfig.mac = '';

    // Get MAC address first (needed for WOL)
    try {
      const result = await api.getMac(ip);
      if (result.success) {
        state.currentConfig.mac = result.mac;
      }
    } catch (e) { /* MAC is optional */ }

    await startPairing(ip, listItem);
  };

  /** Starts the PIN flow for `ip`. Resolves true once the TV shows a PIN. */
  const startPairing = async (ip, listItem, problemId = 'pairingProblem') => {
    // Show loading state on the list item
    const badge = listItem?.querySelector('.select-badge');
    const originalBadgeText = badge?.textContent;
    if (badge) {
      badge.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Connecting...';
      badge.classList.remove('bg-primary');
      badge.classList.add('bg-secondary');
    }

    homebridge.toast.info('Initiating pairing with TV...');
    clearProblem(problemId);
    const pairingContext = 'Requesting a pairing PIN from the TV (POST /pair/request on HTTPS port 1926) failed in the plugin settings.';

    try {
      const result = await api.pair(ip, state.currentConfig.name);

      if (result.success) {
        // Only show Step 2 after pairing request succeeds
        showScreen('wizardStep2');

        const pinSection = $('pinInputSection');
        const submitBtn = $('submitPinBtn');

        clearPinInputs();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm PIN';

        homebridge.toast.success('Check your TV for the PIN code');
        pinSection.style.display = 'block';
        setTimeout(() => focusFirstPinInput(), 100);
        return true;
      }

      homebridge.toast.error(result.error);
      showProblem(problemId, { message: result.error, context: pairingContext, title: 'Why did pairing fail?' });
      // Restore badge
      if (badge) {
        badge.textContent = originalBadgeText;
        badge.classList.remove('bg-secondary');
        badge.classList.add('bg-primary');
      }
      if (state.currentConfig.mac && listItem) {
        showWolCollapse(listItem);
      }
      return false;
    } catch (e) {
      homebridge.toast.error(e.message);
      showProblem(problemId, { message: e.message, context: pairingContext, title: 'Why did pairing fail?' });
      // Restore badge
      if (badge) {
        badge.textContent = originalBadgeText;
        badge.classList.remove('bg-secondary');
        badge.classList.add('bg-primary');
      }
      if (state.currentConfig.mac && listItem) {
        showWolCollapse(listItem);
      }
      return false;
    }
  };

  const createDeviceListItem = (device) => {
    const ip = getDeviceIp(device);
    const li = document.createElement('li');
    li.className = 'list-group-item list-group-item-action';
    li.dataset.ip = ip;
    li.innerHTML = `
      <div class="device-row" style="cursor: pointer;">
        <div class="d-flex w-100 justify-content-between align-items-center">
          <div>
            <h6 class="mb-1"><i class="bi bi-tv me-2" aria-hidden="true"></i> ${escapeHtml(device.name || 'Unknown Device')}</h6>
            <small class="text-muted"><i class="bi bi-hdd-network me-1" aria-hidden="true"></i> ${escapeHtml(ip)}</small>
          </div>
          <span class="badge bg-primary rounded-pill select-badge">Select</span>
        </div>
      </div>
      <div class="wol-collapse mt-2" style="display: none;">
        <div class="alert alert-warning mb-0">
          <h6 class="alert-heading mb-1"><i class="bi bi-power"></i> TV not responding</h6>
          <p class="mb-2 small">The TV may be in standby mode.</p>
          <button class="btn btn-warning btn-sm wol-btn" type="button">
            <i class="bi bi-lightning-charge"></i> Wake TV
          </button>
          <button class="btn btn-secondary btn-sm wol-retry-btn" type="button">
            <i class="bi bi-arrow-clockwise"></i> Retry
          </button>
        </div>
      </div>
    `;

    li.querySelector('.device-row').addEventListener('click', async (e) => {
      e.preventDefault();
      // A double-click must not start two pairing requests (the second would
      // replace the TV's PIN and the first session's auth key).
      if (state.pairingInFlight) {
        return;
      }
      state.pairingInFlight = true;
      try {
        await selectDevice(device, li);
      } finally {
        state.pairingInFlight = false;
      }
    });

    return li;
  };

  /** Pairing succeeded but the TV's certificate could not be recorded. */
  const warnIfUnpinned = (result) => {
    if (result.certWarning) {
      homebridge.toast.warning('Paired, but the TV certificate could not be recorded — connections to this TV will not be verified. Re-pair later to enable verification.');
    }
  };

  const handlePinSubmit = async () => {
    const pin = getPinValue();
    if (!pin || pin.length !== 4) {
      homebridge.toast.error('Please enter a 4-digit PIN');
      return;
    }

    const btn = $('submitPinBtn');

    setButtonLoading(btn, true, 'Verifying...');
    clearProblem('pinProblem');
    const pinContext = 'Confirming the 4-digit PIN shown on the TV (POST /pair/grant with Digest authentication) failed in the plugin settings.';

    try {
      const result = await api.pairGrant(state.currentConfig.ip, pin);

      if (result.success && state.repairingTvIndex !== null) {
        // Re-pairing an existing TV: swap in the new credentials (and the
        // certificate they were negotiated against) and leave the rest of the
        // entry — name, sources, switches, custom apps — exactly as it was.
        const index = state.repairingTvIndex;
        state.repairingTvIndex = null;
        const updates = { username: result.username, password: result.password };
        if (result.certFingerprint) {
          updates.certFingerprint = result.certFingerprint;
        }
        await updateTv(index, updates);
        homebridge.toast.success('TV re-paired. Restart Homebridge to use the new credentials.');
        warnIfUnpinned(result);
        showScreen('successScreen');
        return;
      }

      if (result.success) {
        state.currentConfig.username = result.username;
        state.currentConfig.password = result.password;
        // Pin the certificate we just paired against, so later connections can
        // verify they are still talking to this TV.
        if (result.certFingerprint) {
          state.currentConfig.certFingerprint = result.certFingerprint;
        } else {
          delete state.currentConfig.certFingerprint;
        }
        showConfirmScreen();
        $('confirmCertWarning').style.display = result.certWarning ? 'block' : 'none';
        warnIfUnpinned(result);
      } else {
        homebridge.toast.error(result.error);
        showProblem('pinProblem', { message: result.error, context: pinContext, title: 'Why was the PIN not accepted?' });
        setButtonLoading(btn, false, null, 'Confirm PIN');
        clearPinInputs();
        focusFirstPinInput();
      }
    } catch (e) {
      homebridge.toast.error(e.message);
      showProblem('pinProblem', { message: e.message, context: pinContext, title: 'Why was the PIN not accepted?' });
      setButtonLoading(btn, false, null, 'Confirm PIN');
      clearPinInputs();
      focusFirstPinInput();
    }
  };

  // ============================================================================
  // EDIT SCREEN
  // ============================================================================

  // ============================================================================
  // SHARED TV FORM (confirm + edit screens use the same field ids, prefixed)
  // ============================================================================

  /** Populate the `${prefix}…` form fields from a TV config entry. */
  const fillTvForm = (prefix, tv) => {
    const f = (suffix) => $(prefix + suffix);
    f('TvName').value = tv.name || '';
    f('TvIp').value = tv.ip || '';
    f('TvMac').value = tv.mac || '';
    f('TvMac').setCustomValidity('');
    f('AmbilightMode').value = tv.ambilightMode || 'FOLLOW_VIDEO/NATURAL';
    f('AmbilightOnStart').checked = tv.ambilightOnStart || false;
    f('InfoButtonKey').value = tv.infoButtonKey || 'Source';
    f('BackButtonKey').value = tv.backButtonKey || 'Back';
    f('PlayPauseButtonKey').value = tv.playPauseButtonKey || 'PlayPause';
    f('SourceSwitches').checked = tv.sourceSwitches || false;
    f('AmbilightHueSwitch').checked = tv.ambilightHueSwitch || false;
    const sensors = tv.stateSensors || [];
    STATE_SENSORS.forEach(([key, suffix]) => {
      f(suffix).checked = sensors.includes(key);
    });
  };

  /**
   * Canonicalize the MAC field in place (so `aa-bb-…`/uppercase pass the
   * schema-matching pattern) and flag it invalid when it isn't a MAC.
   */
  const normalizeMacInput = (input) => {
    const mac = normalizeMac(input.value);
    if (mac) {
      input.value = mac;
    }
    input.setCustomValidity(mac ? '' : 'Please provide a valid MAC address.');
    return mac;
  };

  /** Read the `${prefix}…` form fields into a partial TV config entry. */
  const readTvForm = (prefix) => {
    const f = (suffix) => $(prefix + suffix);
    return {
      name: f('TvName').value.trim(),
      ip: f('TvIp').value.trim(),
      mac: normalizeMac(f('TvMac').value) || '',
      ambilightMode: f('AmbilightMode').value,
      ambilightOnStart: f('AmbilightOnStart').checked,
      infoButtonKey: f('InfoButtonKey').value,
      backButtonKey: f('BackButtonKey').value,
      playPauseButtonKey: f('PlayPauseButtonKey').value,
      sourceSwitches: f('SourceSwitches').checked,
      ambilightHueSwitch: f('AmbilightHueSwitch').checked,
      stateSensors: STATE_SENSORS.filter(([, suffix]) => f(suffix).checked).map(([key]) => key),
    };
  };

  /** Normalize + validate a TV form; returns true when it may be saved. */
  const validateTvForm = (form, prefix) => {
    normalizeMacInput($(prefix + 'TvMac'));
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return false;
    }
    return true;
  };

  const openEditScreen = (index) => {
    state.editingTvIndex = index;
    const tv = state.configuredTvs[index];
    fillTvForm('edit', tv);
    $('editTvForm').classList.remove('was-validated');
    // Custom apps — work on a copy until the form is saved
    state.editCustomApps = Array.isArray(tv.customApps) ? tv.customApps.map(a => ({ ...a })) : [];
    clearCustomAppInputs();
    renderCustomApps();
    // Custom buttons — same copy-until-saved approach
    state.editCustomButtons = Array.isArray(tv.customButtons) ? tv.customButtons.map(b => ({ ...b })) : [];
    $('customButtonName').value = '';
    renderCustomButtons();
    // Reset to General tab
    const generalTab = $('editGeneralTab');
    if (generalTab) {
      new bootstrap.Tab(generalTab).show();
    }
    showScreen('editScreen');
  };

  /**
   * Re-run pairing for a TV that is already configured. The TV issues a fresh
   * username/password — and, since certificate pinning was added, lets the
   * fingerprint be recorded — so this is what turns verification on for an
   * existing setup. Everything else about the entry survives, which is why
   * re-pairing no longer means deleting the TV and adding it back.
   */
  const startRepair = async (btn) => {
    const index = state.editingTvIndex;
    const tv = state.configuredTvs[index];
    if (!tv) {
      return;
    }

    state.repairingTvIndex = index;
    state.currentConfig = { ...tv };

    setButtonLoading(btn, true, 'Pairing...');
    try {
      if (!await startPairing(tv.ip, null, 'repairProblem')) {
        // The TV never got as far as showing a PIN — nothing to apply.
        state.repairingTvIndex = null;
      }
    } finally {
      setButtonLoading(btn, false, null, '<i class="bi bi-shield-lock"></i> Re-pair');
    }
  };

  // ============================================================================
  // CUSTOM APPS
  // ============================================================================

  const clearCustomAppInputs = () => {
    $('customAppName').value = '';
    $('customAppPackage').value = '';
    $('customAppClassName').value = '';
    $('customAppAction').value = '';
    $('customAppDetectInfo').textContent = '';
  };

  const renderCustomApps = () => {
    const list = $('editCustomAppsList');
    const apps = state.editCustomApps || [];
    list.innerHTML = '';
    if (apps.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'list-group-item text-muted small';
      empty.textContent = 'No custom apps yet.';
      list.appendChild(empty);
      return;
    }
    apps.forEach((app, i) => {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex justify-content-between align-items-center';
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.textContent = app.name;
      const sub = document.createElement('small');
      sub.className = 'text-muted';
      sub.textContent = app.className ? `${app.packageName} · ${app.className}` : app.packageName;
      info.appendChild(title);
      info.appendChild(sub);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-sm btn-outline-danger';
      remove.innerHTML = '<i class="bi bi-trash" aria-hidden="true"></i>';
      remove.setAttribute('aria-label', `Remove ${app.name}`);
      remove.addEventListener('click', () => {
        state.editCustomApps.splice(i, 1);
        renderCustomApps();
      });
      li.appendChild(info);
      li.appendChild(remove);
      list.appendChild(li);
    });
  };

  const addCustomApp = () => {
    const name = $('customAppName').value.trim();
    const packageName = $('customAppPackage').value.trim();
    if (!packageName) {
      homebridge.toast.error('Package name is required');
      return;
    }
    const app = { name: name || packageName, packageName };
    const className = $('customAppClassName').value.trim();
    const action = $('customAppAction').value.trim();
    if (className) {
      app.className = className;
    }
    if (action) {
      app.action = action;
    }
    if (!state.editCustomApps) {
      state.editCustomApps = [];
    }
    const existing = state.editCustomApps.findIndex(a => a.packageName === packageName);
    if (existing >= 0) {
      state.editCustomApps[existing] = app; // update in place
    } else {
      state.editCustomApps.push(app);
    }
    clearCustomAppInputs();
    renderCustomApps();
  };

  // ============================================================================
  // CUSTOM BUTTONS
  // ============================================================================

  const renderCustomButtons = () => {
    const list = $('editCustomButtonsList');
    const buttons = state.editCustomButtons || [];
    list.innerHTML = '';
    if (buttons.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'list-group-item text-muted small';
      empty.textContent = 'No custom buttons yet.';
      list.appendChild(empty);
    }
    buttons.forEach((button, i) => {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex justify-content-between align-items-center';
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.textContent = button.name;
      const sub = document.createElement('small');
      sub.className = 'text-muted';
      sub.textContent = `Sends ${button.key}`;
      info.appendChild(title);
      info.appendChild(sub);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-sm btn-outline-danger';
      remove.innerHTML = '<i class="bi bi-trash" aria-hidden="true"></i>';
      remove.setAttribute('aria-label', `Remove ${button.name}`);
      remove.addEventListener('click', () => {
        state.editCustomButtons.splice(i, 1);
        renderCustomButtons();
      });
      li.appendChild(info);
      li.appendChild(remove);
      list.appendChild(li);
    });

    // Only offer keys not already taken by another button
    const used = new Set(buttons.map(b => b.key));
    const select = $('customButtonKey');
    select.innerHTML = '';
    REMOTE_KEYS.filter(k => !used.has(k)).forEach(k => {
      const option = document.createElement('option');
      option.value = k;
      option.textContent = k;
      select.appendChild(option);
    });
    select.value = used.has('Stop') ? select.options[0]?.value : 'Stop';
  };

  const addCustomButton = () => {
    const key = $('customButtonKey').value;
    if (!key) {
      homebridge.toast.error('Remote key is required');
      return;
    }
    const name = $('customButtonName').value.trim() || key;
    if (!state.editCustomButtons) {
      state.editCustomButtons = [];
    }
    state.editCustomButtons.push({ name, key });
    $('customButtonName').value = '';
    renderCustomButtons();
  };

  const detectCurrentApp = async () => {
    const tv = state.configuredTvs[state.editingTvIndex] || {};
    const ip = $('editTvIp').value.trim() || tv.ip;
    const mac = normalizeMac($('editTvMac').value) || tv.mac;
    if (!ip) {
      homebridge.toast.error('TV IP address is required');
      return;
    }
    const btn = $('detectCurrentAppBtn');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Detecting...';
    clearProblem('detectProblem');
    const detectProblem = (message) => showProblem('detectProblem', {
      message,
      context: 'Detecting the app open on the TV (GET /activities/current) to add it as a custom app failed in the plugin settings.',
      device: assistantTv(tv),
      title: 'Why was no app detected?',
    });
    try {
      const res = await api.currentApp({ ...tv, ip, mac });
      if (res && res.success && res.app) {
        const { packageName, className, action } = res.app;
        $('customAppPackage').value = packageName || '';
        $('customAppClassName').value = className || '';
        $('customAppAction').value = action || '';
        if (!$('customAppName').value.trim()) {
          // Best-effort friendly name from the package's last segment
          const guess = (packageName || '').split('.').filter(Boolean).pop() || '';
          $('customAppName').value = guess.charAt(0).toUpperCase() + guess.slice(1);
        }
        $('customAppDetectInfo').textContent = `Detected ${packageName}${className ? ' · ' + className : ''}. Review the name, then click Add.`;
      } else if (res && res.notAnApp) {
        // Foreground is live TV / home — the wanted app isn't open yet
        homebridge.toast.error('Open the app on the TV first');
        $('customAppDetectInfo').textContent = res.error;
      } else {
        homebridge.toast.error((res && res.error) || 'No app detected');
        $('customAppDetectInfo').textContent = '';
        detectProblem((res && res.error) || 'No app detected');
      }
    } catch (e) {
      homebridge.toast.error('Detection failed: ' + e.message);
      detectProblem('Detection failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!validateTvForm(form, 'edit')) {
      return;
    }

    try {
      await updateTv(state.editingTvIndex, {
        ...readTvForm('edit'),
        customApps: state.editCustomApps || [],
        customButtons: state.editCustomButtons || [],
      });
      homebridge.toast.success('TV configuration updated');
      form.classList.remove('was-validated');
      showScreen('successScreen');
    } catch (e) {
      homebridge.toast.error('Failed to save: ' + e.message);
    }
  };

  const handleGetMac = async (btn, ipInputId, macInputId) => {
    const ip = $(ipInputId).value.trim();
    if (!isValidIpv4(ip)) {
      homebridge.toast.error('Please enter a valid IPv4 address first');
      return;
    }

    setButtonLoading(btn, true, 'Getting...');

    try {
      const result = await api.getMac(ip);
      if (result.success) {
        $(macInputId).value = normalizeMac(result.mac) || result.mac;
        $(macInputId).setCustomValidity('');
        homebridge.toast.success('MAC address retrieved');
      } else {
        homebridge.toast.error('Failed: ' + result.error);
      }
    } catch (e) {
      homebridge.toast.error('Failed: ' + e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  };

  // ============================================================================
  // CONFIRM SCREEN (Step 3)
  // ============================================================================

  const showConfirmScreen = () => {
    fillTvForm('confirm', { ...state.currentConfig, name: state.currentConfig.name || 'Philips TV' });
    $('confirmTvForm').classList.remove('was-validated');
    showScreen('wizardStep3');
    $('confirmTvName').focus();
    $('confirmTvName').select();
  };

  const handleConfirmSubmit = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!validateTvForm(form, 'confirm')) {
      return;
    }

    // The IP field is read-only here; keep the discovered value authoritative.
    const fields = readTvForm('confirm');
    delete fields.ip;
    Object.assign(state.currentConfig, fields);

    try {
      await addTv();
      homebridge.toast.success('TV saved! Configure which sources to show in HomeKit.');
      form.classList.remove('was-validated');
      // Go directly to the sources screen so the user can configure visibility
      // before adding the accessory to HomeKit. The "Done" button exits to the
      // success screen as usual.
      openEditSourcesScreen(state.configuredTvs.length - 1);
    } catch (e) {
      homebridge.toast.error('Failed to save: ' + e.message);
    }
  };

  // ============================================================================
  // EDIT SOURCES SCREEN
  // ============================================================================

  // Persisted cache of each TV's fetched source list. Stored in localStorage
  // (not just an in-memory variable) so it survives closing and reopening the
  // plugin config modal — which reloads this iframe and would otherwise wipe an
  // in-memory cache. Reopening then renders from the cache instead of issuing
  // another /get-sources request, whose response Config UI X drops after a modal
  // reopen (it postMessages to the destroyed iframe, contentWindow === null),
  // hanging the screen (#14). "Refresh from TV" forces a genuine re-fetch.
  const SOURCES_CACHE_PREFIX = 'philips-tv-sources:';
  const SOURCES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const sourcesCacheKey = (tv) => SOURCES_CACHE_PREFIX + (tv.mac || tv.ip);

  const readSourcesCache = (tv) => {
    try {
      const raw = window.localStorage.getItem(sourcesCacheKey(tv));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.sources) || typeof parsed.at !== 'number') {
        return null;
      }
      if (Date.now() - parsed.at > SOURCES_CACHE_TTL_MS) {
        return null;
      }
      return parsed.sources;
    } catch {
      return null;
    }
  };

  const writeSourcesCache = (tv, sources) => {
    try {
      window.localStorage.setItem(sourcesCacheKey(tv), JSON.stringify({ at: Date.now(), sources }));
    } catch {
      // localStorage unavailable or full — caching is best-effort.
    }
  };

  const clearSourcesCache = (tv) => {
    try {
      window.localStorage.removeItem(sourcesCacheKey(tv));
    } catch {
      // ignore
    }
  };

  /** Merge freshly-fetched (or cached) raw sources with the TV's saved config
   *  and render the two-column list. */
  const showSources = (tv, rawSources) => {
    const withCustom = injectCustomApps(rawSources, tv.customApps);
    const existingConfig = tv.sources || [];
    state.sources = mergeSourcesWithConfig(withCustom, existingConfig);
    renderSourcesList();
    $('sourcesLoadingSpinner').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'none';
    $('sourcesListContainer').style.display = 'block';
  };

  const openEditSourcesScreen = async (index) => {
    state.editingSourcesTvIndex = index;
    const tv = state.configuredTvs[index];

    $('editSourcesTvName').textContent = tv.name;
    $('sourcesListContainer').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'none';

    showScreen('editSourcesScreen');

    // Render from the persisted cache when we already fetched this TV's sources —
    // avoids a re-fetch whose response Config UI X may drop after a modal reopen.
    const cached = readSourcesCache(tv);
    if (cached) {
      $('sourcesLoadingSpinner').style.display = 'none';
      showSources(tv, cached);
      return;
    }

    $('sourcesLoadingSpinner').style.display = 'block';
    await loadSources(tv);
  };

  /** The TV whose sources are being fetched, or null. Shared state, so a load
   *  started for one TV must never render into — or be saved as — another. */
  let sourcesLoadingFor = null;

  const loadSources = async (tv) => {
    // Guard against overlapping fetches for the same TV: a hung request keeps
    // its promise pending for the full 20s, and firing more only stacks dead
    // requests behind it.
    if (sourcesLoadingFor === tv) {
      return;
    }
    sourcesLoadingFor = tv;
    try {
      // The server bounds its own fetch (~15s); this client-side guard is a
      // last resort so a wedged request can never leave the spinner running
      // forever — the user gets a retryable error instead.
      const result = await withTimeout(
        api.getSources(tv),
        20000,
        'Timed out fetching sources from the TV. Turn the TV on and wait until it shows the Home screen (a TV that just woke is still starting its apps), then retry.',
      );

      if (result.success) {
        // Persist the raw list so reopening the modal renders without a re-fetch.
        writeSourcesCache(tv, result.sources);
      }
      // The user may have opened another TV while this one was loading; its
      // list is cached above but must not replace what is on screen.
      if (state.configuredTvs[state.editingSourcesTvIndex] !== tv) {
        return;
      }
      if (result.success) {
        showSources(tv, result.sources);
      } else {
        showSourcesError(result.error);
      }
    } catch (e) {
      if (state.configuredTvs[state.editingSourcesTvIndex] === tv) {
        showSourcesError(e.message);
      }
    } finally {
      if (sourcesLoadingFor === tv) {
        sourcesLoadingFor = null;
      }
    }
  };

  const showSourcesError = (message) => {
    $('sourcesLoadingSpinner').style.display = 'none';
    $('sourcesListContainer').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'block';
    $('sourcesErrorMessage').textContent = message;
    const tv = state.configuredTvs[state.editingSourcesTvIndex];
    renderExplain($('sourcesAssistant'), {
      error: message,
      context: 'Loading the TV\'s sources and apps (GET /sources and /applications, 15 second budget) failed in the plugin settings.',
      device: tv ? assistantTv(tv) : undefined,
      title: 'Why could the sources not be loaded?',
    });
  };

  const renderSourcesList = () => {
    const hidden = $('hiddenSourcesList');
    const visible = $('visibleSourcesList');
    hidden.replaceChildren();
    visible.replaceChildren();

    let visibleIndex = 0;
    state.sources.forEach((source, index) => {
      if (source.visible === false) {
        hidden.appendChild(createHiddenSourceItem(source, index));
      } else {
        visible.appendChild(createVisibleSourceItem(source, visibleIndex++));
      }
    });
  };

  const getSourceTypeBadge = (source) => {
    if (source.icon === 'hdmi') {
      return '<span class="badge bg-primary rounded-pill source-type-badge">HDMI</span>';
    }
    if (source.icon === 'tv') {
      return '<span class="badge bg-secondary rounded-pill source-type-badge">TV</span>';
    }
    if (source.custom) {
      return '<span class="badge bg-warning text-dark rounded-pill source-type-badge" title="Added via the Apps tab">'
        + '<i class="bi bi-stars" aria-hidden="true"></i> Custom</span>';
    }
    return '<span class="badge bg-success rounded-pill source-type-badge">App</span>';
  };

  /** Source names come from the TV (app labels over an unverified connection),
   *  so they are always escaped before they reach the page. */
  const sourceLabel = (source) => escapeHtml(source.customName || source.name);

  const createHiddenSourceItem = (source, index) => {
    const li = document.createElement('li');
    li.className = 'list-group-item source-item source-hidden';
    li.dataset.index = index;
    li.dataset.id = source.id;

    li.innerHTML = `
      <span class="source-name">${sourceLabel(source)}</span>
      ${getSourceTypeBadge(source)}
      <div class="source-actions ms-auto">
        <button type="button" class="show-btn" title="Add to visible" aria-label="Show ${sourceLabel(source)}">
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
        </button>
      </div>
    `;

    li.querySelector('.show-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      source.visible = true;
      renderSourcesList();
      await saveSourcesConfig();
    });

    return li;
  };

  const createVisibleSourceItem = (source, index) => {
    const li = document.createElement('li');
    li.className = 'list-group-item source-item';
    li.dataset.index = index;
    li.dataset.id = source.id;
    li.draggable = true;
    // Focusable so the list can be reordered from the keyboard (Alt+↑/↓).
    li.tabIndex = 0;
    li.setAttribute('aria-label', `${source.customName || source.name}. Press Alt and an arrow key to move.`);

    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true"><i class="bi bi-grip-vertical"></i></span>
      <span class="source-name">${sourceLabel(source)}</span>
      ${getSourceTypeBadge(source)}
      <div class="source-actions ms-auto">
        <button type="button" class="hide-btn" title="Hide source" aria-label="Hide ${sourceLabel(source)}">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </div>
    `;

    li.querySelector('.hide-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      source.visible = false;
      renderSourcesList();
      await saveSourcesConfig();
    });

    return li;
  };

  /** Attached once at startup: the list element outlives every re-render, so
   *  attaching per render stacked a handler per render and saved N times. */
  const setupDragAndDrop = () => {
    const list = $('visibleSourcesList');

    list.addEventListener('dragstart', handleDragStart);
    list.addEventListener('dragend', handleDragEnd);
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);
    list.addEventListener('keydown', handleReorderKey);
  };

  /** Keyboard alternative to drag-and-drop: Alt+ArrowUp / Alt+ArrowDown. */
  const handleReorderKey = async (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) {
      return;
    }
    const item = e.target.closest('.source-item');
    if (!item) {
      return;
    }
    e.preventDefault();
    const id = item.dataset.id;
    const moved = moveVisibleSource(state.sources, id, e.key === 'ArrowUp' ? -1 : 1);
    if (!moved) {
      return;
    }
    state.sources = moved;
    renderSourcesList();
    Array.from($('visibleSourcesList').querySelectorAll('.source-item'))
      .find(el => el.dataset.id === id)?.focus();
    await saveSourcesConfig();
  };

  const handleDragStart = (e) => {
    const item = e.target.closest('.source-item');
    if (!item) {
      return;
    }

    state.draggedItem = item;

    // Small delay to allow the drag image to be captured before adding class
    setTimeout(() => {
      if (state.draggedItem) {
        state.draggedItem.classList.add('dragging');
      }
    }, 0);

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.index);
  };

  const handleDragEnd = async () => {
    const dragged = state.draggedItem;
    if (!dragged) {
      return;
    }
    // Cleared before the await so a second dragend can't save twice.
    state.draggedItem = null;
    dragged.classList.remove('dragging');

    // Remove placeholder if exists
    document.querySelector('.drag-placeholder')?.remove();

    // Final order from the DOM
    const items = Array.from($('visibleSourcesList').querySelectorAll('.source-item'));
    state.sources = reorderVisible(state.sources, items.map(item => item.dataset.id));
    items.forEach((item, index) => {
      item.dataset.index = index;
    });

    await saveSourcesConfig();
    homebridge.toast.success('Order saved');
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!state.draggedItem) {
      return;
    }

    const target = e.target.closest('.source-item');
    if (!target || target === state.draggedItem) {
      return;
    }

    const list = $('visibleSourcesList');
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    // Determine if we should insert before or after the target
    if (e.clientY < midY) {
      if (target.previousElementSibling !== state.draggedItem) {
        list.insertBefore(state.draggedItem, target);
      }
    } else if (target.nextElementSibling !== state.draggedItem) {
      list.insertBefore(state.draggedItem, target.nextElementSibling);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
  };

  const saveSourcesConfig = async () => {
    const tv = state.configuredTvs[state.editingSourcesTvIndex];
    if (!tv) {
      return;
    }
    tv.sources = toSourceConfig(state.sources);
    // Update the in-memory config now (cheap, no re-render); debounce the disk
    // save so a burst of toggles/drags doesn't churn the iframe (issue #14).
    await pushPluginConfig();
    flushSourcesSave();
  };

  const resetSourcesOrder = async () => {
    const tv = state.configuredTvs[state.editingSourcesTvIndex];

    // Clear saved sources config to restore original order
    tv.sources = [];
    await saveConfig();

    // Re-render in default order. Prefer the cached list so we don't re-issue a
    // /get-sources request that Config UI X may drop after a modal reopen (#14).
    const cached = readSourcesCache(tv);
    if (cached) {
      showSources(tv, cached);
    } else {
      $('sourcesLoadingSpinner').style.display = 'block';
      $('sourcesListContainer').style.display = 'none';
      await loadSources(tv);
    }

    homebridge.toast.success('Source order reset to original');
  };

  // ============================================================================
  // DISCOVERY
  // ============================================================================

  const handleDiscover = async () => {
    const btn = $('discoverBtn');
    const btnText = $('discoverBtnText');
    const spinner = $('discoverSpinner');
    const container = $('deviceListContainer');
    const listDiv = $('deviceList');

    btn.disabled = true;
    btnText.textContent = 'Searching...';
    spinner.style.display = 'inline-block';
    container.innerHTML = '';
    listDiv.style.display = 'none';
    clearProblem('pairingProblem');
    const discoveryContext = 'Discovering TVs over mDNS (_androidtvremote2._tcp, 5 second scan) from the plugin settings.';

    try {
      const devices = await api.discover();
      const configuredIps = state.configuredTvs.map(tv => tv.ip);
      const available = devices.filter(d => !configuredIps.includes(getDeviceIp(d)));

      if (!available.length) {
        const msg = devices.length
          ? 'All discovered TVs are already configured.'
          : 'No Android TVs found. Make sure your TV is on and connected to the same network.';
        showAlert(container, devices.length ? 'success' : 'warning', msg);
        if (!devices.length) {
          renderExplain(container.appendChild(document.createElement('div')), {
            error: msg,
            context: discoveryContext,
            title: 'Why was no TV found?',
          });
        }
        listDiv.style.display = 'contents';
      } else {
        container.innerHTML = '<h6>Found Devices:</h6><ul class="list-group mb-3" id="deviceItems"></ul>';
        const ul = container.querySelector('#deviceItems');
        available.forEach(d => ul.appendChild(createDeviceListItem(d)));
        listDiv.style.display = 'contents';
      }
    } catch (e) {
      showAlert(container, 'danger', `Error: ${e.message}`);
      renderExplain(container.appendChild(document.createElement('div')), {
        error: e.message,
        context: discoveryContext,
        title: 'Why did discovery fail?',
      });
      listDiv.style.display = 'contents';
    } finally {
      btn.disabled = false;
      btnText.innerHTML = '<i class="bi bi-search"></i> Discover TVs';
      spinner.style.display = 'none';
    }
  };

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  $('discoverBtn').addEventListener('click', handleDiscover);
  $('submitPinBtn').addEventListener('click', handlePinSubmit);

  // PIN digit input handlers
  document.querySelectorAll('.pin-digit').forEach((input, index, inputs) => {
    // Only allow numbers
    input.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
      // Auto-advance to next input
      if (e.target.value && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    // Handle backspace to go to previous input
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        inputs[index - 1].focus();
      }
      // Submit on Enter
      if (e.key === 'Enter') {
        $('submitPinBtn').click();
      }
    });

    // Select all on focus for easy replacement
    input.addEventListener('focus', (e) => e.target.select());
  });

  $('cancelPairingBtn').addEventListener('click', () => {
    // Abandoning a re-pair leaves the existing credentials in place and goes
    // back where it started, rather than dropping into the add-a-TV wizard.
    if (state.repairingTvIndex !== null) {
      state.repairingTvIndex = null;
      showScreen('editScreen');
      return;
    }
    showScreen('wizardStep1');
    $('deviceList').style.display = 'none';
    $('deviceListContainer').innerHTML = '';
  });
  $('repairTvBtn').addEventListener('click', function () {
    startRepair(this);
  });
  $('addAnotherTvBtn').addEventListener('click', () => {
    resetCurrentConfig();
    showScreen('wizardStep1');
  });
  $('editTvForm').addEventListener('submit', handleEditSubmit);
  $('cancelEditBtn').addEventListener('click', () => showScreen('successScreen'));
  $('cancelDiscoveryBtn').addEventListener('click', () => showScreen('successScreen'));

  // Custom apps
  $('addCustomAppBtn').addEventListener('click', addCustomApp);
  $('detectCurrentAppBtn').addEventListener('click', detectCurrentApp);

  // Custom buttons
  $('addCustomButtonBtn').addEventListener('click', addCustomButton);

  // Step 3 confirm screen
  $('confirmTvForm').addEventListener('submit', handleConfirmSubmit);
  $('cancelConfirmBtn').addEventListener('click', () => {
    resetCurrentConfig();
    showScreen('wizardStep1');
  });

  // MAC address buttons
  $('getMacBtn').addEventListener('click', function() {
    if (!this.disabled) {
      handleGetMac(this, 'editTvIp', 'editTvMac');
    }
  });
  $('confirmGetMacBtn').addEventListener('click', function() {
    if (!this.disabled) {
      handleGetMac(this, 'confirmTvIp', 'confirmTvMac');
    }
  });

  // Edit Sources screen buttons
  $('doneEditSourcesBtn').addEventListener('click', () => {
    // Commit any debounced source-config changes before leaving the screen.
    flushSourcesSave.flush();
    showScreen('successScreen');
  });
  $('resetSourcesOrderBtn').addEventListener('click', resetSourcesOrder);
  $('retryLoadSourcesBtn').addEventListener('click', () => {
    $('sourcesLoadingSpinner').style.display = 'block';
    $('sourcesErrorContainer').style.display = 'none';
    loadSources(state.configuredTvs[state.editingSourcesTvIndex]);
  });
  $('refreshSourcesBtn').addEventListener('click', () => {
    const tv = state.configuredTvs[state.editingSourcesTvIndex];
    // Drop the cached list so the user gets a genuine re-fetch from the TV.
    clearSourcesCache(tv);
    $('sourcesListContainer').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'none';
    $('sourcesLoadingSpinner').style.display = 'block';
    loadSources(tv);
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  setupDragAndDrop();

  $('configuredTvList').addEventListener('click', (e) => {
    const button = e.target.closest('.js-explain-tv');
    const row = button && button.closest('[data-tv-index]');
    const tv = row && state.configuredTvs[Number(row.dataset.tvIndex)];
    if (!tv) {
      return;
    }
    explainWithAssistant(button, row.querySelector('.assistant-answer'), {
      error: tvProblem(tv) || 'The TV does not respond as expected.',
      context: assistantContext('The user is looking at the list of configured TVs in the plugin settings.'),
      device: assistantTv(tv),
      title: `Why does ${tv.name || 'this TV'} need attention?`,
    });
  });

  try {
    if (window.MpKit && MpKit.ai) {
      const status = await MpKit.ai.status();
      assistantEnabled = !!(status && status.enabled);
      $('assistantHint').style.display = assistantEnabled ? 'none' : '';
    }
  } catch {
    // Routes missing or older Homebridge UI: no Assistant
  }

  const config = await homebridge.getPluginConfig();
  if (config.length && config[0].devices?.length) {
    state.configuredTvs = config[0].devices;
    showScreen('successScreen');
  } else {
    showScreen('wizardStep1');
  }
})();
