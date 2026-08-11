import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { finished, type Readable } from 'node:stream';

/**
 * Optional on-disk cache for tarballs that passed the age policy. Keys are
 * fully percent-encoded (single path segment), so request data can never
 * traverse outside the cache directory.
 */
export class TarballDiskCache {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private filePath(name: string, filename: string): string {
    return path.join(this.dir, encodeURIComponent(`${name}/-/${filename}`));
  }

  async open(name: string, filename: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
    const file = this.filePath(name, filename);
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      return { stream: createReadStream(file), size: info.size };
    } catch {
      return null;
    }
  }

  /**
   * Tee `source` into the cache while it is also being piped to the client.
   * Best-effort: any failure (disk full, premature client abort) removes the
   * temp file and never disturbs the client-facing stream.
   */
  writeThrough(name: string, filename: string, source: Readable): void {
    const finalPath = this.filePath(name, filename);
    const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const sink = createWriteStream(tmpPath, { flags: 'wx' });
    const discard = () => unlink(tmpPath).catch(() => {});

    sink.on('error', () => {
      source.unpipe(sink);
      discard();
    });
    finished(source, (err) => {
      if (err) sink.destroy(err);
    });
    finished(sink, (err) => {
      if (err) {
        discard();
      } else {
        rename(tmpPath, finalPath).catch(discard);
      }
    });

    source.pipe(sink);
  }
}
