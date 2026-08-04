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

    it('should report the initial state once, then not re-notify when unchanged', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);
      // First poll reports the baseline (off) so consumers can sync state
      expect(callbacks.onPowerChange).toHaveBeenCalledTimes(1);
      expect(callbacks.onPowerChange).toHaveBeenCalledWith(false);

      // Further polls with the same state must not notify again
      await vi.advanceTimersByTimeAsync(20_000);
      expect(callbacks.onPowerChange).toHaveBeenCalledTimes(1);
    });

    it('should report a genuine power-on after being off at startup', async () => {
      const getPower = tvClient.getPowerState as ReturnType<typeof vi.fn>;
      getPower.mockResolvedValue(false);
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();

      await vi.advanceTimersByTimeAsync(5100);
      expect(callbacks.onPowerChange).toHaveBeenLastCalledWith(false);

      // TV turns on later — must fire onPowerChange(true) as a real transition
      getPower.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_100);
      expect(callbacks.onPowerChange).toHaveBeenLastCalledWith(true);
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

    it('should refresh state from an activities/tv-only notification (remote-driven change)', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      const latestClient = notifyInstances[notifyInstances.length - 1];
      const before = (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;

      // The TV reports a source change made with the physical remote only via
      // activities/tv — this must still trigger a full state poll.
      latestClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);

      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    });

    it('should throttle repeated activities/tv-only notifications', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      const latestClient = notifyInstances[notifyInstances.length - 1];
      latestClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);
      const afterFirst = (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;

      // A burst of further activities/tv ticks within the throttle window must
      // not each trigger a poll.
      latestClient.emit('notification', { 'activities/tv': {} });
      latestClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);
      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterFirst);

      // Past the throttle window, the next tick refreshes again.
      await vi.advanceTimersByTimeAsync(10_000);
      latestClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);
      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('should stop interval polling when only activities/tv is ever pushed', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // Models that only ever surface activities/tv must still drop the
      // interval baseline: the throttled refresh already covers the same
      // cadence, so running both would double the request rate.
      const latestClient = notifyInstances[notifyInstances.length - 1];
      latestClient.emit('notification', { 'activities/tv': {} });
      expect(debugLog).toHaveBeenCalledWith('info', 'Long-poll confirmed working, stopped interval polling');

      await vi.advanceTimersByTimeAsync(100);
      const callCount = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      // No further ticks arrive, so nothing should poll — proving the interval
      // timer is gone rather than quietly running alongside the throttle.
      await vi.advanceTimersByTimeAsync(20_000);
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
    });

    it('should not poll twice when activities/tv ticks right after an actionable refresh', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      const latestClient = notifyInstances[notifyInstances.length - 1];
      latestClient.emit('notification', { 'audio/volume': {} });
      await vi.advanceTimersByTimeAsync(100);
      const afterActionable = (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;

      // activities/tv ticks about once a second, so one lands just behind the
      // immediate refresh above — it must not trigger a redundant full poll.
      await vi.advanceTimersByTimeAsync(1000);
      latestClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);

      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterActionable);
    });

    it('should clear the activities/tv throttle when the long-poll is torn down', async () => {
      const config = { ...TEST_CONFIG, pollingInterval: 1000 };
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, config, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // Stamp the throttle, then tear the long-poll down and cycle the TV off
      // and back on — all well inside the 10s throttle window.
      notifyInstances[notifyInstances.length - 1].emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);
      notifyInstances[notifyInstances.length - 1].emit('failed');

      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(1100);
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(1100);

      // The fresh long-poll must not inherit the old timestamp, or its first
      // tick would be swallowed.
      const newClient = notifyInstances[notifyInstances.length - 1];
      const before = (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;
      newClient.emit('notification', { 'activities/tv': {} });
      await vi.advanceTimersByTimeAsync(100);

      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    });

    it('should sanitize TV-supplied resource names before logging them', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      // Resource names arrive over a connection with certificate verification
      // disabled, so a newline in one must not forge an extra log line.
      const latestClient = notifyInstances[notifyInstances.length - 1];
      latestClient.emit('notification', { 'audio/volume\n[Homebridge] forged': {} });
      await vi.advanceTimersByTimeAsync(100);

      const logged = debugLog.mock.calls
        .filter(([level, message]) => level === 'debug' && String(message).startsWith('NotifyChange trigger:'))
        .map(([, message]) => String(message));

      expect(logged.length).toBeGreaterThan(0);
      expect(logged.every(message => !message.includes('\n'))).toBe(true);
      expect(logged.some(message => message.includes('audio/volume [Homebridge] forged'))).toBe(true);
    });

    // ========================================================================
    // THE PLUGIN MUST NEVER BE LEFT WITH NOTHING WATCHING THE TV
    // ========================================================================

    /** TV on, with a notification confirming the channel and dropping the
     *  interval baseline — the state the plugin settles into in normal use. */
    const startWithConfirmedLongPoll = async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      notifyInstances[notifyInstances.length - 1].emit('notification', { 'audio/volume': {} });
      await vi.advanceTimersByTimeAsync(100);
      expect(debugLog).toHaveBeenCalledWith('info', 'Long-poll confirmed working, stopped interval polling');
    };

    it('should keep watching the TV after it is turned off', async () => {
      await startWithConfirmedLongPoll();

      // The TV goes to standby, so the long-poll is torn down — leaving
      // nothing polling at all unless the baseline comes back with it.
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      notifyInstances[notifyInstances.length - 1].emit('notification', { powerstate: {} });
      await vi.advanceTimersByTimeAsync(100);
      expect(callbacks.onPowerChange).toHaveBeenLastCalledWith(false);

      // Switching it back on has to reach HomeKit.
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10_100);

      expect(callbacks.onPowerChange).toHaveBeenLastCalledWith(true);
    });

    it('should resume interval polling when the long-poll goes quiet', async () => {
      await startWithConfirmedLongPoll();
      const before = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      // The channel delivers nothing and never reports a failure, so without
      // the health check the plugin would sit here indefinitely.
      await vi.advanceTimersByTimeAsync(90_000);

      expect(debugLog).toHaveBeenCalledWith('warn', expect.stringContaining('resuming interval polling'));
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    });

    it('should not resume interval polling while the long-poll is delivering', async () => {
      await startWithConfirmedLongPoll();
      const before = (tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length;

      // A healthy channel refreshes well inside the staleness threshold.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(15_000);
        notifyInstances[notifyInstances.length - 1].emit('notification', { 'activities/tv': {} });
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(debugLog).not.toHaveBeenCalledWith('warn', expect.stringContaining('resuming interval polling'));
      // One refresh per notification, and nothing from an interval baseline.
      expect((tvClient.getPowerState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 6);
    });

    it('should ignore an empty notification', async () => {
      (tvClient.getPowerState as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tvClient.getVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ current: 10, muted: false });
      manager = new StatePollManager(tvClient, TEST_CONFIG, callbacks, debugLog);
      manager.start();
      await vi.advanceTimersByTimeAsync(5100);

      const latestClient = notifyInstances[notifyInstances.length - 1];
      const before = (tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;

      latestClient.emit('notification', {});
      await vi.advanceTimersByTimeAsync(100);

      expect((tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
      expect(debugLog).not.toHaveBeenCalledWith('info', 'Long-poll confirmed working, stopped interval polling');
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
