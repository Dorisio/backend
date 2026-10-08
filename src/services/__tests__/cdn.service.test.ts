import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CDNService, type CDNConfig, DEFAULT_CACHE_RULES } from '../cdn.service';

describe('CDNService', () => {
  let service: CDNService;
  let config: CDNConfig;

  beforeEach(() => {
    config = {
      provider: 'cloudflare',
      baseUrl: 'https://cdn.example.com',
      zoneId: 'test-zone-id',
      apiToken: 'test-api-token',
      enableCaching: true,
      cacheTTL: 86400,
      enableCompression: true,
    };
    service = new CDNService(config);
  });

  describe('Asset URL Generation', () => {
    it('should generate asset URL without hash when no content provided', () => {
      const url = service.generateAssetUrl('/images/logo.png');

      expect(url).toMatch(/^https:\/\/cdn\.example\.com\/images\/logo\.\w+\.png$/);
    });

    it('should generate asset URL with content hash', () => {
      const content = Buffer.from('test content');
      const url = service.generateAssetUrl('/styles/main.css', content);

      expect(url).toContain('cdn.example.com');
      expect(url).toMatch(/\/styles\/main\.\w{8}\.css$/);
    });

    it('should return plain URL when caching disabled', () => {
      const noCacheService = new CDNService({ ...config, enableCaching: false });
      const url = noCacheService.generateAssetUrl('/test.js');

      expect(url).toBe('https://cdn.example.com/test.js');
    });

    it('should return plain URL when provider is none', () => {
      const noCdnService = new CDNService({ ...config, provider: 'none' });
      const url = noCdnService.generateAssetUrl('/test.js');

      expect(url).toBe('https://cdn.example.com/test.js');
    });
  });

  describe('Hash Generation', () => {
    it('should generate consistent hash for same content', () => {
      const content = 'test content';
      const hash1 = service.generateHash(content);
      const hash2 = service.generateHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(8);
    });

    it('should generate different hashes for different content', () => {
      const hash1 = service.generateHash('content 1');
      const hash2 = service.generateHash('content 2');

      expect(hash1).not.toBe(hash2);
    });

    it('should support custom hash length', () => {
      const hash = service.generateHash('test', 16);

      expect(hash).toHaveLength(16);
    });

    it('should work with Buffer content', () => {
      const buffer = Buffer.from('test content');
      const hash = service.generateHash(buffer);

      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(8);
    });
  });

  describe('Cache TTL Rules', () => {
    it('should return forever cache for hashed JS files', () => {
      const ttl = service.getCacheTTL('/js/app.abc12345.js');

      expect(ttl).toBe(31536000); // 1 year
    });

    it('should return forever cache for hashed CSS files', () => {
      const ttl = service.getCacheTTL('/css/style.xyz98765.css');

      expect(ttl).toBe(31536000);
    });

    it('should return 1 month for regular JS files', () => {
      const ttl = service.getCacheTTL('/js/app.js');

      expect(ttl).toBe(2592000); // 1 month
    });

    it('should return 1 week for images', () => {
      const ttl = service.getCacheTTL('/images/photo.jpg');

      expect(ttl).toBe(604800); // 1 week
    });

    it('should return 0 for API endpoints', () => {
      const ttl = service.getCacheTTL('/api/users');

      expect(ttl).toBe(0);
    });

    it('should return default TTL for unknown paths', () => {
      const ttl = service.getCacheTTL('/unknown/path');

      expect(ttl).toBe(config.cacheTTL);
    });

    it('should handle versioned paths', () => {
      const ttl = service.getCacheTTL('/v1/styles/main.css');

      expect(ttl).toBe(31536000);
    });
  });

  describe('Immutable Cache Detection', () => {
    it('should detect immutable hashed assets', () => {
      expect(service.isImmutable('/js/app.abc123.js')).toBe(true);
      expect(service.isImmutable('/css/style.xyz789.css')).toBe(true);
      expect(service.isImmutable('/images/logo.hash12.png')).toBe(true);
    });

    it('should detect non-immutable assets', () => {
      expect(service.isImmutable('/js/app.js')).toBe(false);
      expect(service.isImmutable('/images/photo.jpg')).toBe(false);
    });

    it('should detect versioned paths as immutable', () => {
      expect(service.isImmutable('/v1/assets/file.js')).toBe(true);
      expect(service.isImmutable('/v2/images/icon.png')).toBe(true);
    });
  });

  describe('Cache-Control Headers', () => {
    it('should generate correct header for immutable assets', () => {
      const header = service.getCacheControlHeader('/js/app.abc123.js');

      expect(header).toContain('public');
      expect(header).toContain('max-age=31536000');
      expect(header).toContain('immutable');
      expect(header).toContain('s-maxage=31536000');
    });

    it('should generate correct header for regular assets', () => {
      const header = service.getCacheControlHeader('/images/photo.jpg');

      expect(header).toContain('public');
      expect(header).toContain('max-age=604800');
      expect(header).not.toContain('immutable');
    });

    it('should generate no-cache header for API endpoints', () => {
      const header = service.getCacheControlHeader('/api/users');

      expect(header).toBe('no-cache, no-store, must-revalidate');
    });
  });

  describe('Cache Purging', () => {
    it('should skip purge when caching disabled', async () => {
      const noCacheService = new CDNService({ ...config, enableCaching: false });
      const result = await noCacheService.purgeCache(['/test.js']);

      expect(result).toBe(true);
    });

    it('should skip purge when provider is none', async () => {
      const noCdnService = new CDNService({ ...config, provider: 'none' });
      const result = await noCdnService.purgeCache(['/test.js']);

      expect(result).toBe(true);
    });

    it('should fail purge when CloudFlare credentials missing', async () => {
      const noCredsService = new CDNService({ ...config, zoneId: undefined });
      const result = await noCredsService.purgeCache(['/test.js']);

      expect(result).toBe(false);
    });

    it('should succeed for CloudFront (placeholder)', async () => {
      const cloudFrontService = new CDNService({
        ...config,
        provider: 'cloudfront',
        distributionId: 'test-dist-id',
      });

      const result = await cloudFrontService.purgeCache(['/test.js']);

      // Placeholder returns true
      expect(result).toBe(true);
    });
  });

  describe('Metrics Tracking', () => {
    it('should record cache hits', () => {
      service.recordRequest(true);
      service.recordRequest(true);
      service.recordRequest(false);

      const metrics = service.getMetrics();

      expect(metrics.requests).toBe(3);
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should calculate hit rate correctly', () => {
      for (let i = 0; i < 80; i++) service.recordRequest(true);
      for (let i = 0; i < 20; i++) service.recordRequest(false);

      const metrics = service.getMetrics();

      expect(metrics.hitRate).toBe(0.8);
    });

    it('should handle zero requests', () => {
      const metrics = service.getMetrics();

      expect(metrics.requests).toBe(0);
      expect(metrics.hitRate).toBe(0);
    });

    it('should reset metrics', () => {
      service.recordRequest(true);
      service.recordRequest(true);

      service.resetMetrics();
      const metrics = service.getMetrics();

      expect(metrics.requests).toBe(0);
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
      expect(metrics.hitRate).toBe(0);
    });
  });

  describe('Service Configuration', () => {
    it('should return correct provider', () => {
      expect(service.getProvider()).toBe('cloudflare');
    });

    it('should report enabled status', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should report disabled when caching off', () => {
      const disabledService = new CDNService({ ...config, enableCaching: false });

      expect(disabledService.isEnabled()).toBe(false);
    });

    it('should report disabled when provider is none', () => {
      const noCdnService = new CDNService({ ...config, provider: 'none' });

      expect(noCdnService.isEnabled()).toBe(false);
    });
  });

  describe('Cache Rules', () => {
    it('should have rules for all common asset types', () => {
      const extensions = [
        'js',
        'css',
        'jpg',
        'png',
        'gif',
        'webp',
        'svg',
        'woff',
        'woff2',
        'ttf',
        'mp4',
      ];

      extensions.forEach((ext) => {
        const ttl = service.getCacheTTL(`/assets/file.${ext}`);
        expect(ttl).toBeGreaterThan(0);
      });
    });

    it('should prioritize more specific rules', () => {
      // Hashed asset should use forever cache, not regular JS cache
      const hashedTTL = service.getCacheTTL('/js/app.abc123.js');
      const regularTTL = service.getCacheTTL('/js/app.js');

      expect(hashedTTL).toBeGreaterThan(regularTTL);
    });
  });
});
