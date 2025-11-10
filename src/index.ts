/**
 * Main Hono application
 * Handles API routes and request processing
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppConfig } from './lib/config';
import type { FaviconResult, OGImageResult, ImageInfo, OutputFormat } from './types';
import { fetchBestFavicon } from './lib/favicon-finder';
import { fetchBestOGImage } from './lib/og-finder';
import { analyzePage } from './lib/page-analyzer';
import { processImage } from './lib/image-processor';
import { queryParamsSchema } from './lib/validators';
import {
  generateSuccessHeaders,
  generateDefaultHeaders,
  generateErrorHeaders,
} from './lib/http-headers';
import { getContentTypeFromFormat } from './lib/format-detector';
import { logRequest, logFaviconFetch, logger } from './lib/logger';
import { getClientIp } from './lib/request-ip';
import { getCachedFallback, fetchCustomDefault } from './lib/fallback-image';

export function createApp(config: AppConfig) {
  const app = new Hono();

  // CORS middleware
  app.use(
    '*',
    cors({
      origin: config.ALLOWED_ORIGINS === '*' ? '*' : config.ALLOWED_ORIGINS.split(','),
    })
  );

  // Request logging middleware
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;

    // Log request
    logRequest({
      method: c.req.method,
      path: c.req.path,
      query: Object.fromEntries(new URL(c.req.url).searchParams),
      statusCode: c.res.status,
      responseTime: duration,
      userAgent: c.req.header('user-agent'),
      ip: getClientIp(c) || undefined,
    });
  });

  // Health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Root endpoint - redirect to documentation when no path param or query params
  app.get('/', async (c) => {
    const url = new URL(c.req.url);
    // Check if there are no query parameters
    if (url.search === '' || url.searchParams.toString() === '') {
      // If REDIRECT_URL is configured, redirect to it
      if (config.REDIRECT_URL) {
        return c.redirect(config.REDIRECT_URL, 302);
      }
      // Otherwise, return 400 error for self-hosters
      const headers = generateErrorHeaders(config);
      return c.json({ error: 'Domain parameter is required' }, 400, headers);
    }

    // If there are query params but no URL, return fallback image
    try {
      const schema = queryParamsSchema(config.BLOCK_PRIVATE_IPS);
      const parseResult = schema.safeParse({
        url: undefined, // No URL provided
        response: c.req.query('response'),
        size: c.req.query('size'),
        format: c.req.query('format'),
        default: c.req.query('default'),
      });

      // If validation fails, just use defaults
      const response = (parseResult.success ? parseResult.data.response : 'image') as OutputFormat;
      const defaultImage = parseResult.success ? parseResult.data.default : undefined;
      const size = parseResult.success ? parseResult.data.size : undefined;
      const format = parseResult.success ? parseResult.data.format : undefined;

      return await handleFallback(c, config, response, defaultImage, size, format);
    } catch (error) {
      logger.error({ err: error }, 'Error processing root request with query params');
      const headers = generateErrorHeaders(config);
      return c.json({ error: 'Internal server error' }, 500, headers);
    }
  });

  // OpenGraph image endpoint - uses /og/ prefix
  app.get('/og/:url{.+}', async (c) => {
    try {
      // Extract request headers for analytics
      const requestHeaders = {
        origin: c.req.header('origin'),
        referer: c.req.header('referer'),
        ip: getClientIp(c) || undefined,
      };

      // Get URL from path parameter
      const urlParam = c.req.param('url');

      // Validate query parameters with Zod
      const schema = queryParamsSchema(config.BLOCK_PRIVATE_IPS);
      const parseResult = schema.safeParse({
        url: urlParam,
        response: c.req.query('response'),
        size: c.req.query('size'),
        format: c.req.query('format'),
        default: c.req.query('default'),
        skipFallback: c.req.query('skipFallback'),
      });

      // Handle validation errors
      if (!parseResult.success) {
        const headers = generateErrorHeaders(config);
        const firstError = parseResult.error.issues[0];
        const errorMessage = firstError ? firstError.message : 'Invalid request parameters';
        return c.json({ error: errorMessage }, 400, headers);
      }

      const { url, response, size, format, default: defaultImage, skipFallback } = parseResult.data;

      // Analyze page to get OG images and metadata
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), config.REQUEST_TIMEOUT)
      );
      const ogStart = Date.now();
      const result = await Promise.race([
        new Promise<
          | {
              image: { data: Buffer; format: string; source: string; url: string; isFallback?: boolean };
              metadata: { title?: string; description?: string; siteName?: string };
            }
          | null
        >(
          // oxlint-disable-next-line no-async-promise-executor
          async (resolve) => {
            try {
              // Single HTML fetch
              const pageData = await analyzePage(url, config);
              if (pageData.ogImages == null || pageData.ogImages.length === 0) {
                resolve(null);
              } else {
                const image = await fetchBestOGImage(pageData.ogImages, config);
                resolve(image ? { image, metadata: pageData.metadata } : null);
              }
            } catch {
              resolve(null);
            }
          }
        ),
        timeoutPromise,
      ]);

      if (!result || !result.image || !result.image.data) {
        logFaviconFetch({
          url,
          faviconUrl: result?.image?.url,
          source: result?.image?.source,
          response,
          format: result?.image?.format || format,
          size,
          success: false,
          duration: Date.now() - ogStart,
          error: 'Failed to fetch OG image',
          headers: requestHeaders,
        });

        // If skipFallback is enabled and no OG image found, return 404
        if (skipFallback) {
          const headers = generateErrorHeaders(config);
          if (response === 'json') {
            return c.json({ error: 'No OG image found (fallback skipped)' }, 404, headers);
          }
          return c.body(null, 404, headers);
        }

        return handleFallback(c, config, response, defaultImage, size, format);
      }

      const { image, metadata } = result;

      // If skipFallback is enabled and the image is a fallback, return 404
      if (skipFallback && image.isFallback) {
        const headers = generateErrorHeaders(config);
        if (response === 'json') {
          return c.json({ error: 'No OG image found (fallback skipped)' }, 404, headers);
        }
        return c.body(null, 404, headers);
      }

      // Log successful OG image fetch
      logFaviconFetch({
        url,
        faviconUrl: image.url,
        response,
        size,
        source: image.source,
        format: image.format,
        success: true,
        duration: Date.now() - ogStart,
        headers: requestHeaders,
      });

      // Process image if needed
      const processed = await processImage(image.data, {
        size,
        format,
      });

      // Return response based on response type
      if (response === 'json') {
        // Build API URL for the processed image
        const requestUrl = new URL(c.req.url);
        const apiUrl = new URL(requestUrl.origin + '/og/' + (c.req.param('url') || url));
        if (size) {
          apiUrl.searchParams.set('size', size.toString());
        }
        if (format) {
          apiUrl.searchParams.set('format', format);
        }

        const ogResult: OGImageResult = {
          url: apiUrl.toString(),
          sourceUrl: image?.url || 'unknown',
          title: metadata.title,
          description: metadata.description,
          siteName: metadata.siteName,
          width: processed.width,
          height: processed.height,
          format: processed.format,
          bytes: processed.bytes,
          source: image.source,
          isFallback: image.isFallback,
        };

        const headers = generateSuccessHeaders(config, processed.data);
        return c.json(ogResult, 200, headers);
      }

      // Return image
      const headers = generateSuccessHeaders(config, processed.data);
      const contentType = getContentTypeFromFormat(processed.format);

      return c.body(new Uint8Array(processed.data), 200, {
        ...headers,
        'Content-Type': contentType,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error processing OG image request');
      const headers = generateErrorHeaders(config);
      return c.json({ error: 'Internal server error' }, 500, headers);
    }
  });

  // Main favicon endpoint - uses path parameter for URL
  app.get('/:url{.+}', async (c) => {
    try {
      // Extract request headers for analytics
      const requestHeaders = {
        origin: c.req.header('origin'),
        referer: c.req.header('referer'),
        ip: getClientIp(c) || undefined,
      };

      // Get URL from path parameter
      const urlParam = c.req.param('url');

      // Validate query parameters with Zod
      const schema = queryParamsSchema(config.BLOCK_PRIVATE_IPS);
      const parseResult = schema.safeParse({
        url: urlParam,
        response: c.req.query('response'),
        size: c.req.query('size'),
        format: c.req.query('format'),
        default: c.req.query('default'),
        skipFallback: c.req.query('skipFallback'),
      });

      // Handle validation errors
      if (!parseResult.success) {
        const headers = generateErrorHeaders(config);
        const firstError = parseResult.error.issues[0];
        const errorMessage = firstError ? firstError.message : 'Invalid request parameters';
        return c.json({ error: errorMessage }, 400, headers);
      }

      const { url, response, size, format, default: defaultImage, skipFallback } = parseResult.data;

      // Analyze page once to get favicons, OG images, and metadata
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), config.REQUEST_TIMEOUT)
      );
      const fetchStart = Date.now();
      const result = await Promise.race([
        new Promise<
          | {
              favicon: { data: Buffer; format: string; source: string; url: string; isFallback?: boolean } | null;
              ogImage: { data: Buffer; format: string; source: string; url: string; isFallback?: boolean } | null;
              metadata: { title?: string; description?: string; siteName?: string };
            }
          | null
        >(
          // oxlint-disable-next-line no-async-promise-executor
          async (resolve) => {
            try {
              // Single HTML fetch - extracts everything in one pass
              const pageData = await analyzePage(url, config, size);

              // Fetch best images from both sources in parallel
              const [favicon, ogImage] = await Promise.all([
                pageData.favicons.length > 0
                  ? fetchBestFavicon(pageData.favicons, config)
                  : null,
                pageData.ogImages.length > 0
                  ? fetchBestOGImage(pageData.ogImages, config)
                  : null,
              ]);

              resolve({ favicon, ogImage, metadata: pageData.metadata });
            } catch {
              resolve(null);
            }
          }
        ),
        timeoutPromise,
      ]);

      if (!result || !result.favicon || !result.favicon.data) {
        logFaviconFetch({
          url,
          faviconUrl: result?.favicon?.url,
          source: result?.favicon?.source,
          response,
          format: result?.favicon?.format || format,
          size,
          success: false,
          duration: Date.now() - fetchStart,
          error: 'Failed to fetch favicon',
          headers: requestHeaders,
        });
        return handleFallback(c, config, response, defaultImage, size, format);
      }

      const { favicon, ogImage, metadata } = result;

      // If skipFallback is enabled and the favicon is a fallback, return 404
      if (skipFallback && favicon.isFallback) {
        const headers = generateErrorHeaders(config);
        if (response === 'json') {
          return c.json({ error: 'No favicon found (fallback skipped)' }, 404, headers);
        }
        return c.body(null, 404, headers);
      }

      // Log successful favicon fetch
      logFaviconFetch({
        url,
        faviconUrl: favicon.url,
        response,
        size,
        source: favicon.source,
        format: favicon.format,
        success: true,
        duration: Date.now() - fetchStart,
        headers: requestHeaders,
      });

      // Process favicon image
      const processedFavicon = await processImage(favicon.data, {
        size,
        format,
      });

      // Return response based on response type
      if (response === 'json') {
        // Build API URLs
        const requestUrl = new URL(c.req.url);
        const faviconApiUrl = new URL(requestUrl.origin + '/' + (c.req.param('url') || url));
        if (size) {
          faviconApiUrl.searchParams.set('size', size.toString());
        }
        if (format) {
          faviconApiUrl.searchParams.set('format', format);
        }

        // Build favicon info
        const faviconInfo: ImageInfo = {
          url: faviconApiUrl.toString(),
          sourceUrl: favicon.url,
          width: processedFavicon.width,
          height: processedFavicon.height,
          format: processedFavicon.format,
          bytes: processedFavicon.bytes,
          source: favicon.source,
          isFallback: favicon.isFallback,
        };

        // Build OG image info if available
        let ogImageInfo: ImageInfo | undefined;
        if (ogImage) {
          const processedOG = await processImage(ogImage.data, {
            size,
            format,
          });

          const ogApiUrl = new URL(requestUrl.origin + '/og/' + (c.req.param('url') || url));
          if (size) {
            ogApiUrl.searchParams.set('size', size.toString());
          }
          if (format) {
            ogApiUrl.searchParams.set('format', format);
          }

          ogImageInfo = {
            url: ogApiUrl.toString(),
            sourceUrl: ogImage.url,
            width: processedOG.width,
            height: processedOG.height,
            format: processedOG.format,
            bytes: processedOG.bytes,
            source: ogImage.source,
            isFallback: ogImage.isFallback,
          };
        }

        const faviconResult: FaviconResult = {
          favicon: faviconInfo,
          ogImage: ogImageInfo,
          metadata: {
            title: metadata.title,
            description: metadata.description,
            siteName: metadata.siteName,
          },
        };

        const headers = generateSuccessHeaders(config, processedFavicon.data);
        return c.json(faviconResult, 200, headers);
      }

      // Return image (default behavior - just returns favicon)
      const headers = generateSuccessHeaders(config, processedFavicon.data);
      const contentType = getContentTypeFromFormat(processedFavicon.format);

      return c.body(new Uint8Array(processedFavicon.data), 200, {
        ...headers,
        'Content-Type': contentType,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error processing request');
      const headers = generateErrorHeaders(config);
      return c.json({ error: 'Internal server error' }, 500, headers);
    }
  });

  return app;
}

/**
 * Handle fallback when no favicon is found
 */
async function handleFallback(
  c: Context,
  config: AppConfig,
  response: OutputFormat,
  defaultImage?: string,
  size?: number,
  format?: 'png' | 'jpg' | 'jpeg' | 'ico' | 'webp' | 'svg'
) {
  try {
    let buffer: Buffer;
    let imageFormat: string;
    let sourceUrl: string;
    let width: number;
    let height: number;

    // If a custom default image URL is provided, fetch it
    if (defaultImage) {
      const customDefault = await fetchCustomDefault(defaultImage, config);
      buffer = customDefault.buffer;
      imageFormat = customDefault.format;
      sourceUrl = customDefault.sourceUrl;
      width = customDefault.width;
      height = customDefault.height;
    } else {
      // Use the cached fallback image
      const cachedFallback = getCachedFallback();
      buffer = cachedFallback.buffer;
      imageFormat = cachedFallback.format;
      sourceUrl = cachedFallback.sourceUrl;
      width = cachedFallback.width;
      height = cachedFallback.height;
    }

    // Process image if size or format is specified
    if (size || format) {
      const processed = await processImage(buffer, { size, format });
      buffer = processed.data;
      imageFormat = processed.format;
      width = processed.width;
      height = processed.height;
    }

    if (response === 'json') {
      // Build API URL for the default image
      const requestUrl = new URL(c.req.url);
      // Use original path parameter to preserve user input format
      const originalUrl = c.req.param('url');
      const apiUrl = new URL(requestUrl.origin + '/' + (originalUrl || ''));
      if (defaultImage) {
        apiUrl.searchParams.set('default', defaultImage);
      }

      const result: FaviconResult = {
        favicon: {
          url: apiUrl.toString(),
          sourceUrl,
          width,
          height,
          format: imageFormat,
          bytes: buffer.length,
          source: 'default',
          isFallback: true,
        },
        ogImage: undefined,
        metadata: {},
      };

      const headers = generateDefaultHeaders(config);
      return c.json(result, 200, headers);
    }

    const headers = generateDefaultHeaders(config);
    const contentType = imageFormat === 'svg' ? 'image/svg+xml' : 'image/png';
    return c.body(new Uint8Array(buffer), 200, {
      ...headers,
      'Content-Type': contentType,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching default image');
    const headers = generateErrorHeaders(config);
    return c.json({ error: 'Failed to fetch default image' }, 500, headers);
  }
}
