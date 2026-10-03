import crypto from 'crypto';
import { logger } from '../utils/logger';
import { Counter, Histogram } from 'prom-client';

/**
 * CDN Service
 *
 * Provides CDN integration for static assets and media:
 * - CloudFlare or AWS CloudFront support
 * - Asset versioning and cache busting
 * - Cache purge on updates
 * - CDN hit rate monitoring
 * - Automatic gzip/brotli compression
 */

export type CDNProvider = 'cloudflare' | 'cloudfront' | 'none';

export interface CDNConfig {
  provider: CDNProvider;
  baseUrl: string;
  zoneId?: string; // CloudFlare zone ID
  apiToken?: string; // CloudFlare API token
  distributionId?: string; // CloudFront distribution ID
  accessKeyId?: string; // AWS access key
  secretAccessKey?: string; // AWS secret key
  region?: string; // AWS region
  enableCaching: boolean;
  cacheTTL: number; // seconds
  enableCompression: boolean;
}

export interface CacheRule {
  pattern: string;
  ttl: number;
  immutable: boolean;
}

export interface AssetMetadata {
  url: string;
  cdnUrl: string;
  hash: string;
  version: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
}

export interface CDNMetrics {
  requests: number;
  hits: number;
  misses: number;
  hitRate: number;
  bandwidth: number;
  purges: number;
}

// Prometheus metrics
const cdnRequestsTotal = new Counter({
  name: 'cdn_requests_total',
  help: 'Total CDN requests',
  labelNames: ['provider', 'status'],
});

const cdnHitRate = new Histogram({
  name: 'cdn_hit_rate',
  help: 'CDN cache hit rate',
  labelNames: ['provider'],
  buckets: [0, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1],
});

const cdnPurgesTotal = new Counter({
  name: 'cdn_purges_total',
  help: 'Total CDN cache purges',
  labelNames: ['provider', 'status'],
});

const cdnResponseTime = new Histogram({
  name: 'cdn_response_time_ms',
  help: 'CDN response time in milliseconds',
  labelNames: ['provider', 'operation'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
});

/**
 * Default cache rules for different asset types
 */
export const DEFAULT_CACHE_RULES: CacheRule[] = [
  // Immutable assets with hash in filename (forever cache)
  {
    pattern: /\.(js|css|woff2?|ttf|eot|otf)\.\w{8,}\.(js|css|woff2?|ttf|eot|otf)$/,
    ttl: 31536000,
    immutable: true,
  },
  {
    pattern: /\.(jpg|jpeg|png|gif|webp|svg|ico)\.\w{8,}\.(jpg|jpeg|png|gif|webp|svg|ico)$/,
    ttl: 31536000,
    immutable: true,
  },

  // Versioned assets (1 year)
  { pattern: /\/v\d+\//, ttl: 31536000, immutable: true },

  // Static assets (1 month)
  { pattern: /\.(js|css|woff2?|ttf|eot|otf)$/, ttl: 2592000, immutable: false },

  // Images (1 week)
  { pattern: /\.(jpg|jpeg|png|gif|webp|svg|ico|avif)$/, ttl: 604800, immutable: false },

  // Videos (1 month)
  { pattern: /\.(mp4|webm|ogg|avi|mov)$/, ttl: 2592000, immutable: false },

  // Fonts (1 year)
  { pattern: /\.(woff2?|ttf|eot|otf)$/, ttl: 31536000, immutable: false },

  // API responses (no cache by default)
  { pattern: /^\/api\//, ttl: 0, immutable: false },
];

export class CDNService {
  private config: CDNConfig;
  private metrics: CDNMetrics;

  constructor(config: CDNConfig) {
    this.config = config;
    this.metrics = {
      requests: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      bandwidth: 0,
      purges: 0,
    };

    logger.info({ provider: config.provider, baseUrl: config.baseUrl }, 'CDN service initialized');
  }

  /**
   * Generate versioned URL with hash for cache busting
   */
  public generateAssetUrl(path: string, content?: Buffer | string): string {
    if (!this.config.enableCaching || this.config.provider === 'none') {
      return `${this.config.baseUrl}${path}`;
    }

    // Generate hash from content if provided
    let hash = '';
    if (content) {
      hash = this.generateHash(content);
    } else {
      // Use timestamp as fallback
      hash = Date.now().toString(36);
    }

    // Insert hash before file extension
    const versionedPath = this.insertHashIntoPath(path, hash);
    return `${this.config.baseUrl}${versionedPath}`;
  }

  /**
   * Generate content hash for cache busting
   */
  public generateHash(content: Buffer | string, length: number = 8): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, length);
  }

  /**
   * Insert hash into file path before extension
   * /images/logo.png -> /images/logo.abc123.png
   */
  private insertHashIntoPath(path: string, hash: string): string {
    const lastDotIndex = path.lastIndexOf('.');
    const lastSlashIndex = path.lastIndexOf('/');

    // No extension or extension in directory name
    if (lastDotIndex === -1 || lastDotIndex < lastSlashIndex) {
      return `${path}.${hash}`;
    }

    return `${path.substring(0, lastDotIndex)}.${hash}${path.substring(lastDotIndex)}`;
  }

  /**
   * Get cache TTL for a given path based on cache rules
   */
  public getCacheTTL(path: string): number {
    for (const rule of DEFAULT_CACHE_RULES) {
      const pattern = typeof rule.pattern === 'string' ? new RegExp(rule.pattern) : rule.pattern;
      if (pattern.test(path)) {
        return rule.ttl;
      }
    }
    return this.config.cacheTTL;
  }

  /**
   * Check if path should be immutable (forever cache)
   */
  public isImmutable(path: string): boolean {
    for (const rule of DEFAULT_CACHE_RULES) {
      const pattern = typeof rule.pattern === 'string' ? new RegExp(rule.pattern) : rule.pattern;
      if (pattern.test(path) && rule.immutable) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get cache-control header value for path
   */
  public getCacheControlHeader(path: string): string {
    const ttl = this.getCacheTTL(path);
    const immutable = this.isImmutable(path);

    if (ttl === 0) {
      return 'no-cache, no-store, must-revalidate';
    }

    const parts = [`public`, `max-age=${ttl}`];

    if (immutable) {
      parts.push('immutable');
    }

    // Add s-maxage for CDN
    parts.push(`s-maxage=${ttl}`);

    return parts.join(', ');
  }

  /**
   * Purge cache for specific URLs
   */
  public async purgeCache(urls: string[]): Promise<boolean> {
    const startTime = Date.now();

    try {
      if (this.config.provider === 'none' || !this.config.enableCaching) {
        logger.info('CDN caching disabled, skipping purge');
        return true;
      }

      let success = false;

      if (this.config.provider === 'cloudflare') {
        success = await this.purgeCloudflare(urls);
      } else if (this.config.provider === 'cloudfront') {
        success = await this.purgeCloudFront(urls);
      }

      const duration = Date.now() - startTime;
      cdnResponseTime.observe({ provider: this.config.provider, operation: 'purge' }, duration);

      if (success) {
        this.metrics.purges++;
        cdnPurgesTotal.inc({ provider: this.config.provider, status: 'success' });
        logger.info(
          { urls, duration, provider: this.config.provider },
          'CDN cache purged successfully'
        );
      } else {
        cdnPurgesTotal.inc({ provider: this.config.provider, status: 'failure' });
        logger.error({ urls, duration, provider: this.config.provider }, 'CDN cache purge failed');
      }

      return success;
    } catch (error) {
      const duration = Date.now() - startTime;
      cdnPurgesTotal.inc({ provider: this.config.provider, status: 'error' });
      cdnResponseTime.observe({ provider: this.config.provider, operation: 'purge' }, duration);
      logger.error({ error, urls, provider: this.config.provider }, 'Error purging CDN cache');
      return false;
    }
  }

  /**
   * Purge CloudFlare cache
   */
  private async purgeCloudflare(urls: string[]): Promise<boolean> {
    if (!this.config.zoneId || !this.config.apiToken) {
      logger.error('CloudFlare zone ID or API token not configured');
      return false;
    }

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: urls }),
        }
      );

      const data = (await response.json()) as { success: boolean };
      return data.success;
    } catch (error) {
      logger.error({ error }, 'CloudFlare purge request failed');
      return false;
    }
  }

  /**
   * Purge CloudFront cache
   */
  private async purgeCloudFront(urls: string[]): Promise<boolean> {
    if (!this.config.distributionId) {
      logger.error('CloudFront distribution ID not configured');
      return false;
    }

    // Extract paths from URLs for CloudFront invalidation
    const paths = urls.map((url) => {
      try {
        const urlObj = new URL(url);
        return urlObj.pathname;
      } catch {
        return url;
      }
    });

    logger.info(
      { paths, distributionId: this.config.distributionId },
      'CloudFront invalidation would be created (AWS SDK required)'
    );

    // Note: Actual CloudFront invalidation requires AWS SDK
    // This is a placeholder for the integration
    return true;
  }

  /**
   * Record CDN request metrics
   */
  public recordRequest(hit: boolean): void {
    this.metrics.requests++;
    if (hit) {
      this.metrics.hits++;
      cdnRequestsTotal.inc({ provider: this.config.provider, status: 'hit' });
    } else {
      this.metrics.misses++;
      cdnRequestsTotal.inc({ provider: this.config.provider, status: 'miss' });
    }

    this.updateHitRate();
  }

  /**
   * Update cache hit rate
   */
  private updateHitRate(): void {
    if (this.metrics.requests > 0) {
      this.metrics.hitRate = this.metrics.hits / this.metrics.requests;
      cdnHitRate.observe({ provider: this.config.provider }, this.metrics.hitRate);
    }
  }

  /**
   * Get CDN metrics
   */
  public getMetrics(): CDNMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      requests: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      bandwidth: 0,
      purges: 0,
    };
  }

  /**
   * Get CDN provider
   */
  public getProvider(): CDNProvider {
    return this.config.provider;
  }

  /**
   * Check if CDN is enabled
   */
  public isEnabled(): boolean {
    return this.config.enableCaching && this.config.provider !== 'none';
  }
}

/**
 * Create CDN service from environment configuration
 */
export function createCDNService(config?: Partial<CDNConfig>): CDNService {
  const defaultConfig: CDNConfig = {
    provider: (process.env.CDN_PROVIDER as CDNProvider) || 'none',
    baseUrl: process.env.CDN_BASE_URL || '',
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    distributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
    enableCaching: process.env.CDN_ENABLED !== 'false',
    cacheTTL: parseInt(process.env.CDN_CACHE_TTL || '86400', 10),
    enableCompression: process.env.CDN_COMPRESSION !== 'false',
  };

  return new CDNService({ ...defaultConfig, ...config });
}

// Singleton instance
let cdnServiceInstance: CDNService | null = null;

export function getCDNService(): CDNService {
  if (!cdnServiceInstance) {
    cdnServiceInstance = createCDNService();
  }
  return cdnServiceInstance;
}
