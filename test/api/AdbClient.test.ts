import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { ADB_RETRY_MS, AdbClient, AdbUnavailableError, labelForPackage, parseActivities, parseCurrentComponent } from '../../src/api/AdbClient.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mockExecFile = vi.mocked(execFile);

/** Answer each adb invocation from `respond(args)`: a string is stdout, an Error fails the call. */
function adbAnswers(respond: (args: string[]) => string | Error): void {
  mockExecFile.mockImplementation(((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    const answer = respond(args);
    if (answer instanceof Error) {
      callback(answer, '', '');
    } else {
      callback(null, answer, '');
    }
  }) as unknown as typeof execFile);
}

const shellCommands = () => mockExecFile.mock.calls
  .map(([, args]) => args as string[])
  .filter(args => args[2] === 'shell')
  .map(args => args[3]);
const connectCount = () => mockExecFile.mock.calls.filter(([, args]) => (args as string[])[0] === 'connect').length;

describe('AdbClient parsers', () => {
  it('parses query-activities output and expands relative class names', () => {
    const out = `3 activities found:
  Activity #0:
    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true
    com.google.android.youtube.tv/com.google.android.apps.youtube.tv.activity.ShellActivity
  Activity #1:
    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
    com.netflix.ninja/.MainActivity
`;
    expect(parseActivities(out)).toEqual([
      { packageName: 'com.google.android.youtube.tv', className: 'com.google.android.apps.youtube.tv.activity.ShellActivity' },
      { packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity' },
    ]);
  });

  it('extracts the foreground component', () => {
    const line = '    topResumedActivity=ActivityRecord{ef59023 u0 com.netflix.ninja/.MainActivity t72997}';
    expect(parseCurrentComponent(line)).toEqual({ packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity' });
    expect(parseCurrentComponent('')).toBeNull();
  });

  it('labels known and unknown packages', () => {
    expect(labelForPackage('com.netflix.ninja')).toBe('Netflix');
    expect(labelForPackage('fr.anidn')).toBe('Anidn');
  });
});

describe('AdbClient', () => {
  let adb: AdbClient;
  const soon = () => Date.now() + 8000;

  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    adb = new AdbClient('192.168.1.100');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects once and reuses the connection', async () => {
    adbAnswers(args => args[0] === 'connect' ? 'connected to 192.168.1.100:5555' : 'u0 com.netflix.ninja/.MainActivity');

    await adb.getCurrentComponent(soon());
    await adb.getCurrentComponent(soon());

    expect(connectCount()).toBe(1);
  });

  it('fails when adb connect reports a failure despite exiting 0', async () => {
    adbAnswers(() => 'failed to connect to 192.168.1.100:5555');

    await expect(adb.getCurrentComponent(soon())).rejects.toThrow('failed to connect');
    expect(shellCommands()).toHaveLength(0);
  });

  it('reconnects once when a known connection went stale', async () => {
    let shells = 0;
    adbAnswers(args => {
      if (args[0] === 'connect') {
        return 'already connected to 192.168.1.100:5555';
      }
      shells++;
      return shells === 2 ? new Error('device offline') : 'u0 com.netflix.ninja/.MainActivity';
    });

    await adb.getCurrentComponent(soon());
    await expect(adb.getCurrentComponent(soon())).resolves.toEqual({ packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity' });
    expect(connectCount()).toBe(2);
  });

  it('explains a missing adb binary', async () => {
    adbAnswers(() => Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }));

    await expect(adb.getApplications(soon())).rejects.toThrow('install adb on the Homebridge host');
  });

  it('fails fast after a failure, then retries once the backoff is over', async () => {
    adbAnswers(() => 'failed to connect to 192.168.1.100:5555');
    await expect(adb.getCurrentComponent(soon())).rejects.toThrow('failed to connect');

    await expect(adb.getCurrentComponent(soon())).rejects.toBeInstanceOf(AdbUnavailableError);
    expect(connectCount()).toBe(1);

    vi.advanceTimersByTime(ADB_RETRY_MS);
    adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'u0 com.netflix.ninja/.MainActivity');
    await expect(adb.getCurrentComponent(soon())).resolves.not.toBeNull();
  });

  it('shares one connect between concurrent commands', async () => {
    adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'u0 com.netflix.ninja/.MainActivity');

    await Promise.all([adb.getCurrentComponent(soon()), adb.getApplications(soon())]);

    expect(connectCount()).toBe(1);
  });

  it('does not start a command without enough time left', async () => {
    await expect(adb.getApplications(Date.now() + 100)).rejects.toThrow('no time left');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('lists Leanback apps with known labels', async () => {
    adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'com.netflix.ninja/.MainActivity\n');

    expect(await adb.getApplications(soon())).toEqual([{
      id: 'com.netflix.ninja',
      label: 'Netflix',
      intent: { component: { packageName: 'com.netflix.ninja', className: 'com.netflix.ninja.MainActivity' }, action: 'android.intent.action.MAIN' },
    }]);
  });

  describe('launch', () => {
    it('launches by package through the Leanback launcher category', async () => {
      adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'Events injected: 1');

      expect(await adb.launch('com.netflix.ninja', undefined, soon())).toBe(true);
      expect(shellCommands()).toEqual(['monkey -p com.netflix.ninja -c android.intent.category.LEANBACK_LAUNCHER 1']);
    });

    it('starts an explicit activity, quoted for the remote shell', async () => {
      adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'Starting: Intent { cmp=com.app/.Main$Inner }');

      expect(await adb.launch('com.app', '.Main$Inner', soon())).toBe(true);
      expect(shellCommands()).toEqual(['am start -n \'com.app/com.app.Main$Inner\'']);
    });

    it('reports an activity the TV does not have', async () => {
      adbAnswers(args => args[0] === 'connect' ? 'connected to x' : 'Error: Activity class {com.app/com.app.Nope} does not exist.');

      expect(await adb.launch('com.app', 'com.app.Nope', soon())).toBe(false);
    });

    it('refuses names that are not Android package or class names', async () => {
      expect(await adb.launch('com.app; reboot', undefined, soon())).toBe(false);
      expect(await adb.launch('com.app', "Main'; reboot; '", soon())).toBe(false);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
