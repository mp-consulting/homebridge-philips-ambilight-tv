import { labelForPackage, parseActivities, parseCurrentPackage } from '../../src/api/AdbClient.js';

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

  it('extracts the foreground package', () => {
    const line = '    topResumedActivity=ActivityRecord{ef59023 u0 com.google.android.youtube.tv/com.google.android.apps.youtube.tv.activity.MainActivity t72997}';
    expect(parseCurrentPackage(line)).toBe('com.google.android.youtube.tv');
    expect(parseCurrentPackage('')).toBeNull();
  });

  it('labels known and unknown packages', () => {
    expect(labelForPackage('com.netflix.ninja')).toBe('Netflix');
    expect(labelForPackage('fr.anidn')).toBe('Anidn');
  });
});
