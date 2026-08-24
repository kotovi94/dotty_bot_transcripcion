import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import { Writable } from "node:stream";

const WAV_HEADER_BYTES = 44;

export class WavFileWriter extends Writable {
  private readonly fileDescriptor: number;
  private dataBytes = 0;
  private fileClosed = false;

  constructor(
    path: string,
    private readonly sampleRate = 48_000,
    private readonly channels = 1,
    private readonly bitsPerSample = 16,
  ) {
    super();
    this.fileDescriptor = openSync(path, "wx");
    writeSync(this.fileDescriptor, createWavHeader(0, sampleRate, channels, bitsPerSample));
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      writeSync(this.fileDescriptor, chunk);
      this.dataBytes += chunk.length;
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      writeSync(
        this.fileDescriptor,
        createWavHeader(
          this.dataBytes,
          this.sampleRate,
          this.channels,
          this.bitsPerSample,
        ),
        0,
        WAV_HEADER_BYTES,
        0,
      );
      fsyncSync(this.fileDescriptor);
      this.closeFile();
      callback();
    } catch (error) {
      this.closeFile();
      callback(error as Error);
    }
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.closeFile();
    callback(error);
  }

  private closeFile(): void {
    if (this.fileClosed) return;
    this.fileClosed = true;
    closeSync(this.fileDescriptor);
  }
}

export function createWavHeader(
  dataBytes: number,
  sampleRate = 48_000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
