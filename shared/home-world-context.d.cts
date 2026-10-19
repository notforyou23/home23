export interface HomeWeatherReading { value: number; unit: string; observedAt: string; cardinal?: string }
export interface HomeBayTideEvent { time: string; height: number }
export interface HomeBayFeed {
  schema?: string; place?: string;
  station?: { id: string; name: string; source?: string };
  status: 'fresh' | 'stale' | 'unavailable';
  checkedAt: string | null;
  tide?: { datum: string; unit: string; nextHigh?: HomeBayTideEvent; nextLow?: HomeBayTideEvent };
  bayWind?: { speedMph: number; directionDeg: number; cardinal: string; observedAt: string; source?: string };
  moon?: { illuminated: number; phase: string };
  reason?: string;
}
export interface HomeWorldContext {
  now: string; timezone: string | null; localTime: string; localHour: number | null; localDay: string | null;
  weather: { status: 'fresh' | 'stale' | 'unavailable'; source: string; tileId?: string; observedAt: string | null; checkedAt: string | null; readings: Record<string, HomeWeatherReading>; reason?: string };
  bay: HomeBayFeed;
}
export const READING_NAMES: string[];
export function readHomeWorldContext(options?: { home23Root?: string; timezone?: string; now?: Date }): HomeWorldContext;
export function formatHomeWorldContext(context: HomeWorldContext): string;
export function weatherSnapshot(options: { tileId: string; weather?: unknown; failed?: boolean; now?: Date }): unknown;
export function publishHomeWeather(options: { home23Root: string; tileId: string; weather?: unknown; failed?: boolean; now?: Date }): unknown;
