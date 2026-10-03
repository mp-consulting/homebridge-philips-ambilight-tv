/**
 * Crash-safe JSON persistence for the plugin's small state files.
 *
 * Writing a file in place truncates it first, so a crash or a second
 * concurrent write mid-way leaves truncated JSON behind — which the loaders
 * then silently treat as "no file", throwing away identities and identifiers
 * that HomeKit has already paired against. Writing to a sibling temp file and
 * renaming it over the original is atomic on the same filesystem: readers see
 * either the old file or the new one, never half of either.
 */

import fs from 'fs';
import { rename, writeFile } from 'fs/promises';

const tempPathFor = (filePath: string): string => `${filePath}.${process.pid}.tmp`;

/** Write `data` as JSON to `filePath` atomically, synchronously. */
export const writeJsonAtomicSync = (filePath: string, data: unknown, space?: number): void => {
  const temp = tempPathFor(filePath);
  fs.writeFileSync(temp, JSON.stringify(data, null, space), 'utf-8');
  fs.renameSync(temp, filePath);
};

/**
 * Serializes asynchronous atomic writes to one file, so overlapping saves land
 * in call order and the last one requested is the one left on disk.
 */
export class AtomicJsonFile {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** Queue a write of `data`; resolves once it (and every earlier one) has landed. */
  write(data: unknown, space?: number): Promise<void> {
    const json = JSON.stringify(data, null, space);
    const run = async () => {
      const temp = tempPathFor(this.filePath);
      await writeFile(temp, json, 'utf-8');
      await rename(temp, this.filePath);
    };
    const next = this.chain.then(run, run);
    // Keep the chain alive past a failed write; the caller still sees the error.
    this.chain = next.catch(() => {});
    return next;
  }
}
