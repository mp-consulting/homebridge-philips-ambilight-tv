import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { StatePollManager } from '../../src/services/StatePollManager.js';
import type { PollCallbacks } from '../../src/services/StatePollManager.js';
import type { PhilipsTVClient } from '../../src/api/PhilipsTVClient.js';

// ============================================================================
// MOCKS
// ============================================================================

let notifyInstances: (EventEmitter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> })[] = [];

vi.mock('../../src/services/NotifyChangeClient.js', () => ({
  NotifyChangeClient: class MockNotifyChangeClient extends EventEmitter {
    start = vi.fn();
    stop = vi.fn();
    constructor() {
      super();
      notifyInstances.push(this as MockNotifyChangeClient);
    }
  },
}));

function createMockTVClient(): PhilipsTVClient {
  return {
    getPowerState: vi.fn().mockResolvedValue(false),
    getAmbilightStyle: vi.fn().mockResolvedValue(null),
    getAmbilightPower: vi.fn().mockResolvedValue(false),
    getVolume: vi.fn().mockResolvedValue(null),
    getCurrentActivity: vi.fn().mockResolvedValue(null),
  } as unknown as PhilipsTVClient;
}

function createMockCallbacks(): PollCallbacks {
  return {
    onPowerChange: vi.fn(),
    onAmbilightUpdate: vi.fn(),
    onVolumeUpdate: vi.fn(),
    onInputUpdate: vi.fn(),
    onAppsReady: vi.fn(),
  };
}

const TEST_CONFIG = {
  name: 'Test TV',
  ip: '192.168.1.100',
  mac: 'AA:BB:CC:DD:EE:FF',
  username: 'testuser',
  password: 'testpass',
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('StatePollManager', () => {
  let manager: StatePollManager;
  let tvClient: ReturnType<typeof createMockTVClient>;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  const debugLog = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    tvClient = createMockTVClient();
    callbacks = createMockCallbacks();
    debugLog.mockReset();
    notifyInstances = [];
  });

  afterEach(() => {
    manager?.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // STARTUP
  // ==========================================================================

  describe('start', () => {
    it('should delay the initial poll', async () => {
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      // Immediately after start, no poll should have happened
      expect(tvClient.getPowerState).not.toHaveBeenCalled();

      // After initial delay (5000ms), poll should trigger
      await vi.advanceTimersByTimeAsync(5100);

      expect(tvClient.getPowerState).toHaveBeenCalled();
    });

    it('should call onAppsReady after initial poll', async () => {
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onAppsReady).toHaveBeenCalled();
    });

    it('should start interval polling after initial poll', async () => {
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);
      const callCount = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      // After another default interval (10s), should poll again
      await vi.advanceTimersByTimeAsync(10_100);

      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callCount);
    });
  });

  // ==========================================================================
  // POWER STATE
  // ==========================================================================

  describe('power state polling', () => {
    it('should notify on power change', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onPowerChange).toHaveBeenCalledWith(true);
    });

    it('should not notify when power state unchanged', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      // Power is already false (default), so no change notification
      expect(callbacks.onPowerChange).not.toHaveBeenCalled();
    });

    it('should skip ambilight/volume/input polls when TV is off', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(tvClient.getAmbilightStyle).not.toHaveBeenCalled();
      expect(tvClient.getVolume).not.toHaveBeenCalled();
      expect(tvClient.getCurrentActivity).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // AMBILIGHT POLLING
  // ==========================================================================

  describe('ambilight polling', () => {
    it('should report ambilight style when available', async () => {
      const style = { styleName: 'FOLLOW_VIDEO', algorithm: 'NATURAL' };
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getAmbilightStyle as ReturnType<typeof vi.fn>).mockResolvedValue(style);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });

      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onAmbilightUpdate).toHaveBeenCalledWith(style, false);
    });

    it('should fall back to ambilight power when style is null', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getAmbilightStyle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (tvClient.getAmbilightPower as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });

      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onAmbilightUpdate).toHaveBeenCalledWith(null, true);
    });
  });

  // ==========================================================================
  // VOLUME POLLING
  // ==========================================================================

  describe('volume polling', () => {
    it('should report mute state changes', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getAmbilightStyle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (tvClient.getAmbilightPower as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 25, muted: true });

      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onVolumeUpdate).toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // INPUT POLLING
  // ==========================================================================

  describe('input polling', () => {
    it('should report current app', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getAmbilightStyle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (tvClient.getAmbilightPower as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mockResolvedValue('com.netflix.ninja');

      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);

      expect(callbacks.onInputUpdate).toHaveBeenCalledWith('com.netflix.ninja');
    });
  });

  // ==========================================================================
  // LONG-POLL LIFECYCLE
  // ==========================================================================

  describe('long-poll lifecycle', () => {
    it('should not start long-poll when TV is off at startup', async () => {
      // TV starts off (default mock)
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // No long-poll client should have been created
      expect(notifyInstances).toHaveLength(0);
    });

    it('should not retry long-poll when TV turns off', async () => {
      // Start with TV on — long-poll is created
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);
      expect(notifyInstances).toHaveLength(1);

      // TV turns off — long-poll is stopped proactively by pollState()
      // (listeners removed, so any late 'failed' event is ignored)
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_100);

      expect(notifyInstances[0].stop).toHaveBeenCalled();

      // Wait well past retry interval — no new instance should be created
      await vi.advanceTimersByTimeAsync(120_000);
      expect(notifyInstances).toHaveLength(1);
    });

    it('should retry long-poll when it fails while TV is on', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      expect(notifyInstances).toHaveLength(1);
      notifyInstances[0].emit('failed');

      expect(debugLog).toHaveBeenCalledWith('warn', 'Long-poll failed while TV is on, will retry');

      // After retry delay, a new long-poll client should be created
      await vi.advanceTimersByTimeAsync(60_100);
      expect(notifyInstances).toHaveLength(2);
    });

    it('should start long-poll when TV turns on', async () => {
      // TV starts off — no long-poll created
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);
      expect(notifyInstances).toHaveLength(0);

      // TV turns on — detected by next interval poll
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_100);

      // A long-poll client should have been created
      expect(notifyInstances).toHaveLength(1);
      expect(notifyInstances[0].start).toHaveBeenCalled();
    });

    it('should stop long-poll immediately when TV turns off', async () => {
      // Start with TV on
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      const client = notifyInstances[0];

      // TV turns off
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_100);

      expect(client.stop).toHaveBeenCalled();
    });

    it('should not create orphaned clients when retry races with power-on', async () => {
      // Start with TV on
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // Long-poll fails while TV is on — retry scheduled in 60s
      notifyInstances[0].emit('failed');
      expect(notifyInstances).toHaveLength(1);

      // At 30s: TV turns off then back on (detected by interval polling)
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(10_100);
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_100);

      // Power-on created a new client
      const countAfterPowerOn = notifyInstances.length;

      // Wait past original retry timer — should NOT create another client
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notifyInstances).toHaveLength(countAfterPowerOn);
    });

    it('should stop interval polling when long-poll is confirmed working', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // Emit an actionable notification on the latest client to confirm long-poll
      const latestClient = notifyInstances[notifyInstances.length - 1];
      latestClient.emit('notification', { 'audio/volume': {} });

      expect(debugLog).toHaveBeenCalledWith('info', 'Long-poll confirmed working, stopped interval polling');

      // Record call count, then wait past interval — should not increase
      // (need to wait for the pollState triggered by notification first)
      await vi.advanceTimersByTimeAsync(100);
      const callCount = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
    });
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  describe('cleanup', () => {
    it('should stop all timers and long-poll client', async () => {
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      // Let initial poll run
      await vi.advanceTimersByTimeAsync(5100);
      const callCount = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      manager.cleanup();

      // After cleanup, no more polls should happen
      await vi.advanceTimersByTimeAsync(30_000);
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
    });

    it('should be safe to call cleanup multiple times', () => {
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      manager.cleanup();
      manager.cleanup(); // should not throw
    });
  });

  // ==========================================================================
  // CUSTOM POLLING INTERVAL
  // ==========================================================================

  describe('custom polling interval', () => {
    it('should use config pollingInterval if set', async () => {
      const config = { ...TEST_CONFIG, pollingInterval: 3000 };
      manager = new StatePollManager(tvClient, config, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);
      const callCount = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      // After 3s interval, should poll again
      await vi.advanceTimersByTimeAsync(3100);
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callCount);
    });
  });
});
