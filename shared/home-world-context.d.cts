export interface HomeWeatherReading { value: number; unit: string; observedAt: string }
export interface HomeWorldContext {
  now: string; timezone: string | null; localTime: string; localHour: number | null; localDay: string | null;
  weather: { status: 'fresh' | 'stale' | 'unavailable'; source: string; tileId?: string; observedAt: string | null; checkedAt: string | null; readings: Record<string, HomeWeatherReading>; reason?: string };
}
export function readHomeWorldContext(options?: { home23Root?: string; timezone?: string; now?: Date }): HomeWorldContext;
export function formatHomeWorldContext(context: HomeWorldContext): string;
export function weatherSnapshot(options: { tileId: string; weather?: unknown; failed?: boolean; now?: Date }): unknown;
export function publishHomeWeather(options: { home23Root: string; tileId: string; weather?: unknown; failed?: boolean; now?: Date }): unknown;
