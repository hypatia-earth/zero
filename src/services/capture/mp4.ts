/**
 * MP4 encoding session
 *
 * Uses VideoEncoder (WebCodecs) to encode RGBA frames as H.264,
 * then muxes with Mediabunny into an MP4 container.
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
} from 'mediabunny';

const BITRATE = 3_000_000; // 3 Mbps

/** Pick H.264 profile/level based on resolution */
function pickCodecString(w: number, h: number): string {
  // Baseline L3.1 handles up to 1280×720; High L4.0 for anything larger
  return (w <= 1280 && h <= 720) ? 'avc1.42001f' : 'avc1.640028';
}

export function createMp4Session(fps: number, width: number, height: number) {
  // H.264 requires even dimensions
  const w = width & ~1;
  const h = height & ~1;

  const target = new BufferTarget();
  const videoSource = new EncodedVideoPacketSource('avc');
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let frameCount = 0;
  const frameDurationUs = Math.round(1_000_000 / fps);
  let outputStarted = false;
  let startPromise: Promise<void> | null = null;

  const encoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      // Fire and forget — chunks arrive in decode order, muxer handles backpressure
      void videoSource.add(packet, meta);
    },
    error: (e: DOMException) => {
      throw new Error(`VideoEncoder error: ${e.message}`);
    },
  });

  encoder.configure({
    codec: pickCodecString(w, h),
    width: w,
    height: h,
    bitrate: BITRATE,
    avc: { format: 'avc' },
  });

  return {
    addFrame(rgba: Uint8ClampedArray, _w: number, _h: number): void {
      if (!outputStarted) {
        outputStarted = true;
        startPromise = output.start();
      }
      const timestamp = frameCount * frameDurationUs;
      const frame = new VideoFrame(
        new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        { format: 'RGBA', codedWidth: w, codedHeight: h, timestamp },
      );
      const keyFrame = frameCount % (fps * 2) === 0; // keyframe every ~2s
      encoder.encode(frame, { keyFrame });
      frame.close();
      frameCount++;
    },

    async finish(): Promise<Blob> {
      await encoder.flush();
      encoder.close();
      videoSource.close();
      if (startPromise) await startPromise;
      await output.finalize();
      return new Blob([target.buffer!], { type: 'video/mp4' });
    },
  };
}
