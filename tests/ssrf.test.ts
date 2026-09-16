import { describe, expect, it } from 'vitest';
import {
  assertResolvesPublicly,
  assessUrl,
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  parseIPv4,
} from '../src/lib/ssrf';

describe('ssrf: scheme and port', () => {
  it('should accept an ordinary https URL', () => {
    const v = assessUrl('https://en.wikipedia.org/wiki/Cavendish_experiment');
    expect(v.ok).toBe(true);
  });

  it('should refuse non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'data:text/plain,hi']) {
      const v = assessUrl(url);
      expect(v.ok).toBe(false);
    }
  });

  it('should refuse ports other than 80 and 443', () => {
    expect(assessUrl('http://example.com:22/').ok).toBe(false);
    expect(assessUrl('http://example.com:6379/').ok).toBe(false);
    expect(assessUrl('http://example.com:80/').ok).toBe(true);
    expect(assessUrl('https://example.com:443/').ok).toBe(true);
  });

  it('should refuse a malformed URL with a readable message', () => {
    const v = assessUrl('not a url');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('http');
  });
});

describe('ssrf: hostnames and literal addresses', () => {
  it('should refuse localhost in every spelling', () => {
    for (const h of ['http://localhost/', 'http://LOCALHOST/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://[::1]/']) {
      expect(assessUrl(h).ok).toBe(false);
    }
  });

  it('should refuse the cloud metadata endpoints', () => {
    expect(assessUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(assessUrl('http://metadata.google.internal/').ok).toBe(false);
  });

  it('should refuse every private IPv4 range', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '127.5.5.5']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('should allow ordinary public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('should refuse IPv6 loopback, unique-local, link-local and multicast', () => {
    expect(isBlockedIPv6('::1')).toBe(true);
    expect(isBlockedIPv6('fd00::1')).toBe(true);
    expect(isBlockedIPv6('fe80::1')).toBe(true);
    expect(isBlockedIPv6('ff02::1')).toBe(true);
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('should unwrap IPv4-mapped IPv6 rather than letting it through', () => {
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIPv6('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIPv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('should parse dotted quads strictly', () => {
    expect(parseIPv4('192.168.0.1')).toEqual([192, 168, 0, 1]);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('example.com')).toBeNull();
    expect(isBlockedIPv4([169, 254, 169, 254])).toBe(true);
  });
});

describe('ssrf: DNS resolution', () => {
  it('should refuse a public name that resolves to a private address', async () => {
    await expect(
      assertResolvesPublicly('evil.example.com', async () => [{ address: '127.0.0.1' }]),
    ).rejects.toThrow(/private or reserved/);
  });

  it('should refuse when ANY answer is private, not only when all are', async () => {
    await expect(
      assertResolvesPublicly('rebind.example.com', async () => [
        { address: '93.184.216.34' },
        { address: '169.254.169.254' },
      ]),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('should allow a name that resolves only to public addresses', async () => {
    await expect(
      assertResolvesPublicly('example.com', async () => [{ address: '93.184.216.34' }]),
    ).resolves.toBeUndefined();
  });

  it('should refuse a name that does not resolve at all', async () => {
    await expect(assertResolvesPublicly('nx.example', async () => [])).rejects.toThrow(/did not resolve/);
    await expect(
      assertResolvesPublicly('nx.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/Could not resolve/);
  });
});
