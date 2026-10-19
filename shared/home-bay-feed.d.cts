export const SCHEMA: 'home23.bay-feed.v1';
export const PLACE: string;
export const STATION_ID: string;
export const STATION_NAME: string;
export const TIDE_TTL_MS: number;
export const WIND_TTL_MS: number;
export function bayPath(root: string): string;
export function cardinalFromDegrees(deg: number): string | null;
export function moonAt(date?: Date): { illuminated: number; phase: string };
export function selectNextTides(predictions: unknown, now?: Date): {
  nextHigh: { time: string; height: number } | null;
  nextLow: { time: string; height: number } | null;
};
export function parseNoaaTime(value: string): string | null;
export function tideUrl(now: Date): string;
export function windUrl(): string;
export function readHomeBay(options?: { home23Root?: string; now?: Date }): import('./home-world-context.d.cts').HomeBayFeed;
export function refreshHomeBay(options: { home23Root: string; now?: Date; fetchImpl?: typeof fetch }): Promise<import('./home-world-context.d.cts').HomeBayFeed>;
export function formatHomeBay(bay: import('./home-world-context.d.cts').HomeBayFeed): string;
