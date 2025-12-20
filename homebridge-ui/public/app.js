/**
 * Philips Ambilight TV Configuration Wizard
 * Handles device discovery, pairing, and configuration management
 */

(async () => {
  // ============================================================================
  // CONSTANTS & STATE
  // ============================================================================

  const SCREENS = ['wizardStep1', 'wizardStep2', 'wizardStep3', 'successScreen', 'editScreen', 'editSourcesScreen'];
  const PLATFORM_NAME = 'PhilipsAmbilightTV';

  const state = {
    currentConfig: { name: '', ip: '', mac: '', username: '', password: '' },
    configuredTvs: [],
    editingTvIndex: null,
    editingSourcesTvIndex: null,
    sources: [],
    draggedItem: null,
    dragStartIndex: null,
  };

  // ============================================================================
  // DOM HELPERS
  // ============================================================================

  const $ = (id) => document.getElementById(id);

  const setButtonLoading = (btn, loading, loadingText = 'Loading...', originalContent = null) => {
    if (loading) {
      btn.dataset.originalContent = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${loadingText}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = originalContent || btn.dataset.originalContent;
    }
  };

  const showAlert = (container, type, message) => {
    container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  };

  // ============================================================================
  // NAVIGATION
  // ============================================================================

  const showScreen = (screenId) => {
    SCREENS.forEach((id) => {
      $(id).style.display = id === screenId ? 'block' : 'none';
    });
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
    discover: () => homebridge.request('/discover'),
    pair: (ip, deviceName) => homebridge.request('/pair', { ip, deviceName }),
    pairGrant: (ip, pin) => homebridge.request('/pair-grant', { ip, pin }),
    getMac: (ip) => homebridge.request('/get-mac', ip),
    wakeOnLan: (mac) => homebridge.request('/wake-on-lan', { mac }),
    getSources: (ip, username, password, mac) => homebridge.request('/get-sources', { ip, username, password, mac }),
  };

  // ============================================================================
  // CONFIG MANAGEMENT
  // ============================================================================

  const saveConfig = async () => {
    await homebridge.updatePluginConfig([{
      platform: PLATFORM_NAME,
      devices: state.configuredTvs,
    }]);
  };

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
    li.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1"><i class="fas fa-tv mr-2"></i> ${tv.name}</h6>
          <small class="text-muted"><i class="fas fa-network-wired mr-1"></i> ${tv.ip}</small>
        </div>
        <div>
          <button class="btn btn-sm btn-secondary edit-sources-btn mr-2"><i class="fas fa-list"></i> Sources</button>
          <button class="btn btn-sm btn-primary edit-tv-btn mr-2"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-sm btn-danger delete-tv-btn"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `;

    li.querySelector('.edit-sources-btn').addEventListener('click', () => openEditSourcesScreen(index));
    li.querySelector('.edit-tv-btn').addEventListener('click', () => openEditScreen(index));
    li.querySelector('.delete-tv-btn').addEventListener('click', async function () {
      setButtonLoading(this, true, 'Deleting...');
      try {
        await deleteTv(index);
      } catch (e) {
        setButtonLoading(this, false, null, '<i class="fas fa-trash"></i> Delete');
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
        const result = await api.wakeOnLan(state.currentConfig.mac);
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

    // Get MAC address first (needed for WOL)
    try {
      const result = await api.getMac(ip);
      if (result.success) {
        state.currentConfig.mac = result.mac;
      }
    } catch (e) { /* MAC is optional */ }

    await startPairing(ip, listItem);
  };

  const startPairing = async (ip, listItem) => {
    // Show loading state on the list item
    const badge = listItem?.querySelector('.select-badge');
    const originalBadgeText = badge?.textContent;
    if (badge) {
      badge.textContent = 'Connecting...';
      badge.classList.remove('badge-primary');
      badge.classList.add('badge-secondary');
    }

    homebridge.toast.info('Initiating pairing with TV...');

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
      } else {
        homebridge.toast.error(result.error);
        // Restore badge
        if (badge) {
          badge.textContent = originalBadgeText;
          badge.classList.remove('badge-secondary');
          badge.classList.add('badge-primary');
        }
        if (state.currentConfig.mac && listItem) {
          showWolCollapse(listItem);
        }
      }
    } catch (e) {
      homebridge.toast.error(e.message);
      // Restore badge
      if (badge) {
        badge.textContent = originalBadgeText;
        badge.classList.remove('badge-secondary');
        badge.classList.add('badge-primary');
      }
      if (state.currentConfig.mac && listItem) {
        showWolCollapse(listItem);
      }
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
            <h6 class="mb-1"><i class="fas fa-tv mr-2"></i> ${device.name || 'Unknown Device'}</h6>
            <small class="text-muted"><i class="fas fa-network-wired mr-1"></i> ${ip}</small>
          </div>
          <span class="badge badge-primary badge-pill select-badge">Select</span>
        </div>
      </div>
      <div class="wol-collapse mt-2" style="display: none;">
        <div class="alert alert-warning mb-0">
          <h6 class="alert-heading mb-1"><i class="fas fa-power-off"></i> TV not responding</h6>
          <p class="mb-2 small">The TV may be in standby mode.</p>
          <button class="btn btn-warning btn-sm wol-btn" type="button">
            <i class="fas fa-bolt"></i> Wake TV
          </button>
          <button class="btn btn-secondary btn-sm wol-retry-btn" type="button">
            <i class="fas fa-redo"></i> Retry
          </button>
        </div>
      </div>
    `;

    li.querySelector('.device-row').addEventListener('click', (e) => {
      e.preventDefault();
      selectDevice(device, li);
    });

    return li;
  };

  const handlePinSubmit = async () => {
    const pin = getPinValue();
    if (!pin || pin.length !== 4) {
      homebridge.toast.error('Please enter a 4-digit PIN');
      return;
    }

    const btn = $('submitPinBtn');

    setButtonLoading(btn, true, 'Verifying...');

    try {
      const result = await api.pairGrant(state.currentConfig.ip, pin);

      if (result.success) {
        state.currentConfig.username = result.username;
        state.currentConfig.password = result.password;
        showConfirmScreen();
      } else {
        homebridge.toast.error(result.error);
        setButtonLoading(btn, false, null, 'Confirm PIN');
        clearPinInputs();
        focusFirstPinInput();
      }
    } catch (e) {
      homebridge.toast.error(e.message);
      setButtonLoading(btn, false, null, 'Confirm PIN');
      clearPinInputs();
      focusFirstPinInput();
    }
  };

  // ============================================================================
  // EDIT SCREEN
  // ============================================================================

  const openEditScreen = (index) => {
    state.editingTvIndex = index;
    const tv = state.configuredTvs[index];
    $('editTvName').value = tv.name || '';
    $('editTvIp').value = tv.ip || '';
    $('editTvMac').value = tv.mac || '';
    showScreen('editScreen');
  };

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return;
    }

    try {
      await updateTv(state.editingTvIndex, {
        name: $('editTvName').value.trim(),
        ip: $('editTvIp').value.trim(),
        mac: $('editTvMac').value.trim(),
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
    if (!ip) {
      homebridge.toast.error('Please enter an IP address first');
      return;
    }

    setButtonLoading(btn, true, 'Getting...');

    try {
      const result = await api.getMac(ip);
      if (result.success) {
        $(macInputId).value = result.mac;
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
    $('confirmTvName').value = state.currentConfig.name || 'Philips TV';
    $('confirmTvIp').value = state.currentConfig.ip || '';
    $('confirmTvMac').value = state.currentConfig.mac || '';
    showScreen('wizardStep3');
    $('confirmTvName').focus();
    $('confirmTvName').select();
  };

  const handleConfirmSubmit = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return;
    }

    state.currentConfig.name = $('confirmTvName').value.trim();
    state.currentConfig.mac = $('confirmTvMac').value.trim();

    try {
      await addTv();
      homebridge.toast.success('TV saved successfully!');
      form.classList.remove('was-validated');
      showScreen('successScreen');
    } catch (e) {
      homebridge.toast.error('Failed to save: ' + e.message);
    }
  };

  // ============================================================================
  // EDIT SOURCES SCREEN
  // ============================================================================

  const openEditSourcesScreen = async (index) => {
    state.editingSourcesTvIndex = index;
    const tv = state.configuredTvs[index];

    $('editSourcesTvName').textContent = tv.name;
    $('sourcesLoadingSpinner').style.display = 'block';
    $('sourcesListContainer').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'none';

    showScreen('editSourcesScreen');

    await loadSources(tv);
  };

  const loadSources = async (tv) => {
    try {
      const result = await api.getSources(tv.ip, tv.username, tv.password, tv.mac);

      if (result.success) {
        // Merge with existing source config (order and visibility)
        const existingConfig = tv.sources || [];
        state.sources = mergeSourcesWithConfig(result.sources, existingConfig);
        renderSourcesList();

        $('sourcesLoadingSpinner').style.display = 'none';
        $('sourcesListContainer').style.display = 'block';
      } else {
        showSourcesError(result.error);
      }
    } catch (e) {
      showSourcesError(e.message);
    }
  };

  const mergeSourcesWithConfig = (fetchedSources, existingConfig) => {
    // Create a map of existing config by id
    const configMap = new Map(existingConfig.map(s => [s.id, s]));

    // Merge fetched sources with existing config
    const merged = fetchedSources.map((source, index) => {
      const existing = configMap.get(source.id);
      return {
        ...source,
        order: existing?.order ?? index,
        visible: existing?.visible ?? true,
        customName: existing?.customName,
      };
    });

    // Sort by order
    merged.sort((a, b) => a.order - b.order);

    return merged;
  };

  const showSourcesError = (message) => {
    $('sourcesLoadingSpinner').style.display = 'none';
    $('sourcesListContainer').style.display = 'none';
    $('sourcesErrorContainer').style.display = 'block';
    $('sourcesErrorMessage').textContent = message;
  };

  const renderSourcesList = () => {
    const list = $('sourcesList');
    list.innerHTML = '';

    state.sources.forEach((source, index) => {
      const li = createSourceListItem(source, index);
      list.appendChild(li);
    });

    setupDragAndDrop();
  };

  const getSourceIcon = (source) => {
    if (source.icon === 'hdmi') return '<i class="fas fa-plug source-icon hdmi"></i>';
    if (source.icon === 'tv') return '<i class="fas fa-broadcast-tower source-icon tv"></i>';
    return '<i class="fas fa-mobile-alt source-icon app"></i>';
  };

  const getSourceTypeName = (source) => {
    if (source.icon === 'hdmi') return 'HDMI Input';
    if (source.icon === 'tv') return 'TV Tuner';
    return 'Application';
  };

  const createSourceListItem = (source, index) => {
    const li = document.createElement('li');
    li.className = `list-group-item source-item${source.visible === false ? ' source-hidden' : ''}`;
    li.dataset.index = index;
    li.dataset.id = source.id;
    li.draggable = true;

    li.innerHTML = `
      <span class="drag-handle"><i class="fas fa-grip-vertical"></i></span>
      ${getSourceIcon(source)}
      <div class="source-info">
        <p class="source-name">${source.customName || source.name}</p>
        <span class="source-type">${getSourceTypeName(source)}</span>
      </div>
      <div class="source-actions">
        <button class="visibility-btn${source.visible === false ? ' hidden' : ''}" title="${source.visible === false ? 'Show' : 'Hide'} source">
          <i class="fas fa-eye${source.visible === false ? '-slash' : ''}"></i>
        </button>
      </div>
    `;

    // Visibility toggle
    li.querySelector('.visibility-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      source.visible = source.visible === false ? true : false;
      await saveSourcesConfig();
      renderSourcesList();
    });

    return li;
  };

  const setupDragAndDrop = () => {
    const list = $('sourcesList');

    list.addEventListener('dragstart', handleDragStart);
    list.addEventListener('dragend', handleDragEnd);
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);
  };

  const handleDragStart = (e) => {
    const item = e.target.closest('.source-item');
    if (!item) return;

    state.draggedItem = item;
    state.dragStartIndex = parseInt(item.dataset.index);

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
    if (!state.draggedItem) return;

    state.draggedItem.classList.remove('dragging');

    // Remove placeholder if exists
    const placeholder = document.querySelector('.drag-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    // Get final order from DOM
    const list = $('sourcesList');
    const items = Array.from(list.querySelectorAll('.source-item'));
    const newOrder = items.map(item => item.dataset.id);

    // Reorder state.sources to match DOM order
    state.sources.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));

    // Update order values
    state.sources.forEach((source, index) => {
      source.order = index;
    });

    // Update data-index attributes
    items.forEach((item, index) => {
      item.dataset.index = index;
    });

    await saveSourcesConfig();
    homebridge.toast.success('Order saved');

    state.draggedItem = null;
    state.dragStartIndex = null;
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!state.draggedItem) return;

    const target = e.target.closest('.source-item');
    if (!target || target === state.draggedItem) return;

    const list = $('sourcesList');
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    // Determine if we should insert before or after the target
    if (e.clientY < midY) {
      // Insert before
      if (target.previousElementSibling !== state.draggedItem) {
        list.insertBefore(state.draggedItem, target);
      }
    } else {
      // Insert after
      if (target.nextElementSibling !== state.draggedItem) {
        list.insertBefore(state.draggedItem, target.nextElementSibling);
      }
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
  };

  const saveSourcesConfig = async () => {
    const tv = state.configuredTvs[state.editingSourcesTvIndex];
    tv.sources = state.sources.map(s => ({
      id: s.id,
      order: s.order,
      visible: s.visible,
      customName: s.customName,
    }));
    await saveConfig();
  };

  const resetSourcesOrder = async () => {
    const tv = state.configuredTvs[state.editingSourcesTvIndex];

    // Clear saved sources config to restore original order
    tv.sources = [];
    await saveConfig();

    // Show loading state
    $('sourcesLoadingSpinner').style.display = 'block';
    $('sourcesListContainer').style.display = 'none';

    // Re-fetch sources from TV (will use default order since config is cleared)
    await loadSources(tv);

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

    try {
      const devices = await api.discover();
      const configuredIps = state.configuredTvs.map(tv => tv.ip);
      const available = devices.filter(d => !configuredIps.includes(getDeviceIp(d)));

      if (!available.length) {
        const msg = devices.length
          ? 'All discovered TVs are already configured.'
          : 'No Android TVs found. Make sure your TV is on and connected to the same network.';
        showAlert(container, devices.length ? 'success' : 'warning', msg);
        listDiv.style.display = 'contents';
      } else {
        container.innerHTML = '<h6>Found Devices:</h6><ul class="list-group mb-3" id="deviceItems"></ul>';
        const ul = container.querySelector('#deviceItems');
        available.forEach(d => ul.appendChild(createDeviceListItem(d)));
        listDiv.style.display = 'contents';
      }
    } catch (e) {
      showAlert(container, 'danger', `Error: ${e.message}`);
      listDiv.style.display = 'contents';
    } finally {
      btn.disabled = false;
      btnText.innerHTML = '<i class="fas fa-search"></i> Discover TVs';
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
    showScreen('wizardStep1');
    $('deviceList').style.display = 'none';
    $('deviceListContainer').innerHTML = '';
  });
  $('addAnotherTvBtn').addEventListener('click', () => {
    resetCurrentConfig();
    showScreen('wizardStep1');
  });
  $('editTvForm').addEventListener('submit', handleEditSubmit);
  $('cancelEditBtn').addEventListener('click', () => showScreen('successScreen'));
  $('cancelDiscoveryBtn').addEventListener('click', () => showScreen('successScreen'));

  // Step 3 confirm screen
  $('confirmTvForm').addEventListener('submit', handleConfirmSubmit);
  $('cancelConfirmBtn').addEventListener('click', () => {
    resetCurrentConfig();
    showScreen('wizardStep1');
  });

  // MAC address buttons
  $('getMacBtn').addEventListener('click', function() {
    if (!this.disabled) handleGetMac(this, 'editTvIp', 'editTvMac');
  });
  $('confirmGetMacBtn').addEventListener('click', function() {
    if (!this.disabled) handleGetMac(this, 'confirmTvIp', 'confirmTvMac');
  });

  // Edit Sources screen buttons
  $('doneEditSourcesBtn').addEventListener('click', () => showScreen('successScreen'));
  $('resetSourcesOrderBtn').addEventListener('click', resetSourcesOrder);
  $('retryLoadSourcesBtn').addEventListener('click', () => {
    $('sourcesLoadingSpinner').style.display = 'block';
    $('sourcesErrorContainer').style.display = 'none';
    loadSources(state.configuredTvs[state.editingSourcesTvIndex]);
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  const config = await homebridge.getPluginConfig();
  if (config.length && config[0].devices?.length) {
    state.configuredTvs = config[0].devices;
    showScreen('successScreen');
  } else {
    showScreen('wizardStep1');
  }
})();
