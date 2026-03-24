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
        particleCount: 25000,    // Total particles across all wind layers
        simSpeed: 0.3,           // Particle simulation step factor
        lineWidth: 3.5,          // Particle stroke width
        windOpacity: 0.8,        // Global alpha for wind visuals (slider driven)
        colors: {
            surface: '#ff0000',
            canyon:  '#ffff00',
            mid:     '#00ff00',
            high:    '#00ffff',
            jet:     '#00008b',
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
            light: {
                anchor: 'viewport',
                color: '#ffe8c4',
                intensity: 0.35,
                position: [1.5, 210, 30],
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
        const txt = `center: [${c.lng.toFixed(4)}, ${c.lat.toFixed(4)}],
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

    // Central place to change exaggeration.
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
                    // Vary color by a hash of feature id for realistic variation
                    'fill-extrusion-color': [
                        'interpolate',
                        ['linear'],
                        ['%', ['to-number', ['id'], 0], 7],
                        0, '#c4b9a8',  // warm sandstone
                        1, '#b8aea0',  // light taupe
                        2, '#d1c7b7',  // cream
                        3, '#a89f93',  // warm gray
                        4, '#c9bfb0',  // beige
                        5, '#b5a999',  // muted tan
                        6, '#bfb5a5',  // sand
                    ],
                    'fill-extrusion-opacity': 0.92,
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
                    'fill-extrusion-vertical-gradient': true,
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

    // Enhanced hot-air balloon marker with gore panels, skirt, detailed rigging & basket
    function drawHotAirBalloonMarker(ctx, x, y, scale, baseColor, map) {
        const bearing = (map.getBearing() * Math.PI) / 180;
        const pitch   = (map.getPitch()   * Math.PI) / 180;

        // Fake "sun" direction: rotate with bearing
        const lx = Math.cos(bearing + Math.PI * 0.65);
        const ly = Math.sin(bearing + Math.PI * 0.65);

        ctx.save();
        ctx.translate(x, y);

        const squash = 1 - 0.12 * Math.sin(pitch);
        ctx.scale(1, squash);

        const w = 11 * scale;
        const h = 15 * scale;

        // Basket dims
        const bw = 7 * scale;
        const bh = 5 * scale;
        const by = h * 0.95;

        // Anchor so (x,y) is the bottom of the basket
        ctx.translate(0, -(by + bh));

        // --- Helper: envelope clipping path ---
        function envelopePath() {
            ctx.beginPath();
            ctx.moveTo(0, -h);
            ctx.bezierCurveTo(w * 1.05, -h, w * 1.05, -h * 0.05, 0, h * 0.55);
            ctx.bezierCurveTo(-w * 1.05, -h * 0.05, -w * 1.05, -h, 0, -h);
            ctx.closePath();
        }

        // --- Envelope base fill with 3D shading ---
        envelopePath();
        const hx = -lx * w * 0.55;
        const hy = -ly * h * 0.40;
        const grad = ctx.createRadialGradient(hx, hy, 1, 0, 0, w * 1.9);
        grad.addColorStop(0.00, "rgba(255,255,255,1.0)");
        grad.addColorStop(0.20, baseColor);
        grad.addColorStop(0.70, "rgba(0,0,0,0.35)");
        grad.addColorStop(1.00, "rgba(0,0,0,0.70)");
        ctx.fillStyle = grad;
        ctx.fill();

        // --- Horizontal gore bands (alternating light/dark stripes) ---
        ctx.save();
        envelopePath();
        ctx.clip();
        const bandCount = 6;
        const bandH = (h + h * 0.55) / bandCount;
        for (let i = 0; i < bandCount; i++) {
            const bandY = -h + i * bandH;
            // Alternate: even bands get a white tint, odd bands get a darker tint
            ctx.fillStyle = i % 2 === 0
                ? "rgba(255,255,255,0.18)"
                : "rgba(0,0,0,0.15)";
            ctx.fillRect(-w * 1.1, bandY, w * 2.2, bandH);
        }

        // --- Vertical gore seam lines ---
        const goreCount = 8;
        ctx.strokeStyle = "rgba(0,0,0,0.20)";
        ctx.lineWidth = 0.5 * scale;
        for (let g = 0; g < goreCount; g++) {
            const frac = g / goreCount;
            const angle = frac * Math.PI * 2;
            // Project gore seam as a vertical line with sinusoidal x-offset
            const goreX = Math.sin(angle + bearing) * w * 0.95;
            ctx.beginPath();
            ctx.moveTo(goreX * 0.15, -h * 0.95);
            ctx.quadraticCurveTo(goreX, -h * 0.15, goreX * 0.3, h * 0.50);
            ctx.stroke();
        }
        ctx.restore();

        // --- Specular shine streak that rotates with light ---
        ctx.save();
        ctx.globalAlpha = 0.25;
        envelopePath();
        ctx.clip();
        ctx.rotate(Math.atan2(ly, lx) + Math.PI * 0.5);
        const shine = ctx.createLinearGradient(0, -h, 0, h * 0.6);
        shine.addColorStop(0.0,  "rgba(255,255,255,0.0)");
        shine.addColorStop(0.20, "rgba(255,255,255,0.6)");
        shine.addColorStop(0.50, "rgba(255,255,255,0.0)");
        ctx.fillStyle = shine;
        ctx.beginPath();
        ctx.ellipse(0, -h * 0.15, w * 0.28, h * 0.80, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // --- Envelope outline ---
        envelopePath();
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 1.0 * scale;
        ctx.stroke();

        // --- Crown (top circle highlight) ---
        ctx.beginPath();
        ctx.arc(0, -h * 0.92, w * 0.18, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.40)";
        ctx.fill();

        // --- Skirt / throat ---
        const skirtW = w * 0.35;
        const skirtH = h * 0.12;
        const skirtY = h * 0.55;
        ctx.beginPath();
        ctx.moveTo(-skirtW, skirtY);
        ctx.quadraticCurveTo(-skirtW * 1.15, skirtY + skirtH, 0, skirtY + skirtH * 0.8);
        ctx.quadraticCurveTo(skirtW * 1.15, skirtY + skirtH, skirtW, skirtY);
        ctx.closePath();
        const skirtGrad = ctx.createLinearGradient(0, skirtY, 0, skirtY + skirtH);
        skirtGrad.addColorStop(0, "rgba(80,40,20,0.9)");
        skirtGrad.addColorStop(1, "rgba(30,15,5,1.0)");
        ctx.fillStyle = skirtGrad;
        ctx.fill();

        // --- Burner glow (subtle orange glow inside the throat) ---
        ctx.beginPath();
        ctx.arc(0, skirtY + skirtH * 0.3, skirtW * 0.4, 0, Math.PI * 2);
        const burnerGlow = ctx.createRadialGradient(0, skirtY + skirtH * 0.3, 0, 0, skirtY + skirtH * 0.3, skirtW * 0.5);
        burnerGlow.addColorStop(0, "rgba(255,160,40,0.50)");
        burnerGlow.addColorStop(1, "rgba(255,100,0,0.0)");
        ctx.fillStyle = burnerGlow;
        ctx.fill();

        // --- Rigging cables (4 lines converging to basket corners) ---
        ctx.strokeStyle = "rgba(60,40,20,0.75)";
        ctx.lineWidth = 0.7 * scale;
        const ropeAttachY = h * 0.53;
        const ropeSpreadX = w * 0.42;
        const basketCornerX = bw * 0.42;
        // Left pair
        ctx.beginPath();
        ctx.moveTo(-ropeSpreadX, ropeAttachY);
        ctx.lineTo(-basketCornerX, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-ropeSpreadX * 0.5, ropeAttachY + 1);
        ctx.lineTo(-basketCornerX, by);
        ctx.stroke();
        // Right pair
        ctx.beginPath();
        ctx.moveTo(ropeSpreadX, ropeAttachY);
        ctx.lineTo(basketCornerX, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ropeSpreadX * 0.5, ropeAttachY + 1);
        ctx.lineTo(basketCornerX, by);
        ctx.stroke();

        // --- Basket ---
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-bw / 2, by, bw, bh, 1.5 * scale);
        else ctx.rect(-bw / 2, by, bw, bh);

        const bx = -lx * bw * 0.35;
        const basketGrad = ctx.createLinearGradient(bx, by, -bx, by + bh);
        basketGrad.addColorStop(0, "rgba(210,155,80,1.0)");
        basketGrad.addColorStop(0.5, "rgba(170,110,50,1.0)");
        basketGrad.addColorStop(1, "rgba(85,45,20,1.0)");
        ctx.fillStyle = basketGrad;
        ctx.fill();

        // Basket weave texture (horizontal lines)
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-bw / 2, by, bw, bh, 1.5 * scale);
        else ctx.rect(-bw / 2, by, bw, bh);
        ctx.clip();
        ctx.strokeStyle = "rgba(0,0,0,0.20)";
        ctx.lineWidth = 0.5 * scale;
        const weaveGap = 1.8 * scale;
        for (let wy = by + weaveGap; wy < by + bh; wy += weaveGap) {
            ctx.beginPath();
            ctx.moveTo(-bw / 2, wy);
            ctx.lineTo(bw / 2, wy);
            ctx.stroke();
        }
        ctx.restore();

        // Basket rim (top edge)
        ctx.beginPath();
        ctx.moveTo(-bw / 2, by);
        ctx.lineTo(bw / 2, by);
        ctx.strokeStyle = "rgba(120,70,30,1.0)";
        ctx.lineWidth = 1.2 * scale;
        ctx.stroke();

        // Basket outline
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-bw / 2, by, bw, bh, 1.5 * scale);
        else ctx.rect(-bw / 2, by, bw, bh);
        ctx.strokeStyle = "rgba(60,30,10,0.7)";
        ctx.lineWidth = 0.6 * scale;
        ctx.stroke();

        ctx.restore();
    }

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

            const GRAVITY = -6;
            const LIFT = 50;
            const DRAG = 0.98;

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

                // Scale triangle size based on wind strength
                const arrow = el.querySelector('.orbit-arrow');
                if (arrow) {
                    const scale = 0.5 + Math.min(mag * 600, 1.5);
                    const sideSize = Math.round(6 * scale);
                    const bottomSize = Math.round(14 * scale);
                    arrow.style.borderLeftWidth = sideSize + 'px';
                    arrow.style.borderRightWidth = sideSize + 'px';
                    arrow.style.borderBottomWidth = bottomSize + 'px';
                }
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

        // Compute drift correction (shared by column and icon draws)
        _updateDrift() {
            if (!this.active) return;
            const groundScreen = map.project([this.lng, this.lat]);
            const groundMath = project3D(
                this.lng,
                this.lat,
                this.groundAlt * 0.3048
            );
            this.lastDriftX = groundScreen.x - groundMath.x;
            this.lastDriftY = groundScreen.y - groundMath.y;
        }

        // Draw the vertical altitude column (rendered beneath particles)
        drawColumn(ctx) {
            if (!this.active) return;
            this._updateDrift();
            const driftX = this.lastDriftX;
            const driftY = this.lastDriftY;

            const TOP_ALT = 20000;
            const SEGMENTS = 64;
            const step = (TOP_ALT - this.groundAlt) / SEGMENTS;
            ctx.lineWidth = 2.5;

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
        }

        // Draw the balloon icon (rendered above particles)
        drawIcon(ctx) {
            if (!this.active) return;
            const driftX = this.lastDriftX;
            const driftY = this.lastDriftY;

            let p3d_air = project3D(
                this.lng,
                this.lat,
                this.alt * 0.3048
            );
            p3d_air.x += driftX;
            p3d_air.y += driftY;

            if (p3d_air.inFront) {
                const color = getColorForAltitude(this.alt);
                drawHotAirBalloonMarker(ctx, p3d_air.x, p3d_air.y, 2.0, color, map);
            }
        }

        // Draw both column and icon (legacy convenience)
        draw(ctx) {
            this.drawColumn(ctx);
            this.drawIcon(ctx);
        }
    }

    const player = new PlayerBalloon();

    /* ------------------------------------------------------------------
     *  Dawn Patrol: decorative NPC balloons (one per layer)
     * ------------------------------------------------------------------ */

    const DAWN_COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#7209b7', '#4361ee'];

    class DawnBalloon {
        constructor(targetAltFeet, color) {
            this.active = false;
            this.lng = 0;
            this.lat = 0;
            this.alt = 0;
            this.groundAlt = 0;
            this.targetAlt = targetAltFeet;
            this.color = color;
            this.trail = [];       // screen-space trail for fading line
            this.rising = true;
        }

        spawn(lng, lat) {
            this.active = true;
            this.lng = lng;
            this.lat = lat;
            const elevM = map.queryTerrainElevation([lng, lat]) || 1500;
            this.groundAlt = elevM * 3.28084;
            this.alt = this.groundAlt;
            this.rising = true;
            this.trail = [];
        }

        update() {
            if (!this.active) return;

            // Slowly rise toward target altitude
            if (this.rising) {
                const RISE_RATE = 4.0; // feet per frame
                this.alt += RISE_RATE;
                if (this.alt >= this.targetAlt) {
                    this.alt = this.targetAlt;
                    this.rising = false;
                }
            }

            // Drift with wind at current altitude
            const wind = getWindAtAltitude(this.lng, this.lat, this.alt);
            this.lng += wind.u * balloonSpeed * 1.0;
            this.lat += wind.v * balloonSpeed * 1.0;

            // Despawn if outside simulation bounds
            if (
                this.lng < BOUNDS[0] || this.lng > BOUNDS[2] ||
                this.lat < BOUNDS[1] || this.lat > BOUNDS[3]
            ) {
                this.active = false;
                return;
            }

            // Record trail point (in geo coords + alt for 3D projection)
            this.trail.push({ lng: this.lng, lat: this.lat, alt: this.alt });
            if (this.trail.length > 60) this.trail.shift();
        }

        draw(ctx) {
            if (!this.active) return;

            // Draw trail
            if (this.trail.length > 1) {
                for (let i = 1; i < this.trail.length; i++) {
                    const p0 = project3D(this.trail[i - 1].lng, this.trail[i - 1].lat, this.trail[i - 1].alt * 0.3048);
                    const p1 = project3D(this.trail[i].lng, this.trail[i].lat, this.trail[i].alt * 0.3048);
                    if (p0.inFront && p1.inFront) {
                        const alpha = (i / this.trail.length) * 0.5;
                        ctx.beginPath();
                        ctx.strokeStyle = this.color;
                        ctx.globalAlpha = alpha;
                        ctx.lineWidth = 2;
                        ctx.moveTo(p0.x, p0.y);
                        ctx.lineTo(p1.x, p1.y);
                        ctx.stroke();
                    }
                }
                ctx.globalAlpha = 1.0;
            }

            // Draw balloon icon
            const p = project3D(this.lng, this.lat, this.alt * 0.3048);
            if (p.inFront) {
                drawHotAirBalloonMarker(ctx, p.x, p.y, 1.8, this.color, map);
            }
        }
    }

    let dawnBalloons = [];

    /* ------------------------------------------------------------------
     *  Wind canvas + particles
     * ------------------------------------------------------------------ */

    const canvas = document.getElementById('wind-canvas');
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';

    // Per-layer offscreen canvases so altitude levels never bleed into each other
    const layerCanvases = {};
    for (const key of Object.keys(LAYER_CONFIG)) {
        const c = document.createElement('canvas');
        const lctx = c.getContext('2d');
        lctx.lineCap = 'round';
        layerCanvases[key] = { canvas: c, ctx: lctx };
    }

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

    // Simple screen-space advected particle (batched circle rendering)
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
            this.drawX = 0;
            this.drawY = 0;
            this.drawAlpha = 0;
            this.visible = false;
        }
        update() {
            this.visible = false;
            const config = LAYER_CONFIG[this.type];
            let endPos;

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

                if (dist < 80 && verticalJump < 10) {
                    let alpha = 1.0;
                    if (this.age < 20) alpha = this.age / 20;
                    else if (this.age > this.life - 20)
                        alpha = (this.life - this.age) / 20;
                    alpha *= CONFIG.windOpacity;

                    if (alpha > 0) {
                        this.drawX = endPos.x;
                        this.drawY = endPos.y;
                        this.drawAlpha = alpha;
                        this.visible = true;
                    }
                }
            }

            this.prev = endPos;
            if (this.age > this.life) this.reset();
        }
    }

    // Batch-draw all visible particles grouped by layer color.
    // Each layer draws onto its own offscreen canvas (with independent fade),
    // then the offscreen canvases are composited onto the main canvas in
    // ascending altitude order so higher layers always appear on top.
    function drawParticlesBatched() {
        const RADIUS = CONFIG.lineWidth * 0.5;
        const ALPHA_BUCKETS = 5; // quantize alpha to reduce state changes
        const TAU = Math.PI * 2;
        const fade = isMoving ? CONFIG.moveFade : CONFIG.trailFade;

        // Group particles by type
        const groups = {};
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if (!p.visible) continue;
            if (!groups[p.type]) groups[p.type] = [];
            groups[p.type].push(p);
        }

        // Draw each layer onto its own offscreen canvas
        for (let li = 0; li < sortedLayers.length; li++) {
            const type = sortedLayers[li].type;
            const lc = layerCanvases[type];
            const lctx = lc.ctx;

            // Fade this layer's trails independently
            lctx.globalCompositeOperation = 'destination-out';
            lctx.fillStyle = `rgba(10,10,10,${fade})`;
            lctx.fillRect(0, 0, lc.canvas.width, lc.canvas.height);
            lctx.globalCompositeOperation = 'source-over';

            if (!groups[type]) continue;
            const config = LAYER_CONFIG[type];
            lctx.fillStyle = config.color;

            // Sort into alpha buckets
            const buckets = new Array(ALPHA_BUCKETS);
            for (let b = 0; b < ALPHA_BUCKETS; b++) buckets[b] = [];

            const group = groups[type];
            for (let i = 0; i < group.length; i++) {
                const p = group[i];
                const bucket = Math.min(
                    ALPHA_BUCKETS - 1,
                    Math.floor(p.drawAlpha * ALPHA_BUCKETS)
                );
                buckets[bucket].push(p);
            }

            for (let b = 0; b < ALPHA_BUCKETS; b++) {
                if (buckets[b].length === 0) continue;
                const alphaVal = (b + 0.5) / ALPHA_BUCKETS;
                lctx.globalAlpha = alphaVal;
                lctx.beginPath();
                for (let i = 0; i < buckets[b].length; i++) {
                    const p = buckets[b][i];
                    lctx.moveTo(p.drawX + RADIUS, p.drawY);
                    lctx.arc(p.drawX, p.drawY, RADIUS, 0, TAU);
                }
                lctx.fill();
            }
            lctx.globalAlpha = 1.0;
        }

        // Composite layer canvases onto main canvas in altitude order
        for (let li = 0; li < sortedLayers.length; li++) {
            const type = sortedLayers[li].type;
            if (!LAYER_CONFIG[type].active) continue;
            ctx.drawImage(layerCanvases[type].canvas, 0, 0);
        }
    }

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        for (const key of Object.keys(layerCanvases)) {
            layerCanvases[key].canvas.width = window.innerWidth;
            layerCanvases[key].canvas.height = window.innerHeight;
        }
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
        // Draw in ascending altitude so higher layers render on top
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
        const groundM =
            map.queryTerrainElevation([player.lng, player.lat]) || 0;
        if (layer.type === 'surface') {
            drawAlt = groundM + 200; // a bit above terrain to avoid clipping
        } else if (layer.type === 'canyon') {
            // Pin yellow canyon triangle to stay above the mountain top
            drawAlt = Math.max(drawAlt, groundM + 250);
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
            let alpha = CONFIG.windOpacity;
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

        // Clear main canvas each frame (particles live on per-layer canvases)
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Update balloon physics
        player.update(burnerActive);

        // Draw column + layer triangles (beneath particles)
        player.drawColumn(ctx);
        sortedLayers.forEach(layer => {
            if (layer.active) drawLayerTriangle(layer);
        });

        // Update particles then composite per-layer canvases
        if (particles.length > 0) {
            for (let i = 0; i < particles.length; i++) particles[i].update();
        }
        drawParticlesBatched();

        // Draw balloon icon on top of everything
        player.drawIcon(ctx);

        // Dawn Patrol balloons: update + draw on top of everything
        for (let i = dawnBalloons.length - 1; i >= 0; i--) {
            dawnBalloons[i].update();
            if (!dawnBalloons[i].active) {
                dawnBalloons.splice(i, 1);
                continue;
            }
            dawnBalloons[i].draw(ctx);
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
    const btnChase  = document.getElementById('btn-chase');
    const btnDawn   = document.getElementById('btn-dawn');
    const btnSpread = document.getElementById('btn-spread');

    // Original altitudes for toggling back from spread mode
    const ORIGINAL_ALTITUDES = {};
    for (const key of Object.keys(LAYER_CONFIG)) {
        ORIGINAL_ALTITUDES[key] = LAYER_CONFIG[key].altitude;
    }
    let layersSpread = false;

    function clearPresetActive() {
        btnFiesta.classList.remove('active');
        btnChase.classList.remove('active');
        btnDawn.classList.remove('active');
        btnSpread.classList.remove('active');
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

    // Dawn Patrol: spawn one balloon per layer height
    btnDawn.addEventListener('click', () => {
        isChasing = false;
        clearPresetActive();
        btnDawn.classList.add('active');

        // Clear any existing dawn balloons
        dawnBalloons = [];

        // Spawn one balloon per layer at Balloon Fiesta Park with slight offsets
        const layerKeys = Object.keys(LAYER_CONFIG);
        layerKeys.forEach((key, i) => {
            const layer = LAYER_CONFIG[key];
            const balloon = new DawnBalloon(
                layer.altitude === 0 ? 2600 : layer.altitude,
                DAWN_COLORS[i % DAWN_COLORS.length]
            );
            // Slight random offset so they don't stack exactly
            const offsetLng = (Math.random() - 0.5) * 0.005;
            const offsetLat = (Math.random() - 0.5) * 0.005;
            balloon.spawn(PARK_LNG + offsetLng, PARK_LAT + offsetLat);
            dawnBalloons.push(balloon);
        });
    });

    // Spread Layers: toggle equal altitude spacing
    btnSpread.addEventListener('click', () => {
        isChasing = false;
        if (layersSpread) {
            // Restore original altitudes
            for (const key of Object.keys(LAYER_CONFIG)) {
                LAYER_CONFIG[key].altitude = ORIGINAL_ALTITUDES[key];
            }
            layersSpread = false;
            clearPresetActive();
        } else {
            // Spread layers equally, but lock canyon to its original altitude
            // so it stays visually anchored to the Sandia Mountains canyon.
            const canyonAlt = ORIGINAL_ALTITUDES.canyon; // 6000
            const maxAlt = ORIGINAL_ALTITUDES.jet * 2;   // 36000
            LAYER_CONFIG.surface.altitude = 0;
            LAYER_CONFIG.canyon.altitude  = canyonAlt;    // locked to Sandias
            // Distribute mid, high, jet equally above canyon
            const upperKeys = ['mid', 'high', 'jet'];
            const upperCount = upperKeys.length;
            for (let i = 0; i < upperCount; i++) {
                LAYER_CONFIG[upperKeys[i]].altitude =
                    canyonAlt + ((i + 1) / upperCount) * (maxAlt - canyonAlt);
            }
            layersSpread = true;
            clearPresetActive();
            btnSpread.classList.add('active');
        }
        // Re-sort since altitudes changed
        sortedLayers.length = 0;
        Object.values(LAYER_CONFIG)
            .sort((a, b) => a.altitude - b.altitude)
            .forEach(l => sortedLayers.push(l));
        // Rebuild particle pool to use new altitudes
        updateParticlePools();
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

    // Particle density multiplier slider
    safeAddListener('particle-density-slider', 'input', e => {
        const val = parseFloat(e.target.value);
        CONFIG.particleCount = Math.floor(25000 * val);
        document.getElementById('particle-density-val').innerText =
            val.toFixed(1) + 'x';
        updateParticlePools();
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

    // Triple-click info button → unlock advanced controls panel
    let infoClickCount = 0;
    let infoClickTimer = null;
    const TRIPLE_CLICK_WINDOW = 500; // ms

    if (infoToggle && infoPanel) {
        infoToggle.addEventListener('click', () => {
            // Track rapid clicks for triple-click detection
            infoClickCount++;
            if (infoClickTimer) clearTimeout(infoClickTimer);
            infoClickTimer = setTimeout(() => { infoClickCount = 0; }, TRIPLE_CLICK_WINDOW);

            if (infoClickCount >= 3) {
                infoClickCount = 0;
                // Toggle advanced controls visibility
                const adv = controls.classList.toggle('advanced-unlocked');
                // Also expand the controls if unlocking
                if (adv) controls.classList.remove('collapsed');
                else controls.classList.add('collapsed');
                return; // don't also toggle the info panel
            }

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
        if (e.code === 'Space') {
            e.preventDefault(); // prevent focused buttons from re-triggering
            if (!e.repeat) setBurn(true);
        }
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space') {
            e.preventDefault();
            setBurn(false);
        }
    });

    // Spawn balloon wherever user clicks on the map
    map.on('click', e => {
        const terrainPt = map.unproject(e.point);
        player.spawn(terrainPt.lng, terrainPt.lat);
    });

    /* ------------------------------------------------------------------
     *  Inactivity auto-reset (museum kiosk)
     * ------------------------------------------------------------------ */

    const IDLE_TIMEOUT = 90_000; // 90 seconds
    let idleTimer = null;

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            // Reset balloon to park, reset camera
            player.spawn(PARK_LNG, PARK_LAT);
            isChasing = false;
            clearPresetActive();
            setExaggeration(5.0);
            map.flyTo({
                center: [-106.587, 35.163],
                zoom: 13.49,
                pitch: 76,
                bearing: 0,
                speed: 0.8,
            });
        }, IDLE_TIMEOUT);
    }

    // Any touch/mouse/key resets the idle timer
    ['touchstart', 'touchmove', 'mousedown', 'mousemove', 'keydown'].forEach(evt => {
        document.addEventListener(evt, resetIdleTimer, { passive: true });
    });

    // Prevent context menu on long-press (kiosk)
    document.addEventListener('contextmenu', e => e.preventDefault());

    /* ------------------------------------------------------------------
     *  Init
     * ------------------------------------------------------------------ */

    initWindSystem();

    // Auto-spawn balloon at Balloon Fiesta Park once map is ready
    map.on('load', () => {
        player.spawn(PARK_LNG, PARK_LAT);
        resetIdleTimer();
    });
});
