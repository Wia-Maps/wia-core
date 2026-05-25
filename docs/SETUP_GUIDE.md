# WIA Setup & Deployment Guide

Follow this guide to deploy an isolated instance of the Smart Campus Operating System for your institution in under 48 hours.

## Prerequisites
* Node.js (v18 or higher)
* MongoDB Atlas Cluster (with GeoSpatial Indexing enabled)
* OpenStreetMap Account (for iD Editor or JOSM tracing)

## 🛠️ Step-by-Step Deployment

### 1. Extract Campus Geospatial Footprints
1. Go to [Overpass Turbo](https://overpass-turbo.eu/).
2. Manually search and center the map view directly over your university boundaries.
3. Copy the script from `kit/overpass_queries.txt` and paste it into the editor.
4. Run the query. Export the output as a **GeoJSON** file.

### 2. Initialize the Configuration File
1. Rename `kit/config.template.json` to `config.json` and move it to the root of your project directory.
2. Replace the placeholder values with your specific campus credentials and the exact map boundaries you established during your Overpass extraction.

### 3. Environment Variables (`.env`)
Create a `.env` file at your root directory and supply the following core values:
```env
MONGODB_URI=your_mongodb_atlas_connection_string
NEXT_PUBLIC_MAP_ENGINE_KEY=your_vector_tile_provider_key
JWT_SECRET=your_system_authentication_secret