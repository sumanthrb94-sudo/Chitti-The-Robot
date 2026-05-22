/**
 * Chitti connectors — zero-config public-API integrations.
 *
 * Every function here calls a public, key-less endpoint so Chitti gains
 * real-world capability without the user setting up OAuth or API keys:
 *
 *   - web_search       → DuckDuckGo Instant Answer API
 *   - wikipedia_search → Wikipedia REST v1
 *   - get_weather      → Open-Meteo (geocoding + forecast)
 *   - get_crypto_price → CoinGecko /simple/price
 *   - get_hackernews_top → HN Firebase API
 *
 * Each call is wrapped with a 6s timeout. Errors return a descriptive
 * message so the LLM can recover gracefully.
 */

const DEFAULT_TIMEOUT_MS = 6000;
const UA = 'Chitti/0.1 (https://github.com/sumanthrb94-sudo/chitti-the-robot)';

async function timedFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────────────────  Web search (DuckDuckGo)  ───────────────────────── */

export interface WebSearchResult {
  abstract?: string;
  abstract_source?: string;
  abstract_url?: string;
  related: Array<{ title: string; url: string }>;
  query: string;
}

export async function webSearch(query: string): Promise<WebSearchResult> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractSource?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown }>;
  };

  const related: Array<{ title: string; url: string }> = [];
  for (const topic of data.RelatedTopics ?? []) {
    if (related.length >= 6) break;
    if (typeof topic.Text === 'string' && typeof topic.FirstURL === 'string') {
      related.push({ title: topic.Text, url: topic.FirstURL });
    }
  }

  return {
    abstract: data.AbstractText || undefined,
    abstract_source: data.AbstractSource || undefined,
    abstract_url: data.AbstractURL || undefined,
    related,
    query,
  };
}

/* ─────────────────────────  Wikipedia  ───────────────────────── */

export interface WikipediaResult {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
}

export async function wikipediaSearch(query: string): Promise<WikipediaResult> {
  // Use the REST summary endpoint — it accepts the page title directly.
  // DuckDuckGo's Instant Answer often points to Wikipedia anyway; this is
  // the more reliable path for a known concept.
  const title = encodeURIComponent(query.trim().replace(/\s+/g, '_'));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}?redirect=true`;
  const res = await timedFetch(url);
  if (res.status === 404) {
    throw new Error(`No Wikipedia article found for "${query}".`);
  }
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = (await res.json()) as {
    title?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
    thumbnail?: { source?: string };
  };
  return {
    title: data.title ?? query,
    extract: data.extract ?? '',
    url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
    thumbnail: data.thumbnail?.source,
  };
}

/* ─────────────────────────  Weather (Open-Meteo)  ───────────────────────── */

export interface WeatherResult {
  location: string;
  latitude: number;
  longitude: number;
  current: {
    temperature_c: number;
    apparent_c: number;
    humidity: number;
    wind_kph: number;
    condition: string;
    time: string;
  };
}

const WEATHER_CODE: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm w/ slight hail',
  99: 'Thunderstorm w/ heavy hail',
};

export async function getWeather(location: string): Promise<WeatherResult> {
  // 1. Geocode the location.
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const geoRes = await timedFetch(geoUrl);
  if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);
  const geo = (await geoRes.json()) as {
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      country?: string;
      admin1?: string;
    }>;
  };
  const hit = geo.results?.[0];
  if (!hit) throw new Error(`Could not geocode location "${location}".`);

  // 2. Fetch the current weather.
  const wxUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&wind_speed_unit=kmh&temperature_unit=celsius&timezone=auto`;
  const wxRes = await timedFetch(wxUrl);
  if (!wxRes.ok) throw new Error(`Open-Meteo HTTP ${wxRes.status}`);
  const wx = (await wxRes.json()) as {
    current?: {
      time: string;
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      weather_code: number;
    };
  };
  if (!wx.current) throw new Error('Open-Meteo returned no current data.');

  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  return {
    location: label,
    latitude: hit.latitude,
    longitude: hit.longitude,
    current: {
      temperature_c: wx.current.temperature_2m,
      apparent_c: wx.current.apparent_temperature,
      humidity: wx.current.relative_humidity_2m,
      wind_kph: wx.current.wind_speed_10m,
      condition: WEATHER_CODE[wx.current.weather_code] ?? 'Unknown',
      time: wx.current.time,
    },
  };
}

/* ─────────────────────────  Crypto (CoinGecko)  ───────────────────────── */

export interface CryptoPriceResult {
  symbol: string;
  id: string;
  vs_currency: string;
  price: number;
  change_24h_pct?: number;
  market_cap?: number;
}

// Small map for common shorthands → CoinGecko ids; the rest pass through.
const CRYPTO_ALIAS: Record<string, string> = {
  btc: 'bitcoin',
  bitcoin: 'bitcoin',
  eth: 'ethereum',
  ethereum: 'ethereum',
  sol: 'solana',
  solana: 'solana',
  doge: 'dogecoin',
  dogecoin: 'dogecoin',
  ada: 'cardano',
  cardano: 'cardano',
  xrp: 'ripple',
  ripple: 'ripple',
  matic: 'matic-network',
  bnb: 'binancecoin',
  ltc: 'litecoin',
  litecoin: 'litecoin',
  link: 'chainlink',
  chainlink: 'chainlink',
};

export async function getCryptoPrice(
  symbol: string,
  vs: string = 'usd',
): Promise<CryptoPriceResult> {
  const key = symbol.toLowerCase().trim();
  const id = CRYPTO_ALIAS[key] ?? key;
  const vsLower = vs.toLowerCase().trim();
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vsLower)}&include_24hr_change=true&include_market_cap=true`;
  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    Record<string, number | undefined>
  >;
  const row = data[id];
  if (!row || row[vsLower] === undefined) {
    throw new Error(`Unknown crypto "${symbol}" or currency "${vs}".`);
  }
  return {
    symbol: symbol.toUpperCase(),
    id,
    vs_currency: vsLower.toUpperCase(),
    price: Number(row[vsLower]),
    change_24h_pct:
      row[`${vsLower}_24h_change`] !== undefined
        ? Number(row[`${vsLower}_24h_change`])
        : undefined,
    market_cap:
      row[`${vsLower}_market_cap`] !== undefined
        ? Number(row[`${vsLower}_market_cap`])
        : undefined,
  };
}

/* ─────────────────────────  Hacker News  ───────────────────────── */

export interface HnStory {
  id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
  descendants?: number;
  time: number;
}

export async function getHackerNewsTop(limit: number = 5): Promise<HnStory[]> {
  const idsRes = await timedFetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!idsRes.ok) throw new Error(`HN top HTTP ${idsRes.status}`);
  const ids = (await idsRes.json()) as number[];
  const top = ids.slice(0, Math.max(1, Math.min(15, limit)));

  // Fetch in parallel.
  const stories = await Promise.all(
    top.map(async (id) => {
      const r = await timedFetch(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      );
      if (!r.ok) return null;
      return (await r.json()) as HnStory | null;
    }),
  );
  return stories.filter((s): s is HnStory => s !== null && Boolean(s.title));
}
