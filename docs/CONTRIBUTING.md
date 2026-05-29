# Contributing to WIA Core

First off, thank you for stepping up to build. WIA is an indigenous project designed to prove the engineering capability of our student network. By contributing, you are helping standardize digital infrastructure across campuses nationwide.

We maintain a strict "no-noise, pure execution" standard for code quality. Please review these operational requirements before opening a Pull Request.

---

## 🏗️ Architectural Guarantees

Every contribution must respect the core engineering principles of the WIA ecosystem:

1. **Strict GeoJSON Compliance:** We adhere to the RFC 7946 specification. All location arrays must be structured as `[Longitude, Latitude]`. If a submission reverses this order, the automated CI pipeline will reject it.
2. **Data Sovereignty:** No code should introduce dependencies on proprietary, closed-source tracking APIs. We build and maintain our own spatial pipelines.
3. **Zero-Maintenance Overhead:** Code must be modular, highly optimized, and structured for zero-downtime deployment patterns (e.g., stateless serverless endpoints).

---

## 🛠️ Git Workflow & Branching Strategy

We use a structured branch layout to maintain stability while shipping at high velocity.

* `main` — Production-ready, institutional deployments. Never commit directly here.
* `dev` — Staging branch where features are integrated and tested.
* `feature/feature-name` — Your isolated workspace for writing code.

### The Lifecycle of a Contribution
1. **Fork the Repo:** Create your fork of `wia-core`.
2. **Branch Out:** Cut a clean feature branch from `dev`:
   ```bash
   git checkout -b feature/your-feature-name