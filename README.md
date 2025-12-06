# Albuquerque Box

Experimental wind visualizer and hot-air balloon sandbox over Albuquerque, built with MapLibre GL and a custom particle renderer. Eventually this will become a small game; right now it’s an interactive framework and toy.

## Features (current)

- 3D satellite basemap with terrain exaggeration
- Procedural multi-layer wind field (surface → jet stream)
- Wind particles rendered in a full-screen canvas
- Minimap + altimeter HUD
- Balloon physics prototype with chase cam and presets
- All map and terrain data is loaded from public tile/vector sources via CDN.

## Controls

- **Click on the map** – Spawn the balloon at that location.
- **BURNER button or Spacebar (hold)** – Climb.
- **Drift slider** – Adjust horizontal wind drift.
- **Presets** – Jump between Fiesta, Box view, and Chase cam.
- **Wind layer checkboxes / opacity** – Toggle and fade wind overlays.
- **Terrain slider** – Change height exaggeration and 3D buildings scale.

## Notes

This is a work in progress. Game rules, scoring, and additional interactions are still to come.
