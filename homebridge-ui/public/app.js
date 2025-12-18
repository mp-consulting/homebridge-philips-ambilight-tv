/**
 * Philips Ambilight TV Configuration Wizard
 * Handles device discovery, pairing, and configuration management
 */

(async () => {
  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const state = {
    currentConfig: {
      name: '',
      ip: '',
      mac: '',
      username: '',
      password: '',
    },
    configuredTvs: [],
    editingTvIndex: null,
  };

  // ============================================================================
  // DOM ELEMENTS
  // ============================================================================

  const elements = {
    // Screens
    wizardStep1: document.getElementById('wizardStep1'),
    wizardStep2: document.getElementById('wizardStep2'),
    successScreen: document.getElementById('successScreen'),
    editScreen: document.getElementById('editScreen'),

    // Discovery
    discoverBtn: document.getElementById('discoverBtn'),
    discoverBtnText: document.getElementById('discoverBtnText'),
    discoverSpinner: document.getElementById('discoverSpinner'),
    deviceList: document.getElementById('deviceList'),
    deviceListContainer: document.getElementById('deviceListContainer'),

    // Pairing
    pairingStatus: document.getElementById('pairingStatus'),
    pinInputSection: document.getElementById('pinInputSection'),
    pinInput: document.getElementById('pinInput'),
    submitPinBtn: document.getElementById('submitPinBtn'),
    cancelPairingBtn: document.getElementById('cancelPairingBtn'),
    backToHomeFromPairing: document.getElementById('backToHomeFromPairing'),

    // Success screen
    configuredTvList: document.getElementById('configuredTvList'),
    addAnotherTvBtn: document.getElementById('addAnotherTvBtn'),

    // Edit screen
    editTvForm: document.getElementById('editTvForm'),
    editTvName: document.getElementById('editTvName'),
    editTvIp: document.getElementById('editTvIp'),
    editTvMac: document.getElementById('editTvMac'),
    getMacBtn: document.getElementById('getMacBtn'),
    saveEditBtn: document.getElementById('saveEditBtn'),
    cancelEditBtn: document.getElementById('cancelEditBtn'),
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /**
   * Format error messages with line breaks and proper structure
   */
  const formatErrorMessage = (message) => {
    const parts = message.split('\n\n');
    if (parts.length > 1) {
      let formatted = parts[0] + '<br><br>';
      for (let i = 1; i < parts.length; i++) {
        const lines = parts[i].split('\n');
        if (lines.length > 1 && lines[0].includes(':')) {
          formatted += '<strong>' + lines[0] + '</strong><br>';
          for (let j = 1; j < lines.length; j++) {
            if (lines[j].trim()) {
              formatted += lines[j] + '<br>';
            }
          }
        } else {
          formatted += parts[i].replace(/\n/g, '<br>');
        }
      }
      return formatted;
    }
    return message.replace(/\n/g, '<br>');
  };

  /**
   * Show/hide screens
   */
  const hideAllScreens = () => {
    elements.wizardStep1.style.display = 'none';
    elements.wizardStep2.style.display = 'none';
    elements.successScreen.style.display = 'none';
    elements.editScreen.style.display = 'none';
  };

  const showScreen = (screen) => {
    hideAllScreens();
    screen.style.display = 'block';
  };

  // ============================================================================
  // NAVIGATION FUNCTIONS
  // ============================================================================

  const showWizardStep1 = () => showScreen(elements.wizardStep1);

  const showPairingStep = () => showScreen(elements.wizardStep2);

  const showSuccessScreen = () => {
    showScreen(elements.successScreen);
    renderConfiguredTvs();
  };

  const showEditScreen = () => showScreen(elements.editScreen);

  // ============================================================================
  // TV MANAGEMENT FUNCTIONS
  // ============================================================================

  /**
   * Create TV list item HTML
   */
  const createTvListItem = (tv, index) => {
    const listItem = document.createElement('li');
    listItem.className = 'list-group-item';
    listItem.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1">
            <i class="fas fa-tv mr-2"></i>${tv.name || 'Philips TV'}
          </h6>
          <small class="text-muted">
            <i class="fas fa-network-wired mr-1"></i>${tv.ip}
          </small>
        </div>
        <div>
          <button class="btn btn-sm btn-primary edit-tv-btn mr-2" data-index="${index}">
            <i class="fas fa-edit"></i> Edit
          </button>
          <button class="btn btn-sm btn-danger delete-tv-btn" data-index="${index}">
            <i class="fas fa-trash"></i> Delete
          </button>
        </div>
      </div>
    `;

    // Add event listeners
    listItem.querySelector('.edit-tv-btn').addEventListener('click', () => editTv(index));
    listItem.querySelector('.delete-tv-btn').addEventListener('click', async function() {
      this.disabled = true;
      this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
      try {
        await deleteTv(index);
      } catch (error) {
        this.disabled = false;
        this.innerHTML = '<i class="fas fa-trash"></i> Delete';
      }
    });

    return listItem;
  };

  /**
   * Render the list of configured TVs
   */
  const renderConfiguredTvs = () => {
    const container = elements.configuredTvList;

    if (state.configuredTvs.length === 0) {
      container.innerHTML = '<div class="alert alert-info">No TVs configured yet.</div>';
      return;
    }

    container.innerHTML = '';
    state.configuredTvs.forEach((tv, index) => {
      container.appendChild(createTvListItem(tv, index));
    });
  };

  /**
   * Edit a TV configuration
   */
  const editTv = (index) => {
    state.editingTvIndex = index;
    const tv = state.configuredTvs[index];

    elements.editTvName.value = tv.name || '';
    elements.editTvIp.value = tv.ip || '';
    elements.editTvMac.value = tv.mac || '';

    showEditScreen();
  };

  /**
   * Delete a TV configuration
   */
  const deleteTv = async (index) => {
    try {
      state.configuredTvs.splice(index, 1);
      await saveAllTvs();
      homebridge.toast.success('TV removed successfully');

      if (state.configuredTvs.length === 0) {
        showWizardStep1();
      } else {
        renderConfiguredTvs();
      }
    } catch (error) {
      homebridge.toast.error('Failed to delete TV: ' + error.message);
    }
  };

  /**
   * Save all TVs to the config
   */
  const saveAllTvs = async () => {
    const platformConfig = {
      platform: 'PhilipsAmbilightTV',
      devices: state.configuredTvs,
    };
    await homebridge.updatePluginConfig([platformConfig]);
  };

  /**
   * Add new TV to the config
   */
  const updateConfig = async () => {
    const newTv = {
      name: state.currentConfig.name,
      ip: state.currentConfig.ip,
      mac: state.currentConfig.mac,
      username: state.currentConfig.username,
      password: state.currentConfig.password,
    };

    state.configuredTvs.push(newTv);
    await saveAllTvs();
  };

  // ============================================================================
  // DEVICE DISCOVERY & PAIRING
  // ============================================================================

  /**
   * Select a device from the discovery list
   */
  const selectDevice = async (device) => {
    const ipAddress = device.host || device.addresses[0];
    const deviceName = device.name || 'Philips TV';

    state.currentConfig.ip = ipAddress;
    state.currentConfig.name = deviceName;

    // Try to get MAC address
    try {
      const result = await homebridge.request('/get-mac', ipAddress);
      if (result.success) {
        state.currentConfig.mac = result.mac;
      }
    } catch (error) {
      // Silently fail - MAC is optional during discovery
    }

    await startPairing(ipAddress, deviceName);
  };

  /**
   * Start pairing with the TV
   */
  const startPairing = async (ipAddress, deviceName) => {
    showPairingStep();

    elements.pinInput.value = '';
    elements.submitPinBtn.disabled = false;
    elements.submitPinBtn.textContent = 'Confirm PIN';

    elements.pairingStatus.className = 'alert alert-info mb-3';
    elements.pairingStatus.innerHTML = '<strong>Initiating pairing with TV...</strong><br><small>Please wait, this may take a few seconds...</small>';
    elements.pinInputSection.style.display = 'none';

    try {
      const result = await homebridge.request('/pair', { ip: ipAddress, deviceName });

      if (result.success) {
        elements.pairingStatus.className = 'alert alert-success mb-3';
        elements.pairingStatus.innerHTML = '<strong>✓ Pairing request sent!</strong><br><small>Check your TV screen for the PIN code</small>';
        elements.pinInputSection.style.display = 'block';

        setTimeout(() => elements.pinInput.focus(), 100);
      } else {
        elements.pairingStatus.className = 'alert alert-danger mb-3';
        elements.pairingStatus.innerHTML = `<strong>Pairing failed:</strong><br>${formatErrorMessage(result.error)}<br><br><button class="btn btn-sm btn-secondary" onclick="location.reload()">Try Again</button>`;
      }
    } catch (error) {
      elements.pairingStatus.className = 'alert alert-danger mb-3';
      elements.pairingStatus.innerHTML = `<strong>Error:</strong><br>${formatErrorMessage(error.message)}<br><br><button class="btn btn-sm btn-secondary" onclick="location.reload()">Try Again</button>`;
    }
  };

  /**
   * Create device list item
   */
  const createDeviceListItem = (device) => {
    const deviceItem = document.createElement('li');
    deviceItem.className = 'list-group-item list-group-item-action';
    deviceItem.style.cursor = 'pointer';
    deviceItem.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1">
            <i class="fas fa-tv mr-2"></i>${device.name || 'Unknown Device'}
          </h6>
          <small class="text-muted">
            <i class="fas fa-network-wired mr-1"></i>${device.host || device.addresses[0]}
          </small>
        </div>
        <span class="badge badge-primary badge-pill">Select</span>
      </div>
    `;
    deviceItem.addEventListener('click', async (e) => {
      e.preventDefault();
      await selectDevice(device);
    });
    return deviceItem;
  };

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // Discover devices button
  elements.discoverBtn.addEventListener('click', async () => {
    elements.discoverBtn.disabled = true;
    elements.discoverBtnText.textContent = 'Searching...';
    elements.discoverSpinner.style.display = 'inline-block';
    elements.deviceListContainer.innerHTML = '';
    elements.deviceList.style.display = 'none';

    try {
      const devices = await homebridge.request('/discover');

      // Filter out already configured TVs
      const configuredIps = state.configuredTvs.map(tv => tv.ip);
      const availableDevices = devices.filter(device => {
        const deviceIp = device.host || device.addresses[0];
        return !configuredIps.includes(deviceIp);
      });

      if (availableDevices.length === 0) {
        if (devices.length > 0) {
          elements.deviceListContainer.innerHTML = '<div class="alert alert-info">All discovered TVs are already configured.</div>';
        } else {
          elements.deviceListContainer.innerHTML = '<div class="alert alert-warning">No Android TVs found. Make sure your TV is on and connected to the same network.</div>';
        }
        elements.deviceList.style.display = 'block';
      } else {
        elements.deviceListContainer.innerHTML = '<h6>Found Devices:</h6><ul class="list-group mb-3" id="deviceItems"></ul>';
        const deviceItems = elements.deviceListContainer.querySelector('#deviceItems');
        elements.deviceList.style.display = 'block';
        availableDevices.forEach((device) => {
          deviceItems.appendChild(createDeviceListItem(device));
        });
      }
    } catch (error) {
      elements.deviceListContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
      elements.deviceList.style.display = 'block';
    } finally {
      elements.discoverBtn.disabled = false;
      elements.discoverBtnText.textContent = 'Discover TVs';
      elements.discoverSpinner.style.display = 'none';
    }
  });

  // Submit PIN button
  elements.submitPinBtn.addEventListener('click', async () => {
    const pin = elements.pinInput.value;
    const ipAddress = state.currentConfig.ip;

    if (!pin || pin.length !== 4) {
      homebridge.toast.error('Please enter a 4-digit PIN');
      return;
    }

    elements.submitPinBtn.disabled = true;
    elements.submitPinBtn.textContent = 'Verifying...';
    elements.pairingStatus.className = 'alert alert-info';
    elements.pairingStatus.innerHTML = '<strong>Verifying PIN...</strong>';

    try {
      const result = await homebridge.request('/pair-grant', { ip: ipAddress, pin });

      if (result.success) {
        elements.pairingStatus.className = 'alert alert-success';
        elements.pairingStatus.innerHTML = '<strong>✓ Pairing successful!</strong>';

        state.currentConfig.username = result.username;
        state.currentConfig.password = result.password;

        await updateConfig();

        homebridge.toast.success('TV paired successfully!', 'Configuration saved');

        setTimeout(() => showSuccessScreen(), 2000);
      } else {
        elements.pairingStatus.className = 'alert alert-danger';
        elements.pairingStatus.innerHTML = `<strong>Pairing failed:</strong> ${formatErrorMessage(result.error)}`;
        elements.submitPinBtn.disabled = false;
        elements.submitPinBtn.textContent = 'Confirm PIN';
      }
    } catch (error) {
      elements.pairingStatus.className = 'alert alert-danger';
      elements.pairingStatus.innerHTML = `<strong>Error:</strong> ${formatErrorMessage(error.message)}`;
      elements.submitPinBtn.disabled = false;
      elements.submitPinBtn.textContent = 'Confirm PIN';
    }
  });

  // Allow Enter key to submit PIN
  elements.pinInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      elements.submitPinBtn.click();
    }
  });

  // Cancel pairing button
  elements.cancelPairingBtn.addEventListener('click', () => {
    showWizardStep1();
    elements.deviceList.style.display = 'none';
    elements.deviceListContainer.innerHTML = '';
  });

  // Add another TV button
  elements.addAnotherTvBtn.addEventListener('click', () => {
    state.currentConfig = {
      name: '',
      ip: '',
      mac: '',
      username: '',
      password: '',
    };
    showWizardStep1();
  });

  // Save edit form with validation
  elements.editTvForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;

    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return;
    }

    const name = elements.editTvName.value.trim();
    const ip = elements.editTvIp.value.trim();
    const mac = elements.editTvMac.value.trim();

    const updatedTv = {
      ...state.configuredTvs[state.editingTvIndex],
      name,
      ip,
      mac,
    };

    state.configuredTvs[state.editingTvIndex] = updatedTv;

    try {
      await saveAllTvs();
      homebridge.toast.success('TV configuration updated');
      form.classList.remove('was-validated');
      showSuccessScreen();
    } catch (error) {
      homebridge.toast.error('Failed to save configuration: ' + error.message);
    }
  });

  // Cancel edit button
  elements.cancelEditBtn.addEventListener('click', () => {
    showSuccessScreen();
  });

  // Back to home button in pairing screen
  elements.backToHomeFromPairing.addEventListener('click', () => {
    if (state.configuredTvs.length > 0) {
      showSuccessScreen();
    } else {
      showWizardStep1();
    }
  });

  // Get MAC button - Use event delegation to handle click
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#getMacBtn');
    if (btn && !btn.disabled) {
      const ip = elements.editTvIp.value.trim();

      if (!ip) {
        homebridge.toast.error('Please enter an IP address first');
        return;
      }

      const originalContent = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Getting...';

      try {
        const result = await homebridge.request('/get-mac', ip);

        if (result.success) {
          elements.editTvMac.value = result.mac;
          homebridge.toast.success('MAC address retrieved successfully');
        } else {
          homebridge.toast.error('Failed to get MAC address: ' + result.error);
        }
      } catch (error) {
        homebridge.toast.error('Failed to get MAC address: ' + error.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalContent;
      }
    }
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Check if already configured
  const pluginConfig = await homebridge.getPluginConfig();
  if (pluginConfig.length && pluginConfig[0].devices && pluginConfig[0].devices.length) {
    state.configuredTvs = pluginConfig[0].devices;
    showSuccessScreen();
  } else {
    showWizardStep1();
  }
})();
