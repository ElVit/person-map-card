/**
 * Person Map Card
 * A Home Assistant Lovelace card that shows a person on an OpenStreetMap
 * background – no API key required.
 *
 * Layout based on the community "Person card with static map API background"
 * (stack-in-card + mushroom-template-card + mushroom-chips-card + card-mod),
 * but self-contained and without Geoapify / Google API keys.
 */

const CARD_VERSION = "1.0.0";
const TILE_SIZE = 256;

// Map providers, each with a light and a dark look. `dark` is either its own
// tile URL or, with `darkFilter`, the light tiles darkened by CSS (the same
// filter Home Assistant uses for its raster map). `keyOption` names the config
// option holding the provider's API key; `api_key` is used as a fallback.
const MAP_STYLES = {
  // OpenStreetMap raster tiles through Home Assistant's own `map_tiles` proxy
  // (HA 2026.10+): cached by HA, no direct requests to external tile servers.
  ha: {
    url: "/api/map_tiles/raster/{z}/{x}/{y}.png?token={token}",
    darkFilter: true,
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
    proxy: true,
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    darkFilter: true,
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  },
  // CARTO basemaps require a (free) key since 2026
  carto: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key={api_key}",
    darkUrl: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key={api_key}",
    keyOption: "carto_api_key",
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 20,
  },
  // Geoapify, same styles as the original community card (free key available)
  geoapify: {
    url: "https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}{r}.png?apiKey={api_key}",
    darkUrl:
      "https://maps.geoapify.com/v1/tile/dark-matter-yellow-roads/{z}/{x}/{y}{r}.png?apiKey={api_key}",
    keyOption: "geoapify_api_key",
    attribution: "© OpenStreetMap contributors © Geoapify",
    maxZoom: 20,
  },
};

// Values from older versions of the card
const LEGACY_STYLES = { auto: "ha", "carto-voyager": "carto" };
const LEGACY_THEMES = { on: "dark", off: "light" };

/* ---------- Home Assistant map tiles token ---------- */

// The `map_tiles` proxy needs an access token, handed out over the WebSocket.
// Core rotates it every 30 minutes and keeps two alive, so refreshing every 20
// minutes keeps a valid one. Shared by all cards on the page.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;
const TOKEN_RETRY_MS = 60 * 1000;

const mapTiles = {
  token: null,
  status: "unknown", // unknown | ok | unavailable
  failedAt: 0,
  pending: null,
  timer: null,
  connection: null,
};

function fetchMapTilesToken(connection) {
  if (mapTiles.pending) return mapTiles.pending;
  mapTiles.connection = connection;
  mapTiles.pending = connection
    .sendMessagePromise({ type: "map_tiles/access_token" })
    .then((result) => {
      mapTiles.token = result.token;
      mapTiles.status = "ok";
      if (!mapTiles.timer) {
        mapTiles.timer = setInterval(() => {
          fetchMapTilesToken(mapTiles.connection).catch(() => {});
        }, TOKEN_REFRESH_MS);
      }
    })
    .catch(() => {
      // Older Home Assistant without the proxy (or not ready yet)
      if (!mapTiles.token) mapTiles.status = "unavailable";
      mapTiles.failedAt = Date.now();
    })
    .finally(() => {
      mapTiles.pending = null;
    });
  return mapTiles.pending;
}

/* ---------- Home Assistant map component ---------- */

// Since 2026.10 Home Assistant draws its map from vector tiles (MapLibre) with
// its own cartography. The `ha` map style embeds that same <ha-map> element,
// so the card looks exactly like the built-in map. <ha-map> is loaded lazily
// by the map card, so creating one through the card helpers loads it.
const haMapLoader = { status: "unknown", promise: null }; // unknown | loading | ok | unavailable

function loadHaMap() {
  if (customElements.get("ha-map")) {
    haMapLoader.status = "ok";
    return Promise.resolve();
  }
  if (haMapLoader.promise) return haMapLoader.promise;
  haMapLoader.status = "loading";
  haMapLoader.promise = (async () => {
    try {
      const helpers = await window.loadCardHelpers?.();
      await helpers?.createCardElement({ type: "map", entities: ["zone.home"] });
    } catch (e) {
      // ignore, checked below
    }
    const defined = await Promise.race([
      customElements.whenDefined("ha-map").then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    haMapLoader.status = defined ? "ok" : "unavailable";
  })();
  return haMapLoader.promise;
}

// Hides the zoom buttons of the embedded map, it is only a background
const HA_MAP_STYLE = `
  .maplibregl-ctrl-top-left, .maplibregl-ctrl-top-right,
  .leaflet-top { display: none !important; }
`;

const DEFAULTS = {
  map_style: "ha", // ha | osm | carto | geoapify
  theme: "auto", // auto | light | dark
  zoom: 14,
  spacer: 40,
  tint: 0.3,
  picture_size: 60,
  marker_size: 32,
  marker_offset_x: 0,
  marker_offset_y: 0,
  shadow_size: 1,
  shadow_color: "auto",
  show_marker: true,
  show_accuracy: false,
  show_state: true,
  show_last_changed: false,
  grayscale_away: false,
  geocoded_attributes: ["Name", "Postal Code", "Sub Locality"],
  zones: {},
  entities: [],
};

const STYLE_OPTIONS = [
  { value: "ha", label: "Home Assistant map" },
  { value: "osm", label: "OpenStreetMap (direct)" },
  { value: "carto", label: "CARTO (API key)" },
  { value: "geoapify", label: "Geoapify (API key)" },
];

// `icon` is used for the badge, `marker_icon` for the map marker (defaults to
// `icon`; an empty string draws a plain pin), like the original community card.
const ZONE_DEFAULTS = {
  home: { icon: "mdi:home", color: "green" },
  not_home: { icon: "mdi:home-export-outline", marker_icon: "", color: "red" },
  unknown: { icon: "mdi:help", marker_icon: "", color: "grey" },
  unavailable: { icon: "mdi:help", marker_icon: "", color: "grey" },
};
const OTHER_ZONE_DEFAULT = { icon: "mdi:map-marker", marker_icon: "", color: "blue" };

const COLORS = {
  green: "var(--green-color, #4caf50)",
  blue: "var(--blue-color, #2196f3)",
  red: "var(--red-color, #f44336)",
  orange: "var(--orange-color, #ff9800)",
  yellow: "var(--yellow-color, #ffeb3b)",
  purple: "var(--purple-color, #926bc7)",
  teal: "var(--teal-color, #009688)",
  cyan: "var(--cyan-color, #00bcd4)",
  pink: "var(--pink-color, #e91e63)",
  amber: "var(--amber-color, #ffc107)",
  grey: "var(--grey-color, #9e9e9e)",
  "light-green": "var(--light-green-color, #8bc34a)",
  indigo: "var(--indigo-color, #3f51b5)",
};

/* ---------- Helpers ---------- */

function lonToWorldX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToWorldY(lat, zoom) {
  const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const rad = (clamped * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    TILE_SIZE *
    2 ** zoom
  );
}

function worldXToLon(x, zoom) {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

function worldYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

// Returns a finite coordinate or null; accepts numbers and strings with "." or ","
function parseCoordinate(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function cssColor(color) {
  return COLORS[color] || color;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function relativeTime(date, lang) {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(lang || undefined, { numeric: "auto" });
  } catch (e) {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return rtf.format(seconds, "second");
}

/* ---------- Editor ---------- */

const THEME_OPTIONS = [
  { value: "auto", label: "Auto (follow Home Assistant)" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const EDITOR_LABELS = {
  entity: "Person",
  tracker: "Device tracker for the position (optional)",
  geocoded_sensor: "Geocoded location sensor (optional)",
  name: "Name (optional)",
  map_style: "Map style",
  theme: "Theme",
  carto_api_key: "CARTO API key",
  geoapify_api_key: "Geoapify API key",
  marker_offset_x: "Marker offset X",
  marker_offset_y: "Marker offset Y",
  zoom: "Zoom",
  spacer: "Map space between header and chips",
  tint: "Card background tint over the map",
  picture_size: "Picture size",
  marker_size: "Marker size",
  shadow_size: "Shadow size (0 = off)",
  shadow_color: "Shadow color",
  show_marker: "Show marker",
  show_accuracy: "Show GPS accuracy",
  show_state: "Show state",
  show_last_changed: "Show last changed",
  grayscale_away: "Grayscale map when away",
  entities: "Chips (e.g. steps, battery)",
};

function normalizeStyle(style) {
  if (LEGACY_STYLES[style]) return LEGACY_STYLES[style];
  if (/^carto-/.test(style)) return "carto";
  if (/^geoapify-/.test(style)) return "geoapify";
  return MAP_STYLES[style] ? style : DEFAULTS.map_style;
}

function editorSchema(config) {
  // Only show the API key field of the selected provider
  const keyOption = MAP_STYLES[normalizeStyle(config.map_style)].keyOption;
  return [
    { name: "entity", required: true, selector: { entity: { domain: ["person", "device_tracker"] } } },
    { name: "tracker", selector: { entity: { domain: "device_tracker" } } },
    { name: "geocoded_sensor", selector: { entity: { domain: "sensor" } } },
    { name: "name", selector: { text: {} } },
    {
      type: "grid",
      name: "",
      schema: [
        { name: "map_style", selector: { select: { mode: "dropdown", options: STYLE_OPTIONS } } },
        { name: "theme", selector: { select: { mode: "dropdown", options: THEME_OPTIONS } } },
      ],
    },
    ...(keyOption ? [{ name: keyOption, required: true, selector: { text: { type: "password" } } }] : []),
    {
      type: "grid",
      name: "",
      schema: [
        { name: "zoom", selector: { number: { min: 1, max: 19, mode: "slider" } } },
        { name: "spacer", selector: { number: { min: 0, max: 300, step: 5, unit_of_measurement: "px", mode: "box" } } },
        { name: "tint", selector: { number: { min: 0, max: 1, step: 0.05, mode: "slider" } } },
        { name: "picture_size", selector: { number: { min: 24, max: 200, step: 2, unit_of_measurement: "px", mode: "box" } } },
        { name: "marker_size", selector: { number: { min: 12, max: 120, step: 2, unit_of_measurement: "px", mode: "box" } } },
        { name: "shadow_size", selector: { number: { min: 0, max: 3, step: 0.1, mode: "slider" } } },
        {
          name: "shadow_color",
          selector: {
            select: {
              mode: "dropdown",
              custom_value: true,
              options: [
                { value: "auto", label: "Auto (white on light, black on dark)" },
                { value: "black", label: "Black" },
                { value: "white", label: "White" },
              ],
            },
          },
        },
        { name: "marker_offset_x", selector: { number: { min: -500, max: 500, step: 1, unit_of_measurement: "px", mode: "box" } } },
        { name: "marker_offset_y", selector: { number: { min: -500, max: 500, step: 1, unit_of_measurement: "px", mode: "box" } } },
      ],
    },
    {
      type: "grid",
      name: "",
      schema: [
        { name: "show_marker", selector: { boolean: {} } },
        { name: "show_accuracy", selector: { boolean: {} } },
        { name: "show_state", selector: { boolean: {} } },
        { name: "show_last_changed", selector: { boolean: {} } },
        { name: "grayscale_away", selector: { boolean: {} } },
      ],
    },
    { name: "entities", selector: { entity: { multiple: true } } },
  ];
}

// A small editor around Home Assistant's ha-form, so the schema can follow the
// config (getConfigForm only supports a fixed schema).
class PersonMapCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] ?? schema.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        // The form shows the defaults; only keep values the user set or changed
        const config = {};
        for (const [key, value] of Object.entries(ev.detail.value)) {
          if (
            key in this._config ||
            JSON.stringify(value) !== JSON.stringify(DEFAULTS[key])
          ) {
            config[key] = value;
          }
        }
        this._config = config;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
        this._render();
      });
      this.appendChild(this._form);
    }
    const data = {
      ...DEFAULTS,
      ...this._config,
      map_style: normalizeStyle(this._config.map_style),
    };
    this._form.hass = this._hass;
    this._form.data = data;
    this._form.schema = editorSchema(data);
  }
}

if (!customElements.get("person-map-card-editor")) {
  customElements.define("person-map-card-editor", PersonMapCardEditor);
}

/* ---------- Card ---------- */

class PersonMapCard extends HTMLElement {
  static getStubConfig(hass) {
    const person = Object.keys(hass?.states || {}).find((id) =>
      id.startsWith("person.")
    );
    return { entity: person || "person.example" };
  }

  static getConfigElement() {
    return document.createElement("person-map-card-editor");
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("You need to define an entity (e.g. person.john)");
    }
    this._config = { ...DEFAULTS, ...config };
    this._normalizeLegacyConfig(config);
    this._config.entities = (this._config.entities || []).map((e) =>
      typeof e === "string" ? { entity: e } : e
    );
    // Zone keys are matched case-insensitively against state / zone name
    this._zones = {};
    for (const [key, value] of Object.entries(this._config.zones || {})) {
      this._zones[key.toLowerCase()] = value;
    }
    this._mapKey = null;
    this._chipsHtml = null;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this._buildSkeleton();
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._update();
  }

  getCardSize() {
    return 3 + Math.round((Number(this._config?.spacer) || 0) / 50);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 4, rows: "auto" };
  }

  connectedCallback() {
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this._mapKey = null;
        this._update();
      });
    }
    if (this._mapEl) this._resizeObserver.observe(this._mapEl);
    if (this._haMap) {
      // The embedded map is connected now, so its shadow root exists
      requestAnimationFrame(() => {
        this._injectHaMapStyle();
        this._applyHaMapView();
      });
    }
    clearInterval(this._timer);
    this._timer = setInterval(() => this._updateInfo(), 60000);
  }

  disconnectedCallback() {
    clearTimeout(this._viewTimer);
    this._resizeObserver?.disconnect();
    clearInterval(this._timer);
  }

  /* ----- DOM ----- */

  _buildSkeleton() {
    clearTimeout(this._viewTimer);
    this._haMap = null;
    this._view = null;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          position: relative;
          overflow: hidden;
          cursor: pointer;
          isolation: isolate;
          box-sizing: border-box;
          /* Fixed colors per theme, so text and icons always contrast with the map */
          --pmc-text-color: #212121;
          --pmc-secondary-text-color: #424242;
          --pmc-avatar-color: #e0e0e0;
          /* --pmc-shadow / --pmc-icon-shadow are computed in _applyShadow() as
             plain values: nested calc() with var() does not work in every
             browser (e.g. the iOS app) */
        }
        ha-card.dark {
          --pmc-text-color: #ffffff;
          --pmc-secondary-text-color: #e0e0e0;
          --pmc-avatar-color: #424242;
        }
        .map {
          position: absolute;
          inset: 0;
          overflow: hidden;
          z-index: 0;
        }
        .tiles { position: absolute; inset: 0; transition: filter .4s; }
        .map ha-map {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
          transition: filter .4s;
        }
        .map ha-map.gray { filter: grayscale(1); }
        .tiles img {
          position: absolute;
          width: ${TILE_SIZE}px;
          height: ${TILE_SIZE}px;
          max-width: none;
          user-select: none;
          -webkit-user-drag: none;
        }
        .tiles.gray { filter: grayscale(1); }
        /* Same filter Home Assistant uses for its raster map in dark mode */
        .tiles.dark { filter: invert(0.9) hue-rotate(170deg) brightness(1.5) contrast(1.2); }
        .tiles.dark.gray { filter: invert(0.9) hue-rotate(170deg) brightness(1.5) contrast(1.2) grayscale(1); }
        .tint {
          position: absolute;
          inset: 0;
          background: var(--pmc-tint-color, var(--card-background-color, #fff));
          opacity: var(--pmc-tint, .3);
          pointer-events: none;
        }
        .accuracy {
          position: absolute;
          border-radius: 50%;
          background: color-mix(in srgb, var(--pmc-zone-color) 15%, transparent);
          border: 1px solid var(--pmc-zone-color);
          transform: translate(-50%, -50%);
          pointer-events: none;
        }
        .marker {
          position: absolute;
          width: var(--pmc-marker-size, 32px);
          height: var(--pmc-marker-size, 32px);
          /* The tip of the rotated square reaches (sqrt(2) - 1) / 2 of its size
             below the box, so shift it up by that much to sit on the location */
          transform: translate(-50%, calc(-100% - var(--pmc-marker-size, 32px) * 0.2071));
          pointer-events: none;
          filter: drop-shadow(0 2px 2px rgba(0,0,0,.45));
        }
        .marker .pin {
          width: 100%; height: 100%;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          background: var(--pmc-zone-color);
          border: max(1px, calc(var(--pmc-marker-size, 32px) / 16)) solid #fff;
          box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
        }
        .marker ha-icon {
          transform: rotate(45deg);
          color: #fff;
          --mdc-icon-size: calc(var(--pmc-marker-size, 32px) / 2);
          display: flex;
        }
        .marker .dot {
          width: 32%;
          height: 32%;
          border-radius: 50%;
          background: #fff;
        }
        .marker ha-icon[hidden],
        .marker .dot[hidden] { display: none; }
        .content {
          position: relative;
          z-index: 1;
          padding: 12px;
          text-shadow: var(--pmc-shadow);
          color: var(--pmc-text-color);
        }
        .header {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .avatar {
          position: relative;
          flex: none;
          width: var(--pmc-picture-size, 60px);
          height: var(--pmc-picture-size, 60px);
        }
        .avatar .pic {
          width: 100%; height: 100%;
          border-radius: 50%;
          background: var(--pmc-avatar-color) center/cover no-repeat;
          display: flex; align-items: center; justify-content: center;
          font-weight: 600;
          font-size: calc(var(--pmc-picture-size, 60px) * 0.37);
          text-shadow: none;
        }
        .badge {
          position: absolute;
          top: -3px; right: -3px;
          width: calc(var(--pmc-picture-size, 60px) / 3);
          height: calc(var(--pmc-picture-size, 60px) / 3);
          min-width: 16px; min-height: 16px;
          border-radius: 50%;
          background: var(--pmc-zone-color);
          display: flex; align-items: center; justify-content: center;
        }
        .badge ha-icon {
          --mdc-icon-size: max(11px, calc(var(--pmc-picture-size, 60px) * 0.22));
          color: #fff;
          display: flex;
        }
        /* A flex column, so the negative margins of the lines don't collapse */
        .text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
        .primary {
          font-weight: var(--card-primary-font-weight, 500);
          font-size: var(--card-primary-font-size, 14px);
          line-height: 20px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          /* overflow: hidden (for the ellipsis) would clip the shadow into a
             visible box, so give it room; the text itself does not move */
          padding: var(--pmc-shadow-pad, 0);
          margin: var(--pmc-shadow-pad-neg, 0);
        }
        .secondary {
          color: var(--pmc-secondary-text-color);
          font-weight: var(--card-secondary-font-weight, 400);
          font-size: var(--card-secondary-font-size, 12px);
          line-height: 16px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          padding: var(--pmc-shadow-pad, 0);
          margin: var(--pmc-shadow-pad-neg, 0);
        }
        .spacer { height: var(--pmc-spacer, 40px); }
        .chips {
          display: flex; flex-wrap: wrap; gap: 8px;
        }
        .chips:empty { display: none; }
        .chip {
          display: flex; align-items: center; gap: 4px;
          padding: 4px 8px 4px 4px;
          border-radius: 18px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
        }
        .chip ha-state-icon {
          --mdc-icon-size: 18px;
          color: var(--pmc-text-color);
          --state-icon-color: var(--pmc-text-color);
          filter: var(--pmc-icon-shadow);
        }
        .attribution {
          position: absolute;
          right: 6px; bottom: 2px;
          font-size: 9px;
          color: var(--pmc-secondary-text-color);
          z-index: 2;
          opacity: .8;
        }
        .attribution a { color: inherit; text-decoration: none; }
      </style>
      <ha-card>
        <div class="map">
          <div class="tiles"></div>
          <div class="tint"></div>
          <div class="accuracy" hidden></div>
          <div class="marker" hidden><div class="pin"><ha-icon></ha-icon><div class="dot" hidden></div></div></div>
        </div>
        <div class="content">
          <div class="header">
            <div class="avatar">
              <div class="pic"></div>
              <div class="badge"><ha-icon></ha-icon></div>
            </div>
            <div class="text">
              <div class="primary"></div>
              <div class="secondary"></div>
            </div>
          </div>
          <div class="spacer"></div>
          <div class="chips"></div>
        </div>
        <div class="attribution"></div>
      </ha-card>
    `;
    const root = this.shadowRoot;
    this._card = root.querySelector("ha-card");
    this._mapEl = root.querySelector(".map");
    this._tilesEl = root.querySelector(".tiles");
    this._accuracyEl = root.querySelector(".accuracy");
    this._markerEl = root.querySelector(".marker");
    this._markerIcon = root.querySelector(".marker ha-icon");
    this._markerDot = root.querySelector(".marker .dot");
    this._picEl = root.querySelector(".pic");
    this._badgeIcon = root.querySelector(".badge ha-icon");
    this._primaryEl = root.querySelector(".primary");
    this._secondaryEl = root.querySelector(".secondary");
    this._chipsEl = root.querySelector(".chips");
    this._spacerEl = root.querySelector(".spacer");
    this._attrEl = root.querySelector(".attribution");

    const tint = Number(this._config.tint);
    this._card.style.setProperty("--pmc-tint", Number.isFinite(tint) ? tint : DEFAULTS.tint);
    this._card.style.setProperty("--pmc-marker-size", `${this._markerSize()}px`);
    const pictureSize = Number(this._config.picture_size);
    this._card.style.setProperty(
      "--pmc-picture-size",
      `${Number.isFinite(pictureSize) && pictureSize > 0 ? pictureSize : DEFAULTS.picture_size}px`
    );
    const spacer = Number(this._config.spacer);
    this._card.style.setProperty("--pmc-spacer", `${Number.isFinite(spacer) ? spacer : DEFAULTS.spacer}px`);

    this._card.addEventListener("click", () => this._moreInfo(this._config.entity));
    this._chipsEl.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".chip");
      if (chip) {
        ev.stopPropagation();
        this._moreInfo(chip.dataset.entity);
      }
    });
    if (this._resizeObserver && this.isConnected) {
      this._resizeObserver.disconnect();
      this._resizeObserver.observe(this._mapEl);
    }
  }

  _moreInfo(entityId) {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  /* ----- Update logic ----- */

  _update() {
    if (!this._hass || !this._config || !this._card) return;
    const stateObj = this._hass.states[this._config.entity];
    if (!stateObj) {
      this._primaryEl.textContent = `Entity not found: ${this._config.entity}`;
      return;
    }
    const dark = this._isDark();
    this._card.classList.toggle("dark", dark);
    this._applyShadow(dark);
    this._card.style.setProperty(
      "--pmc-tint-color",
      this._config.theme === "light" ? "#ffffff" : this._config.theme === "dark" ? "#1c1c1c" : ""
    );
    this._card.style.setProperty("--pmc-zone-color", cssColor(this._zoneStyle(stateObj).color));
    this._updateMap(stateObj, dark);
    this._updateInfo();
    this._updateChips();
  }

  _applyShadow(dark) {
    const size = Number(this._config.shadow_size);
    const s = Number.isFinite(size) && size >= 0 ? size : DEFAULTS.shadow_size;
    const custom = this._config.shadow_color;
    const color = custom && custom !== "auto" ? custom : dark ? "black" : "white";
    const px = (value) => `${Math.round(value * s * 100) / 100}px`;
    const text =
      s === 0
        ? "none"
        : `0 0 ${px(2)} ${color}, 0 0 ${px(16)} ${color}, 0 0 ${px(3)} ${color}`;
    // Icons are SVGs, so they need a filter instead of text-shadow. Both are
    // centered (no offset), so the glow sits evenly around text and icons.
    const icon =
      s === 0 ? "none" : `drop-shadow(0 0 ${px(1.5)} ${color}) drop-shadow(0 0 ${px(4)} ${color})`;
    this._card.style.setProperty("--pmc-shadow", text);
    // Room for the largest shadow (16px glow), see .primary
    const pad = Math.ceil(17 * s);
    this._card.style.setProperty("--pmc-shadow-pad", `${pad}px`);
    this._card.style.setProperty("--pmc-shadow-pad-neg", `-${pad}px`);
    this._card.style.setProperty("--pmc-icon-shadow", icon);
  }

  _zoneStyle(stateObj) {
    const state = String(stateObj.state);
    const lower = state.toLowerCase();
    const zone = this._findZone(state, stateObj);
    let base = ZONE_DEFAULTS[lower];
    if (!base) {
      // Any other zone: use the zone's own icon if it has one
      const icon = zone?.attributes.icon;
      base = icon ? { ...OTHER_ZONE_DEFAULT, icon, marker_icon: icon } : OTHER_ZONE_DEFAULT;
    }
    // `zones` can be keyed by state / zone name or by zone entity id
    const custom = this._zones[lower] || (zone && this._zones[zone.entity_id.toLowerCase()]);
    if (!custom) return base;
    const style = { ...base, ...custom };
    // A custom icon is also used for the marker, unless marker_icon is given
    if (custom.icon && !("marker_icon" in custom)) style.marker_icon = custom.icon;
    return style;
  }

  _updateMarkerIcon(zoneStyle) {
    const icon = zoneStyle.marker_icon ?? zoneStyle.icon;
    this._markerIcon.hidden = !icon;
    this._markerDot.hidden = Boolean(icon);
    if (icon) this._markerIcon.icon = icon;
  }

  _findZone(state, stateObj) {
    if (state === "home") return this._hass.states["zone.home"];
    // The state is the zone's name; compare case-insensitively and also accept
    // the zone's entity id (e.g. state "vector" for zone.vector named "Vector")
    const lower = String(state).toLowerCase();
    const zones = Object.values(this._hass.states).filter((s) => s.entity_id.startsWith("zone."));
    const byName =
      zones.find((z) => String(z.attributes.friendly_name ?? "").toLowerCase() === lower) ||
      this._hass.states[`zone.${lower.replace(/[^a-z0-9_]+/g, "_")}`];
    if (byName) return byName;
    // Device trackers list the zones they are in
    const inZones = stateObj?.attributes?.in_zones;
    if (Array.isArray(inZones) && inZones.length && state !== "not_home") {
      return this._hass.states[inZones[0]];
    }
    return undefined;
  }

  _location(stateObj) {
    const trackerObj = this._config.tracker ? this._hass.states[this._config.tracker] : null;
    for (const obj of [trackerObj, stateObj]) {
      const a = obj?.attributes;
      const lat = parseCoordinate(a?.latitude);
      const lon = parseCoordinate(a?.longitude);
      if (lat != null && lon != null) {
        return { lat, lon, accuracy: Number(a.gps_accuracy) || 0 };
      }
    }
    // Fall back to the coordinates of the zone the person is in
    const zone = this._findZone(stateObj.state, stateObj);
    const lat = parseCoordinate(zone?.attributes.latitude);
    const lon = parseCoordinate(zone?.attributes.longitude);
    if (lat != null && lon != null) {
      return { lat, lon, accuracy: Number(zone.attributes.radius) || 0 };
    }
    return null;
  }

  _normalizeLegacyConfig(config) {
    const c = this._config;
    c.map_style = normalizeStyle(c.map_style);
    if (!config.theme && LEGACY_THEMES[config.dark_mode]) c.theme = LEGACY_THEMES[config.dark_mode];
  }

  _isDark() {
    const theme = this._config.theme;
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return Boolean(this._hass.themes?.darkMode);
  }

  _style(dark) {
    if (this._config.tile_url) {
      return {
        name: "custom",
        url: this._config.tile_url,
        attribution: this._config.attribution || "© OpenStreetMap contributors",
        maxZoom: 22,
      };
    }
    let name = this._config.map_style;
    if (MAP_STYLES[name].proxy) {
      if (mapTiles.status === "unknown") return null; // still asking for a token
      if (mapTiles.status !== "ok") name = "osm"; // HA older than 2026.10
    }
    const style = MAP_STYLES[name];
    return {
      ...style,
      name,
      url: (dark && style.darkUrl) || style.url,
      darkFilter: Boolean(dark && style.darkFilter),
    };
  }

  _apiKey(style) {
    return (style.keyOption && this._config[style.keyOption]) || this._config.api_key || "";
  }

  _ensureMapTilesToken() {
    const connection = this._hass?.connection;
    if (!connection) {
      mapTiles.status = "unavailable";
      return;
    }
    const retry =
      mapTiles.status === "unavailable" && Date.now() - mapTiles.failedAt > TOKEN_RETRY_MS;
    if (mapTiles.status !== "unknown" && !retry) return;
    const before = mapTiles.status;
    fetchMapTilesToken(connection).then(() => {
      if (mapTiles.status !== before || before === "unknown") {
        this._mapKey = null;
        this._update();
      }
    });
  }

  _onTileError() {
    // Most likely an expired token (e.g. the device was asleep): get a new one
    // and redraw, at most once a minute.
    if (Date.now() - (this._tileRetryAt || 0) < TOKEN_RETRY_MS || !this._hass?.connection) return;
    this._tileRetryAt = Date.now();
    fetchMapTilesToken(this._hass.connection).then(() => {
      this._mapKey = null;
      this._update();
    });
  }

  _instanceUrl(path) {
    if (!path.startsWith("/")) return path;
    // On Cast the page is not served by the instance, so use its URL
    const base = this._hass?.auth?.data?.hassUrl || location.origin;
    return base.replace(/\/+$/, "") + path;
  }

  _tileUrl(template, apiKey, x, y, z) {
    const subdomains = ["a", "b", "c", "d"];
    const retina = (window.devicePixelRatio || 1) > 1 ? "@2x" : "";
    return template
      .replace("{s}", subdomains[Math.abs(x + y) % subdomains.length])
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y)
      .replace("{r}", retina)
      .replace("{api_key}", encodeURIComponent(apiKey))
      .replace("{token}", encodeURIComponent(mapTiles.token || ""));
  }

  _markerSize() {
    const size = Number(this._config.marker_size);
    return Number.isFinite(size) && size > 0 ? size : DEFAULTS.marker_size;
  }

  _anchor(width, height) {
    // The location is drawn horizontally centered. Vertically the marker sits
    // in the free space between header and chips, so it isn't covered by text.
    // marker_offset_x / marker_offset_y move the marker (and the map with it).
    const offsetX = Number(this._config.marker_offset_x) || 0;
    const offsetY = Number(this._config.marker_offset_y) || 0;
    const spacerHeight = this._spacerEl.offsetHeight;
    return {
      x: width / 2 + offsetX,
      y:
        (spacerHeight >= 24
          ? this._spacerEl.offsetTop + spacerHeight / 2 + (this._config.show_marker ? this._markerSize() * 0.6 : 0)
          : height / 2) + offsetY,
    };
  }

  _updateMap(stateObj, dark) {
    const loc = this._location(stateObj);
    if (this._config.map_style === "ha" && !this._config.tile_url && haMapLoader.status !== "unavailable") {
      if (haMapLoader.status !== "ok") {
        loadHaMap().then(() => {
          this._mapKey = null;
          this._update();
        });
        return;
      }
      this._updateHaMap(stateObj, loc, dark);
      return;
    }
    this._removeHaMap();
    if (!this._config.tile_url) this._ensureMapTilesToken();
    const style = this._style(dark);
    if (!style) return; // waiting for the Home Assistant map tiles token
    const zoom = Math.max(1, Math.min(Math.round(Number(this._config.zoom) || DEFAULTS.zoom), style.maxZoom));
    const width = this._mapEl.clientWidth;
    const height = this._mapEl.clientHeight;
    const zoneStyle = this._zoneStyle(stateObj);

    this._tilesEl.classList.toggle(
      "gray",
      Boolean(this._config.grayscale_away && stateObj.state === "not_home")
    );
    this._tilesEl.classList.toggle(
      "dark",
      Boolean(style.darkFilter)
    );
    this._updateMarkerIcon(zoneStyle);
    this._markerEl.hidden = !this._config.show_marker || !loc;

    if (!loc) {
      this._tilesEl.replaceChildren();
      this._accuracyEl.hidden = true;
      this._attrEl.innerHTML = "";
      this._mapKey = null;
      return;
    }
    const apiKey = this._apiKey(style);
    if (style.url.includes("{api_key}") && !apiKey) {
      this._tilesEl.replaceChildren();
      this._attrEl.textContent = `Map style "${style.name}" needs an API key (option ${style.keyOption || "api_key"})`;
      this._mapKey = null;
      return;
    }
    this._attrEl.innerHTML = `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${escapeHtml(style.attribution)}</a>`;

    const { x: anchorX, y: anchorY } = this._anchor(width, height);

    const key = [loc.lat, loc.lon, loc.accuracy, zoom, style.url, apiKey, width, height, anchorX, anchorY].join("|");
    if (key === this._mapKey || width === 0 || height === 0) return;
    this._mapKey = key;
    const left = lonToWorldX(loc.lon, zoom) - anchorX;
    const top = latToWorldY(loc.lat, zoom) - anchorY;

    const n = 2 ** zoom;
    const x0 = Math.floor(left / TILE_SIZE);
    const x1 = Math.floor((left + width) / TILE_SIZE);
    const y0 = Math.max(0, Math.floor(top / TILE_SIZE));
    const y1 = Math.min(n - 1, Math.floor((top + height) / TILE_SIZE));

    const frag = document.createDocumentFragment();
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.referrerPolicy = "strict-origin-when-cross-origin";
        if (style.proxy) img.addEventListener("error", () => this._onTileError(), { once: true });
        img.src = this._instanceUrl(this._tileUrl(style.url, apiKey, ((tx % n) + n) % n, ty, zoom));
        img.style.left = `${Math.round(tx * TILE_SIZE - left)}px`;
        img.style.top = `${Math.round(ty * TILE_SIZE - top)}px`;
        frag.appendChild(img);
      }
    }
    this._tilesEl.replaceChildren(frag);

    this._placeMarker(loc, zoom, anchorX, anchorY, width, height);
  }

  _placeMarker(loc, zoom, anchorX, anchorY, width, height) {
    this._markerEl.style.left = `${anchorX}px`;
    this._markerEl.style.top = `${anchorY}px`;
    const radiusPx = loc.accuracy / metersPerPixel(loc.lat, zoom);
    const showAcc = this._config.show_accuracy && radiusPx > 6;
    this._accuracyEl.hidden = !showAcc;
    if (showAcc) {
      const d = Math.min(radiusPx * 2, Math.max(width, height) * 3);
      Object.assign(this._accuracyEl.style, {
        left: `${anchorX}px`,
        top: `${anchorY}px`,
        width: `${d}px`,
        height: `${d}px`,
      });
    }
  }

  _updateHaMap(stateObj, loc, dark) {
    const zoneStyle = this._zoneStyle(stateObj);
    this._updateMarkerIcon(zoneStyle);
    this._markerEl.hidden = !this._config.show_marker || !loc;
    this._tilesEl.replaceChildren();
    this._tilesEl.classList.remove("dark");
    // <ha-map> shows its own attribution
    this._attrEl.innerHTML = "";

    if (!this._haMap) {
      this._haMap = document.createElement("ha-map");
      this._haMap.entities = [];
      this._haMap.clickable = false;
      this._haMap.autoFit = false;
      this._mapEl.insertBefore(this._haMap, this._tilesEl);
    }
    const map = this._haMap;
    this._injectHaMapStyle();
    const themeMode = dark ? "dark" : "light";
    if (map.themeMode !== themeMode) map.themeMode = themeMode;
    map.classList.toggle("gray", Boolean(this._config.grayscale_away && stateObj.state === "not_home"));

    if (!loc) {
      this._accuracyEl.hidden = true;
      this._mapKey = null;
      return;
    }
    const zoom = Math.max(1, Math.min(Math.round(Number(this._config.zoom) || DEFAULTS.zoom), 20));
    const width = this._mapEl.clientWidth;
    const height = this._mapEl.clientHeight;
    const { x: anchorX, y: anchorY } = this._anchor(width, height);
    const key = ["ha-map", loc.lat, loc.lon, loc.accuracy, zoom, themeMode, width, height, anchorX, anchorY].join("|");
    if (key === this._mapKey || width === 0 || height === 0) return;
    this._mapKey = key;

    // Center the map so that the location ends up at the anchor point
    const cx = lonToWorldX(loc.lon, zoom) - (anchorX - width / 2);
    const cy = latToWorldY(loc.lat, zoom) - (anchorY - height / 2);
    this._view = { center: [worldYToLat(cy, zoom), worldXToLon(cx, zoom)], zoom };
    if (map.zoom !== zoom) map.zoom = zoom;
    this._applyHaMapView();
    this._placeMarker(loc, zoom, anchorX, anchorY, width, height);
  }

  _injectHaMapStyle() {
    // <ha-map> only creates its shadow root once it is connected, which can be
    // after the card got its first hass update, so this runs repeatedly.
    const map = this._haMap;
    const root = map?.renderRoot || map?.shadowRoot;
    if (!root || root.querySelector("style[data-person-map-card]")) return;
    const style = document.createElement("style");
    style.dataset.personMapCard = "";
    style.textContent = HA_MAP_STYLE;
    root.appendChild(style);
  }

  _applyHaMapView() {
    // <ha-map> may set its own view once its engine has loaded (or reloaded
    // after a theme change), so check for a few seconds and re-apply.
    clearTimeout(this._viewTimer);
    const map = this._haMap;
    const view = this._view;
    if (!map || !view) return;
    map.setView(view.center, view.zoom);
    let checks = 0;
    const check = () => {
      if (this._haMap !== map || this._view !== view) return;
      this._injectHaMapStyle();
      const current = map.getView?.();
      const off =
        !current ||
        Math.abs(current.zoom - view.zoom) > 0.01 ||
        Math.abs(current.center[0] - view.center[0]) > 1e-6 ||
        Math.abs(current.center[1] - view.center[1]) > 1e-6;
      if (off && current) map.setView(view.center, view.zoom);
      if (++checks < 20) this._viewTimer = setTimeout(check, 250);
    };
    this._viewTimer = setTimeout(check, 250);
  }

  _removeHaMap() {
    if (!this._haMap) return;
    clearTimeout(this._viewTimer);
    this._haMap.remove();
    this._haMap = null;
    this._view = null;
  }

  _name(stateObj) {
    return this._config.name || stateObj.attributes.friendly_name || stateObj.entity_id;
  }

  _address() {
    const sensor = this._config.geocoded_sensor;
    if (!sensor) return "";
    const s = this._hass.states[sensor];
    if (!s) return "";
    const attrs = this._config.geocoded_attributes || DEFAULTS.geocoded_attributes;
    const values = attrs.map((a) => s.attributes[a]).map((v) => (v == null ? "" : String(v).trim()));
    // Default format: "Name, Postal Code Sub Locality" (like the original card)
    const [first, ...rest] = values;
    const tail = rest.filter(Boolean).join(" ");
    const address = [first, tail].filter(Boolean).join(", ");
    if (address) return address;
    return s.state && !["unknown", "unavailable"].includes(s.state) ? s.state : "";
  }

  _updateInfo() {
    if (!this._hass || !this._config || !this._card) return;
    const stateObj = this._hass.states[this._config.entity];
    if (!stateObj) return;

    const name = this._name(stateObj);
    this._primaryEl.textContent = name;

    const parts = [];
    if (this._config.show_state) {
      const formatted =
        typeof this._hass.formatEntityState === "function"
          ? this._hass.formatEntityState(stateObj)
          : stateObj.state;
      parts.push(formatted);
    }
    const address = this._address();
    if (address) parts.push(address);
    if (this._config.show_last_changed && stateObj.last_changed) {
      parts.push(relativeTime(new Date(stateObj.last_changed), this._hass.locale?.language || this._hass.language));
    }
    this._secondaryEl.textContent = parts.join(" | ");

    const picture = this._config.picture || stateObj.attributes.entity_picture;
    if (picture) {
      this._picEl.style.backgroundImage = `url("${picture.replace(/"/g, "%22")}")`;
      this._picEl.textContent = "";
    } else {
      this._picEl.style.backgroundImage = "";
      this._picEl.textContent = name
        .split(/\s+/)
        .map((p) => p[0] || "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }
    this._badgeIcon.icon = this._zoneStyle(stateObj).icon;
  }

  _updateChips() {
    const entities = this._config.entities || [];
    const html = entities
      .map((conf) => {
        const s = this._hass.states[conf.entity];
        if (!s) return "";
        const value =
          typeof this._hass.formatEntityState === "function"
            ? this._hass.formatEntityState(s)
            : `${s.state}${s.attributes.unit_of_measurement ? " " + s.attributes.unit_of_measurement : ""}`;
        return `<div class="chip" data-entity="${escapeHtml(conf.entity)}">
          <ha-state-icon></ha-state-icon><span>${escapeHtml(value)}</span></div>`;
      })
      .join("");
    if (html !== this._chipsHtml) {
      this._chipsHtml = html;
      this._chipsEl.innerHTML = html;
    }
    // ha-state-icon takes its data as properties
    const icons = this._chipsEl.querySelectorAll("ha-state-icon");
    let i = 0;
    for (const conf of entities) {
      const s = this._hass.states[conf.entity];
      if (!s) continue;
      const icon = icons[i++];
      if (!icon) continue;
      icon.hass = this._hass;
      icon.stateObj = s;
      if (conf.icon) icon.icon = conf.icon;
    }
  }
}

if (!customElements.get("person-map-card")) {
  customElements.define("person-map-card", PersonMapCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "person-map-card")) {
  window.customCards.push({
    type: "person-map-card",
    name: "Person Map Card",
    description: "Person card with an OpenStreetMap background (no API key needed).",
    preview: true,
    documentationURL: "https://github.com/ElVit/person-map-card",
  });
}

console.info(
  `%c PERSON-MAP-CARD %c v${CARD_VERSION} `,
  "color: white; background: #039be5; font-weight: 700;",
  "color: #039be5; background: white; font-weight: 700;"
);
