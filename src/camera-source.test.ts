import { describe, expect, it } from 'vitest';
import { checkIpUrl, guessFormat } from './camera-source';

describe('IP camera links', () => {
  it('reads HLS and file links as video, the rest as MJPEG', () => {
    expect(guessFormat('http://cam.local/live/index.m3u8')).toBe('video');
    expect(guessFormat('https://bridge:1984/api/stream.mp4?src=booth1')).toBe('video');
    expect(guessFormat('http://192.168.1.20:1984/api/stream.mjpeg?src=booth1')).toBe('mjpeg');
    expect(guessFormat('http://192.168.1.30/video.cgi')).toBe('mjpeg');
  });

  it('refuses RTSP with the bridge to use instead, and anything that is not a link', () => {
    expect(() => checkIpUrl('rtsp://admin:pw@192.168.1.20:554/stream1')).toThrow('go2rtc or MediaMTX');
    expect(() => checkIpUrl('192.168.1.20')).toThrow('full link');
    expect(() => checkIpUrl('ftp://cam/a')).toThrow('http');
    expect(checkIpUrl(' http://192.168.1.20:8080/video ')).toBe('http://192.168.1.20:8080/video');
  });
});
