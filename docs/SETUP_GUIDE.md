# WIA Setup & Deployment Guide

Follow this guide to deploy an isolated instance of the Smart Campus Operating System for your institution in under 48 hours.

## Prerequisites

* Node.js (v18 or higher)
* MongoDB Atlas Cluster (with GeoSpatial Indexing enabled)
* OpenStreetMap Account (for iD Editor or JOSM tracing)

## 🛠️ Step-by-Step Deployment

### 1. Repository Setup & Local Initialization

1. **Fork the Repository:** Navigate to the `wia-core` repository on GitHub and click the **Fork** button to create a copy under your account or organization.
2. **Clone Locally:** Clone your fork to your workstation:

   ```bash
   git clone https://github.com/YOUR_USERNAME/wia-core.git
   cd wia-core
   ```

3. **Environment Setup:** Create a `.env` file at the root and configure your `MONGODB_URI` and `JWT_SECRET`:

   ```env
   MONGODB_URI=your_mongodb_atlas_connection_string
   JWT_SECRET=your_system_authentication_secret
   ```

4. **Install and Run:**

   ```bash
   npm install
   npm run dev
   ```

### 2. Administrative Initialization

Before the system can render data, you must provision an authorized administrative account to manage structural layers.

1. **Bootstrap the Admin Account:** Run the following `curl` command in your terminal to register your primary root administrator:

   ```bash
   curl -X POST http://localhost:5000/api/v1/admin/register \
     -H "Content-Type: application/json" \
     -H "X-Initialization-Key: your_optional_secure_env_key" \
     -d '{"email":"admin@yourcampus.edu.ng","password":"secure-temporary-password"}'
   ```

2. **Generate Master GeoJSON File:** Execute the Overpass Turbo extraction script (`kit/overpass_queries.txt`) inside your viewport, export the dataset, and compile it into a unified `master_campus.geojson` file.
3. **Manual Configuration:** Log into the WIA Admin Panel surface (`http://localhost:3000/admin`) using your bootstrapped credentials. Upload your `master_campus.geojson` file to populate the base map, and begin manually linking spatial nesting nodes and real-time utility metadata.

---

## University Adoption Lifecycle

If a new institution (like NACOS Covenant or Bowen) opens this repository today, this is the chronological sequence to transition from a clean code fork to a live campus deployment.

### Phase 1: Institutional Alignment & Data Mining

* **Step 1: The Fork & Branding Check:** The university development team forks `wia-core` and modifies `kit/config.template.json` with their institutional names, target zoom parameters, and local map boundaries.
* **Step 2: Satellite Tracing (OSM Verification):** The team opens OpenStreetMap (OSM) over their campus coordinates. They spend a mapping session tracing missing pedestrian pathways, walkways, and building outlines to ensure the underlying global database layer is accurate.
* **Step 3: Base Geometry Extraction:** They run the custom query in Overpass Turbo to pull down their clean structural and navigation GeoJSON primitives.

### Phase 2: Local Hardening & Administrative Setup

* **Step 4: Local Deployment & Bootstrapping:** The team sets up their localized database instances, boots the engine, and hits the `/api/v1/admin/register` endpoint via `curl` to unlock the admin panel.
* **Step 5: The Spatial Enrichment Grind:** The team accesses the admin dashboard, uploads their master file, and walks the campus ground to tag utility specifics (e.g., identifying internal shops inside their student centers, tagging buildings with power grid lines).

### Phase 3: Administrative Approval & Launch

* **Step 6: The VC/Pro-Chancellor Pitch:** Using the `kit/PITCH_DECK_OUTLINE.md` template, the student developers present the working local prototype to the university management to secure institutional backing, hosting resources, and official data access.
* **Step 7: Production Deployment:** The sanitized application is pushed live to production cloud environments (e.g., Vercel, AWS, or institutional servers) with a public campus subdomain (`map.university.edu.ng`).
* **Step 8: Physical Node Deployment (Mini-Launch):** Generating and printing physical QR-code plates mapped to specific coordinates, anchoring them outside key campus facilities to initiate student onboarding.
