# ServeBites — Food Delivery Platform

## Project Overview

ServeBites is a full-stack, microservices-based food delivery web application modelled after Zomato. It lets customers browse nearby restaurants, place orders, and pay online; gives restaurant owners a dashboard to manage their menu and incoming orders; enables delivery riders to receive and fulfil orders in real time; and gives a platform admin the ability to verify new restaurants and riders before they go live. The system uses geolocation to match customers with nearby restaurants and available riders within a configurable radius.

**Target users:** food customers (browse, order, pay), restaurant sellers (manage menu, accept orders, update status), delivery riders (receive and complete deliveries), and platform admins (vet new sellers and riders).

---

## Monorepo Structure

```
servebites/
├── frontend/                  # React 19 + Vite SPA — customer, seller, rider, and admin UIs
└── services/
    ├── auth/                  # Authentication service — Google OAuth + JWT (port 5000)
    ├── restaurant/            # Core service — restaurants, menu, cart, addresses, orders (port 5001)
    ├── utils/                 # Utility service — Cloudinary image upload, Razorpay, Stripe payments (port 5002)
    ├── realtime/              # Real-time service — Socket.io server + internal event emitter (port 5004)
    ├── rider/                 # Rider service — rider profiles, availability, order acceptance (port 5005)
    └── admin/                 # Admin service — verify pending restaurants and riders (port 5006)
```

---

## Tech Stack Summary

### Frontend (`frontend/`)

| Concern | Technology |
|---|---|
| Framework | React 19, TypeScript |
| Build tool | Vite 7 |
| Styling | Tailwind CSS 4 |
| Routing | React Router DOM v7 |
| HTTP client | Axios |
| Real-time | Socket.io-client 4 |
| Maps | Leaflet 1.9 + React-Leaflet 5 + Leaflet-Routing-Machine (OSRM) |
| Auth | @react-oauth/google (OAuth2 code flow) |
| Payments | @stripe/stripe-js (Stripe Checkout redirect) |
| Geocoding | Nominatim (OpenStreetMap) — browser fetch, no API key |
| Toast notifications | react-hot-toast |
| Deployment | Vercel (SPA rewrites configured in `vercel.json`) |

### Backend (all services)

| Concern | Technology |
|---|---|
| Runtime | Node.js 22 (inferred from Dockerfiles) |
| Framework | Express.js 5 |
| Language | TypeScript 5.9 |
| Database | MongoDB (Mongoose ODM for auth/restaurant/rider; native MongoDB driver for admin) |
| Database name | `ServeBites` (hardcoded in db configs) |
| Message queue | RabbitMQ (amqplib 0.10) |
| File storage | Cloudinary v2 |
| Auth tokens | JSON Web Tokens (jsonwebtoken 9, 15-day expiry) |
| Payment gateway | Razorpay + Stripe |
| Google OAuth | googleapis 170 |
| File upload | Multer 2 + datauri |
| Containerisation | Docker (multi-stage, node:22-alpine) |

---

## Prerequisites

- **Node.js** — v22 (matches Docker base image; no `.nvmrc` present in repo)
- **npm** — bundled with Node.js 22
- **MongoDB** — a running MongoDB instance or Atlas cluster (free tier works)
- **RabbitMQ** — a running broker; the `.env` examples use `amqp://admin:admin123@localhost:5672`
- **Accounts and API keys required:**

| Account | Key(s) needed | Used by |
|---|---|---|
| Google Cloud Console | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `auth` service |
| Cloudinary | `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_SECRET_KEY` | `utils` service |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `utils` service |
| Stripe | `STRIPE_SECRET_KEY` (server-side), `VITE_STRIPE_PUBLISHABLE_KEY` (client-side) | `utils` service + frontend |

---

## Getting Started

### 1. Clone the repository

```bash
git clone <repo-url>
cd servebites
```

> **Note:** The root folder on disk is currently named `tomato-code`. Rename it to `servebites` after cloning if desired — this is a local-only operation.

### 2. Install dependencies for each service

```bash
# Frontend
cd frontend && npm install && cd ..

# Backend services
cd services/auth && npm install && cd ../..
cd services/restaurant && npm install && cd ../..
cd services/utils && npm install && cd ../..
cd services/realtime && npm install && cd ../..
cd services/rider && npm install && cd ../..
cd services/admin && npm install && cd ../..
```

### 3. Set up environment variables

Create a `.env` file in each service directory, based on the templates below (see **Environment Setup**).

### 4. Start infrastructure

Ensure MongoDB and RabbitMQ are running locally before starting any service.

### 5. Run each service

Each service uses the same dev command — run in separate terminals:

```bash
# Auth service
cd services/auth && npm run dev

# Restaurant service
cd services/restaurant && npm run dev

# Utils service
cd services/utils && npm run dev

# Realtime service
cd services/realtime && npm run dev

# Rider service
cd services/rider && npm run dev

# Admin service
cd services/admin && npm run dev

# Frontend
cd frontend && npm run dev
```

### 6. Open the app

Navigate to `http://localhost:5173` in your browser.

---

## Environment Setup

### `services/auth/.env`

```env
PORT=5000
MONGO_URI=<your MongoDB connection string>
JWT_SEC=<a long random secret string>
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
```

### `services/restaurant/.env`

```env
PORT=5001
MONGO_URI=<your MongoDB connection string>
JWT_SEC=<same JWT secret as auth service>
UTILS_SERVICE=http://localhost:5002
REALTIME_SERVICE=http://localhost:5004
INTERNAL_SERVICE_KEY=<a long random secret shared across all services>
RABBITMQ_URL=amqp://admin:admin123@localhost:5672
PAYMENT_QUEUE=payment_event
RIDER_QUEUE=rider_queue
ORDER_READY_QUEUE=order_ready_queue
```

### `services/utils/.env`

```env
PORT=5002
CLOUD_NAME=<Cloudinary cloud name>
CLOUD_API_KEY=<Cloudinary API key>
CLOUD_SECRET_KEY=<Cloudinary API secret>
STRIPE_SECRET_KEY=<Stripe secret key>
FRONTEND_URL=http://localhost:5173
RESTAURANT_SERVICE=http://localhost:5001
INTERNAL_SERVICE_KEY=<same key as restaurant service>
RABBITMQ_URL=amqp://admin:admin123@localhost:5672
PAYMENT_QUEUE=payment_event
RAZORPAY_KEY_ID=<Razorpay key ID>
RAZORPAY_KEY_SECRET=<Razorpay key secret>
```

### `services/realtime/.env`

```env
PORT=5004
JWT_SEC=<same JWT secret as auth service>
INTERNAL_SERVICE_KEY=<same key as restaurant service>
```

### `services/rider/.env`

```env
PORT=5005
MONGO_URI=<your MongoDB connection string>
JWT_SEC=<same JWT secret as auth service>
UTILS_SERVICE=http://localhost:5002
REALTIME_SERVICE=http://localhost:5004
RESTAURANT_SERVICE=http://localhost:5001
INTERNAL_SERVICE_KEY=<same key as restaurant service>
RABBITMQ_URL=amqp://admin:admin123@localhost:5672
RIDER_QUEUE=rider_queue
ORDER_READY_QUEUE=order_ready_queue
```

### `services/admin/.env`

```env
PORT=5006
MONGO_URI=<your MongoDB connection string>
JWT_SEC=<same JWT secret as auth service>
DB_NAME=ServeBites
```

### `frontend/.env`

```env
VITE_STRIPE_PUBLISHABLE_KEY=<Stripe publishable key>
VITE_INTERNAL_SERVICE_KEY=<same internal service key — see security note in SPEC.md>
```

> **Note:** `JWT_SEC` and `INTERNAL_SERVICE_KEY` must be identical across all services that use them. They are shared secrets.

---

## Key Scripts

### Per-service (same across all backend services)

| Script | What it does |
|---|---|
| `npm run dev` | Compiles TypeScript in watch mode and hot-reloads the Node server with `concurrently` |
| `npm run build` | Compiles TypeScript to `dist/` via `tsc` |
| `npm start` | Runs the compiled output from `dist/index.js` — used in production / Docker |

### Frontend

| Script | What it does |
|---|---|
| `npm run dev` | Starts Vite dev server at `http://localhost:5173` |
| `npm run build` | Type-checks and builds static assets to `dist/` |
| `npm run preview` | Serves the production build locally for inspection |
| `npm run lint` | Runs ESLint across all source files |

---

## Deployment

### Frontend

Deployed on **Vercel**. The `frontend/vercel.json` file rewrites all routes to `index.html` to support client-side routing.

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

### Backend services

Each service has a **multi-stage Dockerfile** based on `node:22-alpine`. The build stage compiles TypeScript; the production stage copies only compiled output and production dependencies.

```dockerfile
# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

**CI/CD:** No CI/CD configuration file (e.g. GitHub Actions, `.gitlab-ci.yml`) is present in the repository. Deployment pipeline is not documented in codebase — needs input from team.

**Docker Compose:** No `docker-compose.yml` is present. Each service must be orchestrated manually or via a deployment platform. Needs input from team.

---

## Service Port Reference

| Service | Default Port |
|---|---|
| Auth | 5000 |
| Restaurant | 5001 |
| Utils | 5002 |
| Realtime | 5004 |
| Rider | 5005 |
| Admin | 5006 |
| Frontend (dev) | 5173 |
