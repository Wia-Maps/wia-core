# WIA Academy: Mapping Your Campus

Welcome to the WIA mapping workflow. Building a digital twin requires precision and hierarchy. This academy will teach you how to extract global data and structure it for the WIA engine.

## 🎬 Masterclass: The 3-Minute Deployment
*Video Link: [Insert YouTube Link Here upon launch]*

### Phase 1: The OpenStreetMap (OSM) Extraction
* **Tool:** Overpass Turbo / iD Editor.
* **Action:** Tracing building footprints using satellite imagery.
* **Rule:** Ensure the first and last coordinates match to close the polygon.

### Phase 2: Generating the GeoJSON
* **Action:** Exporting the OSM data into clean `[Longitude, Latitude]` GeoJSON format.
* **Warning:** Never use `[Latitude, Longitude]` — the WIA engine requires strict GeoJSON X/Y adherence.

### Phase 3: "Nesting" via the WIA Admin Panel
* **Concept:** A building is just a shell. "Nesting" is how we add the intelligence.
* **Example (Joked Complex):** 1. Define the Parent Node (The Complex).
    2. Define Internal Nodes (Restaurants, Labs, Game Centers).
    3. Assign Utility Metadata (Power status, opening hours).

*Remember: Garbage data in, garbage routing out. Map with integrity.*