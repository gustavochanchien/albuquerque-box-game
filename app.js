// ABQ Balloon Box main client script
// - Single-file front-end: MapLibre + custom particle renderer
// - No private APIs; all public tile/vector sources
// - Organized into: config, data, map setup, balloon logic, render loop, UI wiring

document.addEventListener('DOMContentLoaded', () => {
    /* ------------------------------------------------------------------
     *  Global configuration
     * ------------------------------------------------------------------ */
    const CONFIG = {
        trailFade: 0.09,         // How quickly old wind streaks fade when idle
        moveFade: 0.9,           // Faster fade while user is moving the camera
        particleCount: 10000,    // Total particles across all wind layers
        simSpeed: 0.3,           // Particle simulation step factor
        lineWidth: 3.5,          // Particle stroke width
        windOpacity: 0.8,        // Global alpha for wind visuals (slider driven)
        colors: {
            surface: '#0000ff',
            canyon:  '#2bf8ff',
            mid:     '#ff0000',
            high:    '#ffff00',
            jet:     '#00ff00',
        },
    };

    const GRID_RES = 30;
    const BOUNDS = [-107.0, 34.8, -106.3, 35.4]; // Wind grid domain
    const NAV_BOUNDS = [
        [BOUNDS[0] - 0.6, BOUNDS[1] - 0.6],
        [BOUNDS[2] + 0.6, BOUNDS[3] + 0.6],
    ];

    let currentExaggeration = 5.0;
    const BASE_BUILDING_HEIGHT_M = 25; // Base extrusion height before exaggeration multiplier
    let balloonSpeed = 0.1;
    let isMoving = false;              // Map camera is moving
    let isChasing = false;             // Chase cam mode

    // Balloon Fiesta Park reference (used in HUD + chase cam)
    const PARK_LAT = 35.196638;
    const PARK_LNG = -106.597042;

    // Chase cam config:
    // Reference view you provided:
    //   center: [-106.6028, 35.2134]
    //   zoom: 13.44
    //   pitch: 39
    //   bearing: -25
    //   exaggeration: 1x
    //
    // We compute the offset from park -> camera in degrees:
    //   offsetLng = centerLng - parkLng
    //   offsetLat = centerLat - parkLat
    //   = -0.005758, 0.016762
    const CHASE_CONFIG = {
        offsetLng: -0.005758,
        offsetLat:  0.016762,
        zoom:       13.44,
        pitch:      39,
        bearing:   -25,
        exaggeration: 1.0,
    };

    /* ------------------------------------------------------------------
     *  Utility helpers
     * ------------------------------------------------------------------ */

    function hexToRgb(hex) {
        const result =
            /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  r: parseInt(result[1], 16),
                  g: parseInt(result[2], 16),
                  b: parseInt(result[3], 16),
              }
            : { r: 255, g: 255, b: 255 };
    }

    // Simple 2D vector field with bilinear interpolation
    class VectorGrid {
        constructor(width, height, bounds) {
            this.width = width;
            this.height = height;
            this.bounds = bounds;
            this.u = new Float32Array(width * height);
            this.v = new Float32Array(width * height);
        }
        setVector(x, y, uVal, vVal) {
            const i = y * this.width + x;
            this.u[i] = uVal;
            this.v[i] = vVal;
        }
        getVectorAt(lng, lat) {
            const lngPct =
                (lng - this.bounds[0]) /
                (this.bounds[2] - this.bounds[0]);
            const latPct =
                (lat - this.bounds[1]) /
                (this.bounds[3] - this.bounds[1]);
            if (lngPct < 0 || lngPct > 1 || latPct < 0 || latPct > 1)
                return { u: 0, v: 0 };

            const gridX = lngPct * (this.width - 1);
            const gridY = latPct * (this.height - 1);
            const x0 = Math.floor(gridX);
            const x1 = Math.min(x0 + 1, this.width - 1);
            const y0 = Math.floor(gridY);
            const y1 = Math.min(y0 + 1, this.height - 1);
            const wx = gridX - x0;
            const wy = gridY - y0;

            const i00 = y0 * this.width + x0;
            const i10 = y0 * this.width + x1;
            const i01 = y1 * this.width + x0;
            const i11 = y1 * this.width + x1;

            const uTop = (1 - wx) * this.u[i00] + wx * this.u[i10];
            const uBot = (1 - wx) * this.u[i01] + wx * this.u[i11];
            const finalU = (1 - wy) * uTop + wy * uBot;

            const vTop = (1 - wx) * this.v[i00] + wx * this.v[i10];
            const vBot = (1 - wx) * this.v[i01] + wx * this.v[i11];
            const finalV = (1 - wy) * vTop + wy * vBot;

            return { u: finalU, v: finalV };
        }
    }

    /* ------------------------------------------------------------------
     *  Procedural wind data (no network)
     * ------------------------------------------------------------------ */

    const weatherData = {
        surface: new VectorGrid(GRID_RES, GRID_RES, BOUNDS),
        canyon:  new VectorGrid(GRID_RES, GRID_RES, BOUNDS),
        mid:     new VectorGrid(GRID_RES, GRID_RES, BOUNDS),
        high:    new VectorGrid(GRID_RES, GRID_RES, BOUNDS),
        jet:     new VectorGrid(GRID_RES, GRID_RES, BOUNDS),
    };

    function generateForecastData() {
        for (let y = 0; y < GRID_RES; y++) {
            for (let x = 0; x < GRID_RES; x++) {
                const lng =
                    BOUNDS[0] +
                    (x / (GRID_RES - 1)) * (BOUNDS[2] - BOUNDS[0]);
                const lat =
                    BOUNDS[1] +
                    (y / (GRID_RES - 1)) * (BOUNDS[3] - BOUNDS[1]);

                // Surface: generally southward with terrain-influenced east/west
                let surfU = Math.sin(lat * 15) * 0.0001;
                let surfV = -0.0006;
                if (lat < 35.0) surfU += (lng - -106.65) * 0.002;
                weatherData.surface.setVector(x, y, surfU, surfV);

                // Canyon: subtle north-west, stronger near a "canyon" band
                let canU = -0.0002;
                let canV = -0.0002;
                if (lat > 35.0 && lat < 35.15 && lng > -106.7) {
                    const intensity = Math.max(
                        0,
                        1 - Math.abs(lat - 35.07) * 20
                    );
                    canU -= intensity * 0.0015;
                }
                weatherData.canyon.setVector(x, y, canU, canV);

                // Mid layer: slight eastward with longitude oscillation
                weatherData.mid.setVector(
                    x,
                    y,
                    0.0003,
                    Math.cos(lng * 20) * 0.0002
                );

                // High: broad rotating pattern + north push
                const centerLng = -107.5;
                const centerLat = 35.1;
                const dx = lng - centerLng;
                const dy = lat - centerLat;
                let highU = -dy * 0.001;
                let highV = dx * 0.001 + 0.0009;
                weatherData.high.setVector(x, y, highU, highV);

                // Jet stream: fast west -> east with minor noise
                const jetU = 0.002 + Math.random() * 0.0002;
                const jetV = 0.0002;
                weatherData.jet.setVector(x, y, jetU, jetV);
            }
        }
    }
    generateForecastData();

    const LAYER_CONFIG = {
        surface: {
            type: 'surface',
            active: true,
            grid: weatherData.surface,
            color: CONFIG.colors.surface,
            rgb:   hexToRgb(CONFIG.colors.surface),
            ratio: 0.25,
            altitude: 0,
        },
        canyon: {
            type: 'canyon',
            active: true,
            grid: weatherData.canyon,
            color: CONFIG.colors.canyon,
            rgb:   hexToRgb(CONFIG.colors.canyon),
            ratio: 0.15,
            altitude: 6000,
        },
        mid: {
            type: 'mid',
            active: true,
            grid: weatherData.mid,
            color: CONFIG.colors.mid,
            rgb:   hexToRgb(CONFIG.colors.mid),
            ratio: 0.20,
            altitude: 7500,
        },
        high: {
            type: 'high',
            active: true,
            grid: weatherData.high,
            color: CONFIG.colors.high,
            rgb:   hexToRgb(CONFIG.colors.high),
            ratio: 0.20,
            altitude: 10500,
        },
        jet: {
            type: 'jet',
            active: true,
            grid: weatherData.jet,
            color: CONFIG.colors.jet,
            rgb:   hexToRgb(CONFIG.colors.jet),
            ratio: 0.20,
            altitude: 18000,
        },
    };
    const sortedLayers = Object.values(LAYER_CONFIG).sort(
        (a, b) => a.altitude - b.altitude
    );

    /* ------------------------------------------------------------------
     *  Orbit arrow colors (minimap)
     * ------------------------------------------------------------------ */

    document.querySelector('#orbit-surf .orbit-arrow').style.borderBottomColor =
        CONFIG.colors.surface;
    document.querySelector('#orbit-can .orbit-arrow').style.borderBottomColor =
        CONFIG.colors.canyon;
    document.querySelector('#orbit-mid .orbit-arrow').style.borderBottomColor =
        CONFIG.colors.mid;
    document.querySelector('#orbit-high .orbit-arrow').style.borderBottomColor =
        CONFIG.colors.high;
    document.querySelector('#orbit-jet .orbit-arrow').style.borderBottomColor =
        CONFIG.colors.jet;

    /* ------------------------------------------------------------------
     *  Map + minimap setup
     * ------------------------------------------------------------------ */

    const aviationZonesGeoJSON = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [-106.66, 35.06],
                            [-106.56, 35.06],
                            [-106.56, 35.02],
                            [-106.66, 35.02],
                            [-106.66, 35.06],
                        ],
                    ],
                },
            },
            {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [-106.82, 35.16],
                            [-106.77, 35.16],
                            [-106.77, 35.13],
                            [-106.82, 35.13],
                            [-106.82, 35.16],
                        ],
                    ],
                },
            },
        ],
    };

    const map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                satellite: {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                    ],
                    tileSize: 256,
                    attribution: 'Esri',
                },
                'terrain-source-mesh': {
                    type: 'raster-dem',
                    tiles: [
                        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
                    ],
                    encoding: 'terrarium',
                    tileSize: 256,
                    maxzoom: 15,
                },
                'airspace-source': {
                    type: 'geojson',
                    data: aviationZonesGeoJSON,
                },
            },
            layers: [
                {
                    id: 'sat-base',
                    type: 'raster',
                    source: 'satellite',
                    minzoom: 0,
                    maxzoom: 22,
                    paint: {
                        'raster-opacity': 1.0,
                        'raster-brightness-min': 0.2,
                        'raster-brightness-max': 1.0,
                        'raster-saturation': -0.2,
                        'raster-contrast': 0.1,
                    },
                },
                {
                    id: 'airspace-outline',
                    type: 'line',
                    source: 'airspace-source',
                    paint: {
                        'line-color': '#ff4444',
                        'line-width': 2,
                        'line-dasharray': [2, 2],
                        'line-opacity': 0.8,
                    },
                },
            ],
            fog: {
                range: [-1, 2.0],
                color: '#020814',
                'high-color': '#020814',
                'space-color': '#000000',
                'horizon-blend': 0.1,
            },
        },
        center: [-106.587, 35.163], // Balloon Fiesta area (default view)
        zoom: 13.49,
        pitch: 76,
        maxPitch: 85,
        bearing: 0,
        maxBounds: NAV_BOUNDS,
        boxZoom: false,
    });

    const miniMap = new maplibregl.Map({
        container: 'minimap',
        style: {
            version: 8,
            sources: {
                satellite: {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                    ],
                    tileSize: 256,
                },
                'balloon-live': {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: [],
                    },
                },
            },
            layers: [
                {
                    id: 'mini-base',
                    type: 'raster',
                    source: 'satellite',
                    paint: {
                        'raster-opacity': 1.0,
                        'raster-contrast': 0.1,
                    },
                },
                {
                    id: 'mini-trail',
                    type: 'line',
                    source: 'balloon-live',
                    paint: {
                        'line-color': '#ff4444',
                        'line-width': 2,
                        'line-opacity': 0.8,
                    },
                },
            ],
        },
        center: [-106.6504, 35.11],
        zoom: 13,
        interactive: false,
        attributionControl: false,
    });

    const debugEl = document.getElementById('debug-output');
    const btnCopy = document.getElementById('btn-copy-cam');

    function updateDebug() {
        const c = map.getCenter();
        const p = map.getPitch();
        const b = map.getBearing();
        const z = map.getZoom();
        const txt = `center: [${c.lng.toFixed(4)}, ${c.lat.toFixed(
            4
        )}],
zoom: ${z.toFixed(2)},
pitch: ${p.toFixed(0)},
bearing: ${b.toFixed(0)}`;
        debugEl.innerText = txt;
    }

    // Buildings scale with terrain exaggeration
    function updateBuildingHeights() {
        if (!map.getLayer('3d-buildings')) return;
        const scaledHeight = BASE_BUILDING_HEIGHT_M * currentExaggeration;
        map.setPaintProperty('3d-buildings', 'fill-extrusion-height', [
            'interpolate',
            ['linear'],
            ['zoom'],
            14,
            0,
            16,
            scaledHeight,
        ]);
    }

    // Central place to change terrain exaggeration
    function setExaggeration(val) {
        currentExaggeration = val;
        document.getElementById('terrain-slider').value = val;
        document.getElementById('terrain-val').innerText =
            val.toFixed(1) + 'x';
        if (map.getSource('terrain-source-mesh')) {
            map.setTerrain({
                source: 'terrain-source-mesh',
                exaggeration: val,
            });
        }
        updateBuildingHeights();
    }

    function setBuildingsVisible(visible) {
        if (!map.getLayer('3d-buildings')) return;
        map.setLayoutProperty(
            '3d-buildings',
            'visibility',
            visible ? 'visible' : 'none'
        );
    }

    btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(debugEl.innerText).then(() => {
            const orig = btnCopy.innerText;
            btnCopy.innerText = 'COPIED!';
            setTimeout(() => (btnCopy.innerText = orig), 1000);
        });
    });

    /* ------------------------------------------------------------------
     *  3D buildings source + layer (public OSM vector tiles)
     * ------------------------------------------------------------------ */

    map.on('load', () => {
        map.setTerrain({
            source: 'terrain-source-mesh',
            exaggeration: currentExaggeration,
        });

        map.addSource('osm-buildings', {
            type: 'vector',
            tiles: [
                'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt',
            ],
            minzoom: 0,
            maxzoom: 14,
        });

        map.addLayer(
            {
                id: '3d-buildings',
                type: 'fill-extrusion',
                source: 'osm-buildings',
                'source-layer': 'buildings',
                minzoom: 14,
                paint: {
                    'fill-extrusion-color': '#d8d8d8',
                    'fill-extrusion-opacity': 0.9,
                    'fill-extrusion-height': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        14,
                        0,
                        16,
                        BASE_BUILDING_HEIGHT_M,
                    ],
                    'fill-extrusion-base': 0,
                },
            },
            'airspace-outline'
        );

        updateBuildingHeights();

        const buildingsChecked =
            document.getElementById('check-buildings')?.checked;
        if (typeof buildingsChecked === 'boolean') {
            setBuildingsVisible(buildingsChecked);
        }

        updateDebug();
    });

    map.on('move', updateDebug);
    map.on('zoom', updateDebug);
    map.on('rotate', updateDebug);
    map.on('pitch', updateDebug);

    /* ------------------------------------------------------------------
     *  Wind sampling + color blending helpers
     * ------------------------------------------------------------------ */

    function getWindAtAltitude(lng, lat, altFeet) {
        let lower = sortedLayers[0];
        let upper = sortedLayers[sortedLayers.length - 1];
        for (let i = 0; i < sortedLayers.length - 1; i++) {
            if (
                altFeet >= sortedLayers[i].altitude &&
                altFeet <= sortedLayers[i + 1].altitude
            ) {
                lower = sortedLayers[i];
                upper = sortedLayers[i + 1];
                break;
            }
        }

        const vLow = lower.grid.getVectorAt(lng, lat);
        if (altFeet >= upper.altitude)
            return upper.grid.getVectorAt(lng, lat);
        if (altFeet <= lower.altitude) return vLow;

        const pct =
            (altFeet - lower.altitude) /
            (upper.altitude - lower.altitude);
        const vHigh = upper.grid.getVectorAt(lng, lat);

        return {
            u: vLow.u * (1 - pct) + vHigh.u * pct,
            v: vLow.v * (1 - pct) + vHigh.v * pct,
        };
    }

    function getColorForAltitude(altFeet) {
        let r = 0,
            g = 0,
            b = 0;
        let lower = sortedLayers[0];
        let upper = sortedLayers[sortedLayers.length - 1];
        let t = 0;

        if (altFeet <= lower.altitude) {
            r = lower.rgb.r;
            g = lower.rgb.g;
            b = lower.rgb.b;
        } else if (altFeet >= upper.altitude) {
            r = upper.rgb.r;
            g = upper.rgb.g;
            b = upper.rgb.b;
        } else {
            for (let i = 0; i < sortedLayers.length - 1; i++) {
                if (
                    altFeet >= sortedLayers[i].altitude &&
                    altFeet <= sortedLayers[i + 1].altitude
                ) {
                    lower = sortedLayers[i];
                    upper = sortedLayers[i + 1];
                    break;
                }
            }
            t =
                (altFeet - lower.altitude) /
                (upper.altitude - lower.altitude);
            r = Math.floor(lower.rgb.r * (1 - t) + upper.rgb.r * t);
            g = Math.floor(lower.rgb.g * (1 - t) + upper.rgb.g * t);
            b = Math.floor(lower.rgb.b * (1 - t) + upper.rgb.b * t);
        }
        return `rgb(${r},${g},${b})`;
    }

    /* ------------------------------------------------------------------
     *  Balloon model + HUD sync
     * ------------------------------------------------------------------ */

    class PlayerBalloon {
        constructor() {
            this.active = false;
            this.lng = 0;
            this.lat = 0;
            this.alt = 5000;
            this.groundAlt = 5000;
            this.verticalSpeed = 0;
            this.history = [];
            this.currentWind = { u: 0, v: 0 };
            this.groundTimer = 0; // time since last lift while on ground
            this.lastDriftX = 0;
            this.lastDriftY = 0;
        }

        // Spawn at clicked location, hugging local terrain
        spawn(lng, lat) {
            this.active = true;
            this.lng = lng;
            this.lat = lat;
            const elevM =
                map.queryTerrainElevation([lng, lat]) || 1500;
            this.groundAlt = elevM * 3.28084;
            this.alt = this.groundAlt;
            this.verticalSpeed = 0;
            this.history = [];
            this.currentWind = { u: 0, v: 0 };
            this.groundTimer = 0;
        }

        // Integrate vertical motion + horizontal drift
        update(burnerOn) {
            if (!this.active) return;

            const elevM = map.queryTerrainElevation([this.lng, this.lat]);
            if (elevM !== null) this.groundAlt = elevM * 3.28084;

            const GRAVITY = -15;
            const LIFT = 50;
            const DRAG = 0.95;

            if (burnerOn) this.verticalSpeed += LIFT * 0.1;
            this.verticalSpeed += GRAVITY * 0.1;
            this.verticalSpeed *= DRAG;
            this.alt += this.verticalSpeed;

            // Hard floor on terrain
            if (this.alt < this.groundAlt) {
                this.alt = this.groundAlt;
                this.verticalSpeed = 0;
            }

            const onGround = this.alt <= this.groundAlt + 1;
            let windFactor = 1.0;

            // Ground-stop logic:
            // if on ground and burner is off, fade motion to zero over ~1.5 s
            if (onGround && !burnerOn) {
                this.groundTimer += 0.1;
                const stopAfter = 1.5;
                if (this.groundTimer >= stopAfter) {
                    windFactor = 0;
                } else {
                    windFactor = Math.max(
                        0,
                        1 - this.groundTimer / stopAfter
                    );
                }
            } else {
                this.groundTimer = 0;
            }

            this.currentWind = getWindAtAltitude(
                this.lng,
                this.lat,
                this.alt
            );

            this.lng += this.currentWind.u * balloonSpeed * windFactor;
            this.lat += this.currentWind.v * balloonSpeed * windFactor;

            // HUD stats
            document.getElementById('alt-display').innerText =
                Math.floor(this.alt);
            document.getElementById('vs-display').innerText =
                Math.floor(this.verticalSpeed);

            // Trail minimization: only push point when movement significant
            if (
                this.history.length === 0 ||
                Math.abs(
                    this.lng - this.history[this.history.length - 1].lng
                ) +
                    Math.abs(
                        this.lat -
                            this.history[this.history.length - 1].lat
                    ) >
                    0.0001
            ) {
                this.history.push({
                    lng: this.lng,
                    lat: this.lat,
                    altM: this.alt * 0.3048,
                });
                if (this.history.length > 80) this.history.shift();
            }

            // Minimap trail + center
            miniMap.setCenter([this.lng, this.lat]);
            const geojson = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: this.history.map(h => [
                                h.lng,
                                h.lat,
                            ]),
                        },
                    },
                ],
            };
            const src = miniMap.getSource('balloon-live');
            if (src) src.setData(geojson);

            this.updateHUD();
        }

        // Update altimeter, orbit arrows, minimap park indicator
        updateHUD() {
            const minH = 4500;
            const maxH = 20000;
            let pct =
                (this.alt - minH) /
                (maxH - minH);
            if (pct < 0) pct = 0;
            if (pct > 1) pct = 1;

            document.getElementById('alt-needle').style.bottom =
                pct * 100 + '%';
            document.getElementById('alt-text').innerText =
                this.alt > -1000 ? Math.floor(this.alt) : '---';

            const colorStr = getColorForAltitude(this.alt);
            const playerArrow = document.getElementById('player-arrow');
            playerArrow.style.backgroundColor = colorStr;

            const angleRad = Math.atan2(
                this.currentWind.u,
                this.currentWind.v
            );
            const angleDeg = (angleRad * 180) / Math.PI;
            playerArrow.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;

            // Ring of orbit arms showing speed/direction in each layer
            const arrows = [
                { id: 'orbit-surf', layer: LAYER_CONFIG.surface },
                { id: 'orbit-can',  layer: LAYER_CONFIG.canyon },
                { id: 'orbit-mid',  layer: LAYER_CONFIG.mid },
                { id: 'orbit-high', layer: LAYER_CONFIG.high },
                { id: 'orbit-jet',  layer: LAYER_CONFIG.jet },
            ];
            arrows.forEach(item => {
                const vec = item.layer.grid.getVectorAt(
                    this.lng,
                    this.lat
                );
                const a = (Math.atan2(vec.u, vec.v) * 180) / Math.PI;
                const el = document.getElementById(item.id);
                el.style.transform = `rotate(${a}deg)`;
                const mag = Math.sqrt(vec.u * vec.u + vec.v * vec.v);
                const mph = Math.round(mag * 46000);
                const label = el.querySelector('.orbit-label');
                if (label) label.innerText = mph + 'mph';
            });

            // Balloon Fiesta Park indicator on minimap
            const dxP = PARK_LNG - this.lng;
            const dyP = PARK_LAT - this.lat;
            const angRadP = Math.atan2(dxP, dyP);
            const angDegP = (angRadP * 180) / Math.PI;
            const parkEl = document.getElementById('park-indicator');
            if (parkEl) {
                parkEl.style.transform = `rotate(${angDegP}deg)`;
            }
        }

        // Draw balloon vertical column and cap in wind canvas
        draw(ctx) {
            if (!this.active) return;

            const TOP_ALT = 20000;
            const SEGMENTS = 64;
            const step = (TOP_ALT - this.groundAlt) / SEGMENTS;
            ctx.lineWidth = 2.5;

            // Align 3D projection with map.project on the ground point
            const groundScreen = map.project([this.lng, this.lat]);
            const groundMath = project3D(
                this.lng,
                this.lat,
                this.groundAlt * 0.3048
            );
            const driftX = groundScreen.x - groundMath.x;
            const driftY = groundScreen.y - groundMath.y;

            for (let i = 0; i < SEGMENTS; i++) {
                const alt1 = this.groundAlt + i * step;
                const alt2 = this.groundAlt + (i + 1) * step;
                const midAlt = (alt1 + alt2) / 2;

                const p1 = project3D(
                    this.lng,
                    this.lat,
                    alt1 * 0.3048
                );
                const p2 = project3D(
                    this.lng,
                    this.lat,
                    alt2 * 0.3048
                );

                p1.x += driftX;
                p1.y += driftY;
                p2.x += driftX;
                p2.y += driftY;

                if (p1.inFront && p2.inFront) {
                    ctx.beginPath();
                    ctx.strokeStyle = getColorForAltitude(midAlt);
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            }

            let p3d_air = project3D(
                this.lng,
                this.lat,
                this.alt * 0.3048
            );
            p3d_air.x += driftX;
            p3d_air.y += driftY;

            if (p3d_air.inFront) {
                const color = getColorForAltitude(this.alt);
                ctx.beginPath();
                ctx.fillStyle = color;
                ctx.arc(p3d_air.x, p3d_air.y, 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            this.lastDriftX = driftX;
            this.lastDriftY = driftY;
        }
    }

    const player = new PlayerBalloon();

    /* ------------------------------------------------------------------
     *  Wind canvas + particles
     * ------------------------------------------------------------------ */

    const canvas = document.getElementById('wind-canvas');
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';

    // 3D maplibre projection into canvas space
    function project3D(lng, lat, altitudeMeters) {
        if (!map.transform) return { x: 0, y: 0, inFront: false };
        const mercator = maplibregl.MercatorCoordinate.fromLngLat(
            { lng, lat },
            altitudeMeters * currentExaggeration
        );
        const matrix = map.transform.mercatorMatrix;
        const x = mercator.x;
        const y = mercator.y;
        const z = mercator.z;
        const w = 1;

        const pw =
            matrix[3] * x +
            matrix[7] * y +
            matrix[11] * z +
            matrix[15] * w;
        const px =
            matrix[0] * x +
            matrix[4] * y +
            matrix[8] * z +
            matrix[12] * w;
        const py =
            matrix[1] * x +
            matrix[5] * y +
            matrix[9] * z +
            matrix[13] * w;

        return {
            x: (px / pw + 1) * (canvas.width * 0.5),
            y: (1 - py / pw) * (canvas.height * 0.5),
            inFront: pw > 0,
        };
    }

    let particles = [];

    // Simple screen-space advected particle
    class Particle {
        constructor(type, altitude) {
            this.type = type;
            this.altitude = altitude;
            this.reset();
        }
        reset() {
            const minLng = BOUNDS[0];
            const minLat = BOUNDS[1];
            const maxLng = BOUNDS[2];
            const maxLat = BOUNDS[3];
            this.lng = minLng + Math.random() * (maxLng - minLng);
            this.lat = minLat + Math.random() * (maxLat - minLat);
            this.age = Math.random() * 100;
            this.life = 100 + Math.random() * 100;
            this.prev = null;
        }
        update() {
            const config = LAYER_CONFIG[this.type];
            let endPos;

            // Surface particles use 2D map projection to "stick" to surface mesh
            if (this.type === 'surface') {
                const pt = map.project([this.lng, this.lat]);
                endPos = { x: pt.x, y: pt.y, inFront: true };
            } else {
                endPos = project3D(
                    this.lng,
                    this.lat,
                    config.altitude * 0.3048
                );
            }

            const vector = config.grid.getVectorAt(this.lng, this.lat);
            this.lng += vector.u * CONFIG.simSpeed;
            this.lat += vector.v * CONFIG.simSpeed;

            this.age++;
            if (
                this.lng < BOUNDS[0] ||
                this.lng > BOUNDS[2] ||
                this.lat < BOUNDS[1] ||
                this.lat > BOUNDS[3]
            ) {
                this.reset();
                return;
            }

            if (endPos.inFront && this.prev && this.prev.inFront) {
                const dist =
                    Math.abs(endPos.x - this.prev.x) +
                    Math.abs(endPos.y - this.prev.y);
                const verticalJump = Math.abs(
                    endPos.y - this.prev.y
                );

                // Cull big teleports / projection flips
                if (dist < 80 && verticalJump < 10) {
                    let alpha = 1.0;
                    if (this.age < 20) alpha = this.age / 20;
                    else if (this.age > this.life - 20)
                        alpha = (this.life - this.age) / 20;
                    alpha *= CONFIG.windOpacity;

                    if (alpha > 0) {
                        ctx.beginPath();
                        ctx.strokeStyle = config.color;
                        ctx.lineWidth = CONFIG.lineWidth;
                        ctx.globalAlpha = alpha;
                        ctx.moveTo(this.prev.x, this.prev.y);
                        ctx.lineTo(endPos.x, endPos.y);
                        ctx.stroke();
                        ctx.globalAlpha = 1.0;
                    }
                }
            }

            this.prev = endPos;
            if (this.age > this.life) this.reset();
        }
    }

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    function updateParticlePools() {
        particles = [];
        Object.keys(LAYER_CONFIG).forEach(type => {
            if (LAYER_CONFIG[type].active) {
                const count = Math.floor(
                    CONFIG.particleCount * LAYER_CONFIG[type].ratio
                );
                for (let i = 0; i < count; i++) {
                    particles.push(
                        new Particle(
                            type,
                            LAYER_CONFIG[type].altitude
                        )
                    );
                }
            }
        });
        // Draw in ascending altitude (surface on top of higher layers visually)
        particles.sort((a, b) => a.altitude - b.altitude);
    }

    // Wind layer triangles: show direction and relative speed at the balloon
    function drawLayerTriangle(layer) {
        if (!player.active) return;

        const zoom = map.getZoom();
        if (zoom < 7) return; // avoid artifacts when extremely zoomed out

        const vec = layer.grid.getVectorAt(player.lng, player.lat);
        const mag = Math.sqrt(vec.u * vec.u + vec.v * vec.v);

        let nx = 0;
        let ny = 1;
        if (mag > 0) {
            nx = vec.u / mag;
            ny = vec.v / mag;
        }

        // Triangle base sizes (your requested values)
        const BASE_LENGTH = 0.04;
        const BASE_WIDTH  = 0.020;
        const ZOOM_REF    = 10; // zoom level where this size "feels right"

        // Scale world size by zoom so the *pixel* size stays roughly constant
        const zoomScale = Math.pow(2, ZOOM_REF - zoom);

        // Slight boost for faster winds so they read visually
        const speedScale = 0.9 + Math.min(mag * 400, 0.5);
        const LENGTH = BASE_LENGTH * zoomScale * speedScale;
        const WIDTH  = BASE_WIDTH  * zoomScale * speedScale;

        // Tip (front, in direction of wind)
        const tLng = player.lng + nx * LENGTH;
        const tLat = player.lat + ny * LENGTH;

        // Base center (back)
        const bLng = player.lng - nx * (LENGTH * 0.3);
        const bLat = player.lat - ny * (LENGTH * 0.3);

        // Base left/right (perpendicular to wind direction)
        const lLng = bLng - -ny * WIDTH;
        const lLat = bLat - nx * WIDTH;

        const rLng = bLng + -ny * WIDTH;
        const rLat = bLat + nx * WIDTH;

        // Altitude for projection
        let drawAlt = layer.altitude * 0.3048;
        if (layer.type === 'surface') {
            const groundM =
                map.queryTerrainElevation([player.lng, player.lat]) ||
                0;
            drawAlt = groundM + 200; // a bit above terrain to avoid clipping
        }

        const pTip   = project3D(tLng, tLat, drawAlt);
        const pLeft  = project3D(lLng, lLat, drawAlt);
        const pRight = project3D(rLng, rLat, drawAlt);

        // Correct for projection drift (same correction used in balloon draw)
        const dx = player.lastDriftX || 0;
        const dy = player.lastDriftY || 0;

        if (pTip.inFront && pLeft.inFront && pRight.inFront) {
            ctx.beginPath();
            ctx.moveTo(pTip.x + dx,   pTip.y + dy);
            ctx.lineTo(pRight.x + dx, pRight.y + dy);
            ctx.lineTo(pLeft.x + dx,  pLeft.y + dy);
            ctx.closePath();

            ctx.fillStyle = layer.color;
            let alpha = isMoving ? 0.5 : 0.1;
            alpha *= CONFIG.windOpacity;
            if (alpha > 0) {
                ctx.globalAlpha = alpha;
                ctx.fill();
                ctx.globalAlpha = 1.0;
            }
        }
    }

    // Main render loop (tied to map's render)
    function animate() {
        if (!ctx) return;

        // Chase cam: keep map in a fixed-angle offset from the balloon
        if (isChasing && player.active) {
            map.jumpTo({
                center: [
                    player.lng + CHASE_CONFIG.offsetLng,
                    player.lat + CHASE_CONFIG.offsetLat,
                ],
                zoom:    CHASE_CONFIG.zoom,
                pitch:   CHASE_CONFIG.pitch,
                bearing: CHASE_CONFIG.bearing,
            });
        }

        // Fade old streaks
        ctx.globalCompositeOperation = 'destination-out';
        const fade = isMoving ? CONFIG.moveFade : CONFIG.trailFade;
        ctx.fillStyle = `rgba(10,10,10,${fade})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';

        // Update balloon physics + render vertical column
        player.update(burnerActive);
        player.draw(ctx);

        // Draw layer direction triangles
        sortedLayers.forEach(layer => {
            if (layer.active) drawLayerTriangle(layer);
        });

        // Update particles
        if (particles.length > 0) {
            particles.forEach(p => p.update());
        }

        if (!isMoving) map.triggerRepaint();
    }

    function initWindSystem() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        updateParticlePools();
        map.on('render', () => {
            animate();
        });
        animate();
    }

    /* ------------------------------------------------------------------
     *  Interaction: presets, controls, chase toggle
     * ------------------------------------------------------------------ */

    const btnFiesta = document.getElementById('btn-fiesta');
    const btnBox    = document.getElementById('btn-box');
    const btnChase  = document.getElementById('btn-chase');

    function clearPresetActive() {
        btnFiesta.classList.remove('active');
        btnBox.classList.remove('active');
        btnChase.classList.remove('active');
    }

    // Fiesta preset: 1x exaggeration over launch field
    btnFiesta.addEventListener('click', () => {
        isChasing = false;
        clearPresetActive();
        btnFiesta.classList.add('active');
        setExaggeration(1.0);
        map.flyTo({
            center: [-106.587, 35.163],
            zoom: 13.49,
            pitch: 76,
            bearing: 0,
            speed: 0.8,
        });
    });

    // "The Box" preset: 6x exaggeration, box view north
    btnBox.addEventListener('click', () => {
        isChasing = false;
        clearPresetActive();
        btnBox.classList.add('active');
        setExaggeration(6.0);
        map.flyTo({
            center: [-106.5677, 35.5194],
            zoom: 10.74,
            pitch: 83,
            bearing: 10,
            speed: 0.8,
        });
    });

    // Chase cam: TOGGLE
    // - ON: lock to fixed angle relative to balloon using CHASE_CONFIG
    // - OFF: unlock, leave camera where it is
    btnChase.addEventListener('click', () => {
        if (isChasing) {
            // Turn OFF chase mode
            isChasing = false;
            btnChase.classList.remove('active');
        } else {
            // Turn ON chase mode
            isChasing = true;
            clearPresetActive();
            btnChase.classList.add('active');

            if (player.active) {
                // Ensure height exaggeration is 1x when entering chase
                setExaggeration(CHASE_CONFIG.exaggeration);

                map.flyTo({
                    center: [
                        player.lng + CHASE_CONFIG.offsetLng,
                        player.lat + CHASE_CONFIG.offsetLat,
                    ],
                    zoom:    CHASE_CONFIG.zoom,
                    pitch:   CHASE_CONFIG.pitch,
                    bearing: CHASE_CONFIG.bearing,
                    speed: 1.0,
                });
            } else {
                // No balloon yet: still set exaggeration so view matches when spawned
                setExaggeration(CHASE_CONFIG.exaggeration);
            }
        }
    });

    // Map movement cancels chase and stops "still" optimizations
    const startMove = e => {
        if (e.originalEvent) {
            isChasing = false;
            clearPresetActive();
        }
        isMoving = true;
    };
    const stopMove = () => {
        isMoving = false;
    };

    map.on('movestart', startMove);
    map.on('moveend',   stopMove);
    map.on('zoomstart', startMove);
    map.on('zoomend',   stopMove);
    map.on('pitchstart', startMove);
    map.on('pitchend',   stopMove);
    map.on('rotatestart', startMove);
    map.on('rotateend',   stopMove);

    // Helper: safely attach to elements that may not exist
    function safeAddListener(id, event, cb) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, cb);
    }

    // Terrain exaggeration slider
    safeAddListener('terrain-slider', 'input', e => {
        const val = parseFloat(e.target.value);
        setExaggeration(val);
    });

    // Airspace outline toggle
    safeAddListener('check-airspace', 'change', e => {
        const opacity = e.target.checked ? 0.8 : 0;
        if (map.getLayer('airspace-outline')) {
            map.setPaintProperty(
                'airspace-outline',
                'line-opacity',
                opacity
            );
        }
    });

    // 3D buildings toggle
    safeAddListener('check-buildings', 'change', e => {
        setBuildingsVisible(e.target.checked);
    });

    // Drift speed (balloon horizontal speed multiplier)
    safeAddListener('drift-slider', 'input', e => {
        balloonSpeed = parseFloat(e.target.value);
        document.getElementById('drift-val').innerText =
            balloonSpeed + 'x';
    });

    // Enable/disable wind layers & update particle pool
    function toggleLayer(type, checked) {
        LAYER_CONFIG[type].active = checked;
        updateParticlePools();
    }

    safeAddListener('check-surface', 'change', e =>
        toggleLayer('surface', e.target.checked)
    );
    safeAddListener('check-canyon', 'change', e =>
        toggleLayer('canyon', e.target.checked)
    );
    safeAddListener('check-1k', 'change', e =>
        toggleLayer('mid', e.target.checked)
    );
    safeAddListener('check-5k', 'change', e =>
        toggleLayer('high', e.target.checked)
    );
    safeAddListener('check-jet', 'change', e =>
        toggleLayer('jet', e.target.checked)
    );

    // Wind opacity slider (global alpha multiplier)
    safeAddListener('wind-opacity-slider', 'input', e => {
        const v = parseFloat(e.target.value);
        CONFIG.windOpacity = v;
        document.getElementById('wind-opacity-val').innerText =
            Math.round(v * 100) + '%';
    });

    // Collapsible controls (advanced vs pilot-only)
    const controls       = document.getElementById('controls');
    const controlsToggle = document.getElementById('controls-toggle');
    if (controlsToggle) {
        controlsToggle.addEventListener('click', () => {
            controls.classList.toggle('collapsed');
        });
    }

    /* ------------------------------------------------------------------
     *  Info toggle (bottom-left circle -> white info panel)
     * ------------------------------------------------------------------ */
    const infoToggle = document.getElementById('info-toggle');
    const infoPanel  = document.getElementById('info-panel');

    if (infoToggle && infoPanel) {
        infoToggle.addEventListener('click', () => {
            const isOpen = infoPanel.classList.toggle('open');
            infoToggle.classList.toggle('open', isOpen);
            infoToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }

    /* ------------------------------------------------------------------
     *  Pilot input: burner + spawn
     * ------------------------------------------------------------------ */

    let burnerActive = false;
    const burnerBtn = document.getElementById('burner-btn');

    function setBurn(state) {
        burnerActive = state;
        if (state) burnerBtn.classList.add('active');
        else burnerBtn.classList.remove('active');
    }

    burnerBtn.addEventListener('mousedown', () => setBurn(true));
    burnerBtn.addEventListener('mouseup',   () => setBurn(false));
    burnerBtn.addEventListener('mouseleave', () => setBurn(false));
    burnerBtn.addEventListener('touchstart', e => {
        e.preventDefault();
        setBurn(true);
    });
    burnerBtn.addEventListener('touchend', e => {
        e.preventDefault();
        setBurn(false);
    });

    document.addEventListener('keydown', e => {
        if (e.code === 'Space' && !e.repeat) setBurn(true);
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space') setBurn(false);
    });

    // Spawn balloon wherever user clicks on the map
    map.on('click', e => {
        const terrainPt = map.unproject(e.point);
        player.spawn(terrainPt.lng, terrainPt.lat);
    });

    /* ------------------------------------------------------------------
     *  Init
     * ------------------------------------------------------------------ */

    initWindSystem();
});
