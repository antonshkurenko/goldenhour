import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DateTime } from 'luxon';
import { Sun, Moon, Sunrise, Sunset, Plus, X, Search, MapPin, Clock, GripVertical } from 'lucide-react';
import SunCalc from 'suncalc';
import { TIMEZONE_LIST, type TimezoneEntry } from './timezones';

// --- Types ---

interface City {
  id: string;
  name: string;
  timezone: string;
  lat?: number;
  lng?: number;
}

type ViewMode = 'auto' | 'compact' | 'beautiful';

// --- Constants ---

const STORAGE_KEY = 'golden_hour_config';
const HOURS_VISIBLE = 48;
const PX_PER_HOUR = 80;
const STRIP_WIDTH = HOURS_VISIBLE * PX_PER_HOUR;

const SKY_STOPS: Array<{ hour: number; color: [number, number, number] }> = [
  { hour: 0, color: [15, 23, 42] },      // #0F172A deep night
  { hour: 5, color: [30, 41, 59] },      // #1E293B night
  { hour: 5.5, color: [249, 115, 22] },  // #F97316 dawn orange
  { hour: 6.5, color: [253, 224, 71] },  // #FDE047 dawn gold
  { hour: 7, color: [253, 224, 71] },    // #FDE047 morning gold
  { hour: 12, color: [56, 189, 248] },   // #38BDF8 midday blue
  { hour: 17, color: [253, 224, 71] },   // #FDE047 afternoon gold
  { hour: 17.5, color: [251, 146, 60] }, // #FB923C dusk orange
  { hour: 19, color: [76, 29, 149] },    // #4C1D95 dusk purple
  { hour: 24, color: [15, 23, 42] },     // #0F172A deep night
];

// --- Utility Functions ---

function interpolateColor(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function colorForHour(hour: number): [number, number, number] {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    if (h >= SKY_STOPS[i].hour && h <= SKY_STOPS[i + 1].hour) {
      const range = SKY_STOPS[i + 1].hour - SKY_STOPS[i].hour;
      const t = range === 0 ? 0 : (h - SKY_STOPS[i].hour) / range;
      return interpolateColor(SKY_STOPS[i].color, SKY_STOPS[i + 1].color, t);
    }
  }
  return SKY_STOPS[0].color;
}

function rgbStr(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Sky colors
const DEEP_NIGHT: [number, number, number] = [15, 23, 42];
const TWILIGHT_INDIGO: [number, number, number] = [30, 20, 70];
const DAWN_RED: [number, number, number] = [160, 50, 50];
const DAWN_ORANGE: [number, number, number] = [249, 115, 22];
const GOLDEN: [number, number, number] = [253, 224, 71];
const SKY_BLUE: [number, number, number] = [56, 189, 248];
const DUSK_ORANGE: [number, number, number] = [251, 146, 60];
const DUSK_PURPLE: [number, number, number] = [76, 29, 149];

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function colorFromSunAltitude(altDeg: number, isAfternoon: boolean): [number, number, number] {
  if (isAfternoon) {
    // Dusk side: golden → orange → purple → night (no brown issue here)
    if (altDeg > 20) return SKY_BLUE;
    if (altDeg > 6) return interpolateColor(SKY_BLUE, GOLDEN, smoothstep((20 - altDeg) / 14));
    if (altDeg > 0) return interpolateColor(GOLDEN, DUSK_ORANGE, smoothstep((6 - altDeg) / 6));
    if (altDeg > -4) return interpolateColor(DUSK_ORANGE, DUSK_PURPLE, smoothstep(-altDeg / 4));
    if (altDeg > -8) return interpolateColor(DUSK_PURPLE, DEEP_NIGHT, smoothstep((-altDeg - 4) / 4));
    return DEEP_NIGHT;
  } else {
    // Dawn side: night → indigo → warm red → orange → golden → blue
    // (routed through reds/purples to avoid brown from blue→orange in RGB)
    if (altDeg > 20) return SKY_BLUE;
    if (altDeg > 6) return interpolateColor(GOLDEN, SKY_BLUE, smoothstep((altDeg - 6) / 14));
    if (altDeg > 0) return interpolateColor(DAWN_ORANGE, GOLDEN, smoothstep(altDeg / 6));
    if (altDeg > -2) return interpolateColor(DAWN_RED, DAWN_ORANGE, smoothstep((altDeg + 2) / 2));
    if (altDeg > -6) return interpolateColor(TWILIGHT_INDIGO, DAWN_RED, smoothstep((altDeg + 6) / 4));
    if (altDeg > -10) return interpolateColor(DEEP_NIGHT, TWILIGHT_INDIGO, smoothstep((altDeg + 10) / 4));
    return DEEP_NIGHT;
  }
}

function generateSkyGradient(timezone: string, centerTime: number, lat?: number, lng?: number): string {
  const centerDt = DateTime.fromMillis(centerTime, { zone: timezone });
  const startMs = centerTime - (HOURS_VISIBLE / 2) * 3_600_000;

  if (lat == null || lng == null) {
    // Fallback to fixed stops
    const startHour = centerDt.hour + centerDt.minute / 60 - HOURS_VISIBLE / 2;
    const stops: string[] = [];
    const numStops = 96;
    for (let i = 0; i <= numStops; i++) {
      const hour = startHour + (i / numStops) * HOURS_VISIBLE;
      const color = colorForHour(hour);
      const pct = ((i / numStops) * 100).toFixed(1);
      stops.push(`${rgbStr(color)} ${pct}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  // Precompute solar noons to distinguish morning from afternoon
  const startDt = DateTime.fromMillis(startMs, { zone: timezone });
  const firstDay = startDt.startOf('day');
  const solarNoons: number[] = [];
  for (let d = -1; d <= 3; d++) {
    const day = firstDay.plus({ days: d });
    const noonUtcMs = day.set({ hour: 12 }).toMillis();
    const times = SunCalc.getTimes(new Date(noonUtcMs), lat, lng);
    if (!isNaN(times.solarNoon.getTime())) {
      solarNoons.push(times.solarNoon.getTime());
    }
  }

  const stops: string[] = [];
  const numStops = 384;
  for (let i = 0; i <= numStops; i++) {
    const ms = startMs + (i / numStops) * HOURS_VISIBLE * 3_600_000;
    const pos = SunCalc.getPosition(new Date(ms), lat, lng);
    const altDeg = pos.altitude * (180 / Math.PI);

    // Find nearest solar noon to determine morning vs afternoon
    let nearestNoon = solarNoons[0] ?? ms;
    for (const noon of solarNoons) {
      if (Math.abs(ms - noon) < Math.abs(ms - nearestNoon)) nearestNoon = noon;
    }
    const isAfternoon = ms > nearestNoon;

    const color = colorFromSunAltitude(altDeg, isAfternoon);
    const pct = ((i / numStops) * 100).toFixed(2);
    stops.push(`${rgbStr(color)} ${pct}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function getSolarIcon(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h < 17) return Sun;
  if (h >= 5 && h < 7) return Sunrise;
  if (h >= 17 && h < 19) return Sunset;
  return Moon;
}

function formatHourLabel(hour: number, fmt: TimeFormat): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  if (fmt === '24h') return `${h.toString().padStart(2, '0')}:00`;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

function formatTimeLabel(dt: DateTime, fmt: TimeFormat): string {
  return fmt === '24h' ? dt.toFormat('HH:mm') : dt.toFormat('h:mm a');
}

function formatShortTime(dt: DateTime, fmt: TimeFormat): string {
  return fmt === '24h' ? dt.toFormat('HH:mm') : dt.toFormat('h:mm');
}

// --- Persistence ---

type TimeFormat = '12h' | '24h';

interface SavedState {
  cities: City[];
  viewMode: ViewMode;
  timeFormat?: TimeFormat;
}

function cityFromTimezone(tz: string): City {
  const candidates = TIMEZONE_LIST.filter((e) => e.timezone === tz);
  // Prefer the entry whose city name matches the IANA ID (e.g. America/New_York → "New York")
  const ianaCity = tz.split('/').pop()?.replace(/_/g, ' ') || '';
  const entry = candidates.find((e) => e.city === ianaCity) || candidates[0];
  return {
    id: crypto.randomUUID(),
    name: entry?.city || ianaCity || tz,
    timezone: tz,
    lat: entry?.lat,
    lng: entry?.lng,
  };
}

function parseCitiesFromUrl(): City[] | null {
  const params = new URLSearchParams(window.location.search);
  const tzParam = params.get('tz');
  if (!tzParam) return null;
  const entries = tzParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  return entries.map((entry) => {
    // Format: "CityName@Timezone" or just "Timezone" (backward compat)
    const atIdx = entry.lastIndexOf('@');
    if (atIdx > 0) {
      const name = decodeURIComponent(entry.slice(0, atIdx));
      const tz = entry.slice(atIdx + 1);
      const match = TIMEZONE_LIST.find((e) => e.timezone === tz && e.city === name)
        || TIMEZONE_LIST.find((e) => e.timezone === tz);
      return {
        id: crypto.randomUUID(),
        name,
        timezone: tz,
        lat: match?.lat,
        lng: match?.lng,
      };
    }
    return cityFromTimezone(entry);
  });
}

function defaultCityName(tz: string): string {
  const candidates = TIMEZONE_LIST.filter((e) => e.timezone === tz);
  const ianaCity = tz.split('/').pop()?.replace(/_/g, ' ') || '';
  const entry = candidates.find((e) => e.city === ianaCity) || candidates[0];
  return entry?.city || ianaCity || tz;
}

function updateUrl(cities: City[]) {
  const tzList = cities.map((c) => {
    // Only include city name prefix when it differs from the default
    if (c.name !== defaultCityName(c.timezone)) {
      return `${encodeURIComponent(c.name)}@${c.timezone}`;
    }
    return c.timezone;
  }).join(',');
  const url = new URL(window.location.href);
  url.searchParams.set('tz', tzList);
  window.history.replaceState(null, '', url.toString());
}

function loadState(): { cities: City[]; viewMode: ViewMode; timeFormat: TimeFormat } {
  // URL takes priority over localStorage
  const urlCities = parseCitiesFromUrl();
  if (urlCities && urlCities.length > 0) {
    let viewMode: ViewMode = 'auto';
    let timeFormat: TimeFormat = '12h';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SavedState;
        if (parsed.viewMode) viewMode = parsed.viewMode;
        if (parsed.timeFormat) timeFormat = parsed.timeFormat;
      }
    } catch { /* ignore */ }
    return { cities: urlCities, viewMode, timeFormat };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedState;
      if (Array.isArray(parsed.cities) && parsed.cities.length > 0) {
        return {
          cities: parsed.cities,
          viewMode: parsed.viewMode || 'auto',
          timeFormat: parsed.timeFormat || '12h',
        };
      }
    }
  } catch {
    // ignore
  }
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    cities: [cityFromTimezone(localTz)],
    viewMode: 'auto',
    timeFormat: '12h',
  };
}

function saveState(cities: City[], viewMode: ViewMode, timeFormat: TimeFormat) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ cities, viewMode, timeFormat }));
}

// --- App Component ---

export default function App() {
  const [cities, setCities] = useState<City[]>([]);
  const [centerTime, setCenterTime] = useState<number>(Date.now());
  const [viewMode, setViewMode] = useState<ViewMode>('auto');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const [nowMs, setNowMs] = useState(Date.now());
  const [initialized, setInitialized] = useState(false);

  const dragRef = useRef({ active: false, startX: 0, startTime: 0 });
  const reorderRef = useRef({ active: false, cityId: '', startY: 0, originIndex: 0 });
  const reorderDeltaRef = useRef(0);
  const reorderRafRef = useRef(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gradientBaseRef = useRef(centerTime);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [reorderDeltaY, setReorderDeltaY] = useState(0);

  // Hydrate state on mount
  useEffect(() => {
    const saved = loadState();
    setCities(saved.cities);
    setViewMode(saved.viewMode);
    setTimeFormat(saved.timeFormat);
    setInitialized(true);
  }, []);

  // Live "now" marker — tick every 30 seconds
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Persist state (debounced) and sync URL
  useEffect(() => {
    if (!initialized) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveState(cities, viewMode, timeFormat);
      updateUrl(cities);
    }, 300);
  }, [cities, viewMode, timeFormat, initialized]);

  // Focus search input when modal opens
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery('');
    }
  }, [searchOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false);
      if (searchOpen) return; // don't nudge time while searching
      const step = e.shiftKey ? 3_600_000 : 15 * 60_000; // shift = 1h, default = 15min
      if (e.key === 'ArrowRight') { e.preventDefault(); setCenterTime((t) => t + step); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setCenterTime((t) => t - step); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen]);

  // Computed mode
  const effectiveMode = useMemo(
    () =>
      viewMode === 'auto'
        ? cities.length <= 5
          ? 'beautiful'
          : 'compact'
        : viewMode,
    [viewMode, cities.length]
  );

  const stripHeight = effectiveMode === 'beautiful' ? 120 : 48;

  // Stable gradient base time — only regenerate when drift exceeds threshold
  let gradientBase = gradientBaseRef.current;
  if (Math.abs(centerTime - gradientBase) / 3_600_000 > 2) {
    gradientBase = centerTime;
    gradientBaseRef.current = centerTime;
  }
  const driftPx = ((centerTime - gradientBase) / 3_600_000) * PX_PER_HOUR;

  // --- Drag Handlers ---

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { active: true, startX: e.clientX, startTime: centerTime };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [centerTime]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dtMs = (dx / PX_PER_HOUR) * 3_600_000;
    setCenterTime(dragRef.current.startTime - dtMs);
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dtMs = (e.deltaX - e.deltaY) / PX_PER_HOUR * 3_600_000;
      setCenterTime((prev) => prev + dtMs);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [initialized]);

  // --- Reorder Handlers ---

  const stripGap = effectiveMode === 'beautiful' ? 12 : 4;
  const rowHeight = stripHeight + stripGap;

  const reorderOriginIndex = reorderingId ? reorderRef.current.originIndex : -1;
  const reorderTargetIndex = reorderingId
    ? Math.max(0, Math.min(cities.length - 1, reorderOriginIndex + Math.round(reorderDeltaY / rowHeight)))
    : -1;

  const onReorderPointerDown = useCallback(
    (e: React.PointerEvent, cityId: string) => {
      e.stopPropagation();
      e.preventDefault();
      const index = cities.findIndex((c) => c.id === cityId);
      if (index === -1) return;
      reorderRef.current = { active: true, cityId, startY: e.clientY, originIndex: index };
      reorderDeltaRef.current = 0;
      setReorderingId(cityId);
      setReorderDeltaY(0);
    },
    [cities]
  );

  useEffect(() => {
    if (!reorderingId) return;

    const onMove = (e: PointerEvent) => {
      if (!reorderRef.current.active) return;
      reorderDeltaRef.current = e.clientY - reorderRef.current.startY;
      if (!reorderRafRef.current) {
        reorderRafRef.current = requestAnimationFrame(() => {
          setReorderDeltaY(reorderDeltaRef.current);
          reorderRafRef.current = 0;
        });
      }
    };

    const onUp = () => {
      if (reorderRafRef.current) {
        cancelAnimationFrame(reorderRafRef.current);
        reorderRafRef.current = 0;
      }
      const dy = reorderDeltaRef.current;
      const originIndex = reorderRef.current.originIndex;

      setCities((prev) => {
        const target = Math.max(0, Math.min(prev.length - 1, originIndex + Math.round(dy / rowHeight)));
        if (target === originIndex) return prev;
        const next = [...prev];
        const [moved] = next.splice(originIndex, 1);
        next.splice(target, 0, moved);
        return next;
      });

      reorderRef.current.active = false;
      reorderDeltaRef.current = 0;
      setReorderingId(null);
      setReorderDeltaY(0);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [reorderingId, rowHeight]);

  // --- City Management ---

  const addCity = useCallback((entry: TimezoneEntry) => {
    setCities((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: entry.city,
        timezone: entry.timezone,
        lat: entry.lat,
        lng: entry.lng,
      },
    ]);
    setSearchOpen(false);
  }, []);

  const removeCity = useCallback((id: string) => {
    setCities((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  // --- Search Filtering ---

  // Build extended timezone list: curated entries + all IANA zones not in curated list
  const allTimezones = useMemo(() => {
    const curatedSet = new Set(TIMEZONE_LIST.map((e) => e.timezone));
    let extraZones: TimezoneEntry[] = [];
    try {
      extraZones = ((Intl as any).supportedValuesOf('timeZone') as string[])
        .filter((tz: string) => !curatedSet.has(tz))
        .map((tz: string) => ({
          city: tz.split('/').pop()?.replace(/_/g, ' ') || tz,
          timezone: tz,
          country: '',
        }));
    } catch {
      // Intl.supportedValuesOf not available in older browsers
    }
    return [...TIMEZONE_LIST, ...extraZones];
  }, []);

  const filteredTimezones = useMemo(() => {
    if (!searchQuery.trim()) return TIMEZONE_LIST.slice(0, 20);
    const q = searchQuery.toLowerCase();
    return allTimezones
      .filter(
        (e) =>
          e.city.toLowerCase().includes(q) ||
          e.country.toLowerCase().includes(q) ||
          e.timezone.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [searchQuery, allTimezones]);

  // --- Render Helpers ---

  function renderHourLabels(timezone: string) {
    const baseDt = DateTime.fromMillis(gradientBase, { zone: timezone });
    const baseHourFrac = baseDt.hour + baseDt.minute / 60;
    const labels: JSX.Element[] = [];

    const startHour = Math.floor(baseHourFrac - HOURS_VISIBLE / 2);
    const endHour = Math.ceil(baseHourFrac + HOURS_VISIBLE / 2);

    // Viewport center in strip coordinates (accounts for drift)
    const viewportCenterX = STRIP_WIDTH / 2 + driftPx;

    for (let h = startHour; h <= endHour; h++) {
      if (h % 3 !== 0) continue;
      const offset = h - (baseHourFrac - HOURS_VISIBLE / 2);
      const x = (offset / HOURS_VISIBLE) * STRIP_WIDTH;
      const distFromCenter = Math.abs(x - viewportCenterX);
      const isNearCenter = distFromCenter < PX_PER_HOUR * 1.5;

      labels.push(
        <div
          key={h}
          className="absolute top-0 flex items-center justify-center select-none pointer-events-none"
          style={{
            left: x,
            width: 0,
            height: '100%',
            opacity: isNearCenter ? 1 : 0.35,
            fontWeight: isNearCenter ? 700 : 400,
            transition: 'opacity 0.2s',
          }}
        >
          <span
            className={`whitespace-nowrap ${
              effectiveMode === 'beautiful' ? 'text-xs' : 'text-[10px]'
            } text-white drop-shadow-md`}
          >
            {formatHourLabel(h, timeFormat)}
          </span>
        </div>
      );
    }
    return labels;
  }

  function renderDateMarkers(timezone: string) {
    const centerDt = DateTime.fromMillis(gradientBase, { zone: timezone });
    const centerHourFrac = centerDt.hour + centerDt.minute / 60;
    const markers: JSX.Element[] = [];

    const startHour = Math.floor(centerHourFrac - HOURS_VISIBLE / 2);
    const endHour = Math.ceil(centerHourFrac + HOURS_VISIBLE / 2);

    for (let h = startHour; h <= endHour; h++) {
      if (((h % 24) + 24) % 24 !== 0) continue;
      const offset = h - (centerHourFrac - HOURS_VISIBLE / 2);
      const x = (offset / HOURS_VISIBLE) * STRIP_WIDTH;
      const dayDt = centerDt.plus({ hours: h - centerHourFrac });

      markers.push(
        <div
          key={h}
          className="absolute top-0 h-full pointer-events-none"
          style={{ left: x }}
        >
          <div className="w-[2px] h-full bg-white/30" />
          <div className="absolute -top-0 left-1 text-[9px] text-white/60 whitespace-nowrap font-medium">
            {dayDt.toFormat('MMM d')}
          </div>
        </div>
      );
    }
    return markers;
  }

  function renderSunMarkers(city: City) {
    if (city.lat == null || city.lng == null) return null;
    const markers: JSX.Element[] = [];
    // Compute sunrise/sunset for each day visible in the 48h strip
    const baseDt = DateTime.fromMillis(gradientBase, { zone: city.timezone });
    const startDay = baseDt.minus({ hours: HOURS_VISIBLE / 2 }).startOf('day');
    for (let d = 0; d < 3; d++) {
      const day = startDay.plus({ days: d });
      const noonUtcMs = day.set({ hour: 12 }).toMillis();
      const times = SunCalc.getTimes(new Date(noonUtcMs), city.lat!, city.lng!);

      const pairs: Array<{ jsTime: Date; icon: typeof Sunrise; label: string }> = [
        { jsTime: times.sunrise, icon: Sunrise, label: 'rise' },
        { jsTime: times.sunset, icon: Sunset, label: 'set' },
      ];

      for (const { jsTime, icon: MarkerIcon, label } of pairs) {
        if (!jsTime || isNaN(jsTime.getTime())) continue;
        const markerDt = DateTime.fromJSDate(jsTime, { zone: 'utc' }).setZone(city.timezone);
        const offsetHours = (markerDt.toMillis() - gradientBase) / 3_600_000;
        const x = STRIP_WIDTH / 2 + offsetHours * PX_PER_HOUR;
        if (x < -40 || x > STRIP_WIDTH + 40) continue;

        markers.push(
          <div
            key={`${label}-${d}`}
            className="absolute top-0 h-full flex flex-col items-center justify-end pb-1 pointer-events-none"
            style={{ left: x, transform: 'translateX(-50%)' }}
          >
            <MarkerIcon size={effectiveMode === 'beautiful' ? 14 : 10} className="text-white/80 drop-shadow-md" />
            <span className={`${effectiveMode === 'beautiful' ? 'text-[10px]' : 'text-[8px]'} text-white/70 drop-shadow whitespace-nowrap font-medium`}>
              {formatShortTime(markerDt, timeFormat)}
            </span>
          </div>
        );
      }
    }
    return markers;
  }

  function renderCityStrip(city: City, index: number, deltaLabel: string) {
    const centerDt = DateTime.fromMillis(centerTime, { zone: city.timezone });
    const localHour = centerDt.hour + centerDt.minute / 60;
    const Icon = getSolarIcon(localHour);
    const gradient = generateSkyGradient(city.timezone, gradientBase, city.lat, city.lng);

    // "Now" marker position: where real time falls within the strip
    const nowOffsetHours = (nowMs - gradientBase) / 3_600_000;
    const nowX = STRIP_WIDTH / 2 + nowOffsetHours * PX_PER_HOUR;
    const nowVisible = nowX > 0 && nowX < STRIP_WIDTH;

    const isDragged = reorderingId === city.id;

    // Compute visual offset for reorder preview
    let reorderTranslateY = 0;
    if (isDragged) {
      reorderTranslateY = reorderDeltaY;
    } else if (reorderingId) {
      const origin = reorderOriginIndex;
      const target = reorderTargetIndex;
      if (origin < target && index > origin && index <= target) {
        reorderTranslateY = -rowHeight;
      } else if (origin > target && index < origin && index >= target) {
        reorderTranslateY = rowHeight;
      }
    }

    return (
      <div
        key={city.id}
        className={`relative group overflow-hidden ${
          effectiveMode === 'beautiful'
            ? 'rounded-xl shadow-lg mb-3'
            : 'rounded-md mb-1'
        } ${isDragged ? 'z-20 shadow-2xl scale-[1.02]' : ''}`}
        style={{
          height: stripHeight,
          transform: reorderTranslateY ? `translateY(${reorderTranslateY}px)` : undefined,
          transition: isDragged ? 'box-shadow 0.15s, transform 0s' : reorderingId ? 'transform 0.15s ease' : undefined,
          position: 'relative',
        }}
      >
        {/* Sky gradient strip */}
        <div
          className="absolute inset-0"
          style={{
            background: gradient,
            width: STRIP_WIDTH,
            left: '50%',
            transform: `translateX(${-STRIP_WIDTH / 2 - driftPx}px)`,
            willChange: 'transform',
          }}
        />

        {/* Hour labels + date markers + now marker */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            width: STRIP_WIDTH,
            left: '50%',
            transform: `translateX(${-STRIP_WIDTH / 2 - driftPx}px)`,
            willChange: 'transform',
          }}
        >
          {renderHourLabels(city.timezone)}
          {renderDateMarkers(city.timezone)}
          {renderSunMarkers(city)}
          {nowVisible && (
            <div
              className="absolute top-0 h-full pointer-events-none"
              style={{ left: nowX }}
            >
              <div className="w-[2px] h-full bg-amber-400/70" />
            </div>
          )}
        </div>

        {/* City info overlay */}
        <div className="relative z-10 flex items-center justify-between h-full px-1 pointer-events-none">
          <div className="flex items-center">
            {/* Reorder handle */}
            {cities.length > 1 && (
              <div
                className="pointer-events-auto flex items-center justify-center px-1 cursor-grab active:cursor-grabbing text-white/30 hover:text-white/70 transition-colors touch-none"
                onPointerDown={(e) => onReorderPointerDown(e, city.id)}
              >
                <GripVertical size={effectiveMode === 'beautiful' ? 18 : 14} />
              </div>
            )}
            <div className={`flex items-center gap-2 ${cities.length <= 1 ? 'pl-3' : ''}`}>
              {effectiveMode === 'beautiful' && (
                <Icon size={20} className="text-white drop-shadow-md" />
              )}
              <div>
                <div
                  className={`font-bold text-white drop-shadow-md flex items-baseline gap-2 ${
                    effectiveMode === 'beautiful' ? 'text-lg' : 'text-sm'
                  }`}
                >
                  {city.name}
                  {deltaLabel && (
                    <span className={`font-normal text-white/50 ${
                      effectiveMode === 'beautiful' ? 'text-xs' : 'text-[10px]'
                    }`}>
                      {deltaLabel}
                    </span>
                  )}
                </div>
                {effectiveMode === 'beautiful' && (
                  <div className="text-xs text-white/70 drop-shadow">
                    {city.timezone}
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>

        {/* Remove button */}
        {cities.length > 1 && (
          <button
            onClick={() => removeCity(city.id)}
            className="absolute top-2 right-2 z-20 p-1 rounded-full bg-black/30 text-white/70 hover:bg-black/50 hover:text-white opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 flex items-center justify-center">
        <div className="text-stone-400">Loading...</div>
      </div>
    );
  }

  const centerLocal = DateTime.fromMillis(centerTime);

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 text-stone-900 select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-orange-100/60">
        <div className="flex items-center gap-3">
          <Sun size={20} className="text-amber-500" />
          <h1 className="text-lg font-bold tracking-tight">Golden Hour</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* Date — hidden on mobile */}
          <span className="hidden sm:block text-sm text-stone-400">
            {centerLocal.toFormat('MMM d, yyyy')}
          </span>

          {/* Now button */}
          <button
            onClick={() => {
              const now = Date.now();
              setCenterTime(now);
              gradientBaseRef.current = now;
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 text-xs font-medium transition-colors cursor-pointer"
          >
            <Clock size={12} />
            <span className="hidden sm:inline">Now</span>
          </button>

          {/* Time format toggle */}
          <div className="flex rounded-lg bg-stone-200 p-0.5 text-xs">
            {(['12h', '24h'] as TimeFormat[]).map((fmt) => (
              <button
                key={fmt}
                onClick={() => setTimeFormat(fmt)}
                className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                  timeFormat === fmt
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>

          {/* View mode toggle — hidden on mobile */}
          <div className="hidden sm:flex rounded-lg bg-stone-200 p-0.5 text-xs">
            {(['auto', 'beautiful', 'compact'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-2 py-1 rounded-md capitalize transition-colors cursor-pointer ${
                  viewMode === mode
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Add city button */}
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg bg-stone-200 hover:bg-stone-300 text-sm transition-colors cursor-pointer"
          >
            <Plus size={14} />
            <span className="hidden sm:inline">Add City</span>
          </button>
        </div>
      </header>

      {/* Timeline area */}
      <div
        ref={timelineRef}
        className="relative px-4 py-4 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ touchAction: 'none' }}
      >
        {/* City strips */}
        {cities.map((city, i) => {
          let deltaLabel = '';
          if (i > 0 && cities.length > 1) {
            const firstOffset = DateTime.fromMillis(centerTime, { zone: cities[0].timezone }).offset;
            const thisOffset = DateTime.fromMillis(centerTime, { zone: city.timezone }).offset;
            const diffMinutes = thisOffset - firstOffset;
            const sign = diffMinutes >= 0 ? '+' : '';
            if (diffMinutes % 60 === 0) {
              deltaLabel = `${sign}${diffMinutes / 60}h`;
            } else {
              const h = Math.trunc(diffMinutes / 60);
              const m = Math.abs(diffMinutes % 60);
              deltaLabel = `${sign}${h}:${m.toString().padStart(2, '0')}`;
            }
          }
          return renderCityStrip(city, i, deltaLabel);
        })}

        {/* Center Indicator Line */}
        <div
          className="absolute top-0 bottom-0 w-[2px] z-30 pointer-events-none"
          style={{ left: '50%', transform: 'translateX(-1px)' }}
        >
          {/* Gradient line: fades from accent at top to transparent at bottom */}
          <div className="w-full h-full bg-gradient-to-b from-stone-900 via-stone-900/60 to-stone-900/20" />
        </div>

        {/* Floating time bubble */}
        <div
          className="absolute z-40 pointer-events-none"
          style={{ left: '50%', top: -2, transform: 'translateX(-50%)' }}
        >
          <div className="bg-stone-900/90 backdrop-blur-sm text-white rounded-xl shadow-xl px-3 py-1.5 flex flex-col items-center">
            <span className="text-lg font-bold tracking-tight leading-tight">
              {formatTimeLabel(centerLocal, timeFormat)}
            </span>
            <span className="text-[10px] text-white/50 leading-tight">
              {centerLocal.toFormat('ccc, MMM d')}
            </span>
          </div>
        </div>

        {/* Per-city time pills at center indicator */}
        <div className="absolute top-0 z-30 pointer-events-none" style={{ left: '50%' }}>
          {cities.map((city, i) => {
            const cityDt = DateTime.fromMillis(centerTime, { zone: city.timezone });
            const topOffset =
              effectiveMode === 'beautiful'
                ? 16 + i * (stripHeight + 12) + stripHeight / 2 - 10
                : 16 + i * (stripHeight + 4) + stripHeight / 2 - 8;
            return (
              <div
                key={city.id}
                className="absolute whitespace-nowrap"
                style={{
                  top: topOffset,
                  left: 6,
                }}
              >
                <span className={`${
                  effectiveMode === 'beautiful' ? 'text-sm' : 'text-[11px]'
                } font-bold text-white drop-shadow-lg bg-black/20 backdrop-blur-[2px] px-1.5 py-0.5 rounded-md`}>
                  {formatTimeLabel(cityDt, timeFormat)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-center py-4">
        <span className="text-xs text-stone-300">
          vibecoded with <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-amber-500 transition-colors">Claude</a>
        </span>
      </div>

      {/* Search Modal */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/30 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden">
            {/* Search input */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200">
              <Search size={16} className="text-stone-400" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search cities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-stone-900 outline-none text-sm placeholder-stone-400"
              />
              <button
                onClick={() => setSearchOpen(false)}
                className="p-1 text-stone-400 hover:text-stone-700 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-80 overflow-y-auto">
              {filteredTimezones.length === 0 ? (
                <div className="px-4 py-8 text-center text-stone-400 text-sm">
                  No cities found
                </div>
              ) : (
                filteredTimezones.map((entry, i) => {
                  const alreadyAdded = cities.some(
                    (c) => c.timezone === entry.timezone
                  );
                  return (
                    <button
                      key={`${entry.timezone}-${i}`}
                      onClick={() => addCity(entry)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-stone-50 transition-colors text-left cursor-pointer"
                    >
                      <MapPin size={14} className="text-stone-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-stone-900 truncate">
                          {entry.city}
                          <span className="text-stone-400 ml-1.5">{entry.country}</span>
                        </div>
                        <div className="text-xs text-stone-400 truncate">
                          {entry.timezone}
                        </div>
                      </div>
                      {alreadyAdded && (
                        <span className="text-[10px] text-stone-400 flex-shrink-0">
                          added
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
