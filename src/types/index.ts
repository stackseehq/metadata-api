/**
 * Type definitions for the Favicon API
 */

export interface FaviconSource {
  url: string;
  size?: number;
  format?: string;
  source: 'link-tag' | 'manifest' | 'fallback' | 'fallback-api';
  score: number;
}

export interface ImageInfo {
  url: string; // API URL to fetch this exact processed image
  sourceUrl: string; // Original image URL from the website
  width: number;
  height: number;
  format: string;
  bytes: number; // File size in bytes
  source: string;
}

export interface PageMetadata {
  title?: string; // Page title from og:title, twitter:title, or <title>
  description?: string; // Page description from meta tags
  siteName?: string; // og:site_name
}

export interface FaviconResult {
  favicon: ImageInfo;
  ogImage?: ImageInfo;
  metadata: PageMetadata;
}

export interface ImageProcessOptions {
  size?: number;
  format?: 'png' | 'jpg' | 'jpeg' | 'ico' | 'webp' | 'svg';
  quality?: number;
}

export interface ProcessedImage {
  data: Buffer;
  format: string;
  width: number;
  height: number;
  bytes: number; // File size in bytes
}

export type OutputFormat = 'image' | 'json';

/**
 * Web App Manifest types
 */
export interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export interface WebManifest {
  icons?: ManifestIcon[];
  name?: string;
  short_name?: string;
  [key: string]: unknown;
}

/**
 * OpenGraph Image types
 */
export interface OGImageSource {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
  source: 'og:image' | 'twitter:image' | 'schema.org' | 'fallback';
  score: number;
}

export interface OGImageResult {
  url: string; // API URL to fetch this exact processed image
  sourceUrl: string; // Original OG image URL from the website
  title?: string; // og:title or twitter:title
  description?: string; // og:description or twitter:description
  width: number;
  height: number;
  format: string;
  bytes: number; // File size in bytes
  source: string;
  siteName?: string; // og:site_name
}
