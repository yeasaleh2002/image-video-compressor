import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedFormat } from '../types.js';

export interface VideoPlan {
  demuxer: string;
  outFormat: 'mp4' | 'mov' | 'webm' | 'mkv';
  muxer: string;
  mime: string;
  ext: string;
  warnings: string[];
}

const DEMUXER: Partial<Record<DetectedFormat, string>> = {
  mp4: 'mov', mov: 'mov', webm: 'matroska', mkv: 'matroska', avi: 'avi',
};

export function planVideo(format: DetectedFormat): VideoPlan {
  const demuxer = DEMUXER[format];
  if (!demuxer) throw new Error(`No demuxer for ${format}`);
  switch (format) {
    case 'webm': return { demuxer, outFormat: 'webm', muxer: 'webm', mime: 'video/webm', ext: 'webm', warnings: [] };
    case 'mkv': return { demuxer, outFormat: 'mkv', muxer: 'matroska', mime: 'video/x-matroska', ext: 'mkv', warnings: [] };
    case 'mov': return { demuxer, outFormat: 'mov', muxer: 'mov', mime: 'video/quicktime', ext: 'mov', warnings: [] };
    case 'avi': return { demuxer, outFormat: 'mp4', muxer: 'mp4', mime: 'video/mp4', ext: 'mp4', warnings: ['AVI was re-muxed to MP4 (H.264/AAC)'] };
    default: return { demuxer, outFormat: 'mp4', muxer: 'mp4', mime: 'video/mp4', ext: 'mp4', warnings: [] };
  }
}

export function inputArgs(plan: VideoPlan): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-f', plan.demuxer];
}

const VP9_SPEED: Record<NormalizedOptions['video']['preset'], string> = {
  ultrafast: '5', superfast: '4', fast: '3', medium: '2',
};

export interface OutputArgOptions {
  width: number;
  height: number;
  hasAudio: boolean;
  threads: number;
}

export function outputArgs(plan: VideoPlan, o: NormalizedOptions['video'], v: OutputArgOptions): string[] {
  const args: string[] = [
    '-map', '0:v:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-sn', '-dn',
    '-threads', String(v.threads),
  ];

  const vp9 = plan.outFormat === 'webm';
  if (vp9) {
    const crf = Math.round((o.crf * 63) / 51);
    args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1',
      '-deadline', 'good', '-cpu-used', VP9_SPEED[o.preset], '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'libx264', '-crf', String(o.crf), '-preset', o.preset,
      '-profile:v', 'high', '-pix_fmt', 'yuv420p');

    if (v.width % 2 || v.height % 2) {
      args.push('-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2');
      plan.warnings.push(`Odd dimensions ${v.width}x${v.height} trimmed by 1px for H.264 4:2:0`);
    }
  }

  if (o.removeAudio || !v.hasAudio) {
    args.push('-an');
  } else {
    args.push('-map', '0:a:0', '-c:a', vp9 ? 'libopus' : 'aac', '-b:a', o.audioBitrate);
  }

  if (plan.muxer === 'mp4' || plan.muxer === 'mov') args.push('-movflags', '+faststart');
  args.push('-f', plan.muxer);
  return args;
}
