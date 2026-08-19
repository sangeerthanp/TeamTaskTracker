# Team Dashboard

A team lead dashboard that pulls work items from Azure DevOps (Boards) and shows, per project: ticket summaries, a paginated/searchable ticket list, and a Home view of who on the team is currently engaged vs. free, based on their active tickets' hours and due dates.

- **Backend**: Express API (`server.js`) that proxies Azure DevOps' REST API - runs WIQL queries scoped to a configured area path and team roster, maps work items (Task/User Story/Bug/Feature/Epic/Release/...) into a consistent shape, and computes workload/engagement.
- **Frontend**: Angular app (`frontend/`).

## Prerequisites

- Node.js 18+
- An Azure DevOps organization, a Personal Access Token (PAT) with **Work Items (Read)** scope, and the area path(s) you want the dashboard scoped to.

## Configuration

Copy `.env.example` to `.env` at the project root and fill in your own values:

| Variable | Description |
|---|---|
| `AZURE_ORG` | Your Azure DevOps organization name. |
| `AZURE_PAT` | A Personal Access Token with Work Items (Read) access. Never commit this. |
| `PORT` | Port for the local Express server (default `3000`). |
| `TEAM_MEMBERS` | Comma-separated list of full display names, exactly as they appear in each work item's *Assigned To* field (case-sensitive). |
| `PROJECTS_CONFIG` | JSON array of `{ id, name, azureProject, areaPath }` - one entry per project shown in the dashboard. `id` is the internal key used in API calls; `name` is what's shown in the UI; `azureProject`/`areaPath` scope the WIQL query to that Azure DevOps project/area. |

The frontend never hardcodes team members, project names, or org details - it fetches the team roster and project list from the backend's `GET /api/config` endpoint at startup.

## Running locally

```bash
# Backend (from the project root)
npm install
npm start          # http://localhost:3000

# Frontend (in a separate terminal)
cd frontend
npm install
npm start          # http://localhost:4200, proxies API calls to :3000 in dev
```

## Deploying to Vercel

This repo deploys as a single Vercel project:

- `api/index.js` wraps the Express app (`server.js`) as one serverless function; `vercel.json` rewrites all `/api/*` requests to it.
- `vercel.json`'s `buildCommand` builds the Angular app under `frontend/`, and `outputDirectory` points at its static output.
- In the Vercel project settings, add the same environment variables listed above (`AZURE_ORG`, `AZURE_PAT`, `TEAM_MEMBERS`, `PROJECTS_CONFIG`) - Vercel injects them directly into the serverless function's environment, no `.env` file is uploaded or needed in production.

No further per-environment frontend config is needed: `frontend/src/environments/environment.prod.ts` calls the API at the same origin (`apiUrl: ''`), which resolves correctly once frontend and API share one Vercel deployment.

## Project structure

```
server.js              Express app (also the source for the Vercel function)
api/index.js            Vercel serverless entry point, wraps server.js
vercel.json              Vercel build/routing config
.env.example             Template for required environment variables
frontend/                Angular app
```
