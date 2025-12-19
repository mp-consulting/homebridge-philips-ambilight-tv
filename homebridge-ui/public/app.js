/**
 * Philips Ambilight TV Configuration Wizard
 * Handles device discovery, pairing, and configuration management
 */

(async () => {
  // ============================================================================
  // CONSTANTS & STATE
  // ============================================================================

  const SCREENS = ['wizardStep1', 'wizardStep2', 'successScreen', 'editScreen'];
  const PLATFORM_NAME = 'PhilipsAmbilightTV';

  const state = {
    currentConfig: { name: '', ip: '', mac: '', username: '', password: '' },
    configuredTvs: [],
    editingTvIndex: null,
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
          <button class="btn btn-sm btn-primary edit-tv-btn mr-2"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-sm btn-danger delete-tv-btn"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `;

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

  const createDeviceListItem = (device) => {
    const li = document.createElement('li');
    li.className = 'list-group-item list-group-item-action';
    li.style.cursor = 'pointer';
    li.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1"><i class="fas fa-tv mr-2"></i> ${device.name || 'Unknown Device'}</h6>
          <small class="text-muted"><i class="fas fa-network-wired mr-1"></i> ${getDeviceIp(device)}</small>
        </div>
        <span class="badge badge-primary badge-pill">Select</span>
      </div>
    `;
    li.addEventListener('click', (e) => {
      e.preventDefault();
      selectDevice(device);
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

  const selectDevice = async (device) => {
    const ip = getDeviceIp(device);
    state.currentConfig.ip = ip;
    state.currentConfig.name = device.name || 'Philips TV';

    try {
      const result = await api.getMac(ip);
      if (result.success) {
        state.currentConfig.mac = result.mac;
      }
    } catch (e) { /* MAC is optional */ }

    await startPairing(ip);
  };

  const startPairing = async (ip) => {
    showScreen('wizardStep2');

    const pinSection = $('pinInputSection');
    const submitBtn = $('submitPinBtn');

    clearPinInputs();
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm PIN';
    pinSection.style.display = 'none';

    homebridge.toast.info('Initiating pairing with TV...');

    try {
      const result = await api.pair(ip, state.currentConfig.name);

      if (result.success) {
        homebridge.toast.success('Check your TV for the PIN code');
        pinSection.style.display = 'block';
        setTimeout(() => focusFirstPinInput(), 100);
      } else {
        homebridge.toast.error(result.error);
        showScreen('wizardStep1');
      }
    } catch (e) {
      homebridge.toast.error(e.message);
      showScreen('wizardStep1');
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

    try {
      const result = await api.pairGrant(state.currentConfig.ip, pin);

      if (result.success) {
        state.currentConfig.username = result.username;
        state.currentConfig.password = result.password;
        await addTv();
        homebridge.toast.success('TV paired successfully!');
        showScreen('successScreen');
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

  const handleGetMac = async (btn) => {
    const ip = $('editTvIp').value.trim();
    if (!ip) {
      homebridge.toast.error('Please enter an IP address first');
      return;
    }

    setButtonLoading(btn, true, 'Getting...');

    try {
      const result = await api.getMac(ip);
      if (result.success) {
        $('editTvMac').value = result.mac;
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

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#getMacBtn');
    if (btn && !btn.disabled) {
      handleGetMac(btn);
    }
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
