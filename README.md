# ServeBites 🍕        

A production-grade food delivery platform built with a **Microservices architecture**, **RabbitMQ event streaming**, and **real-time WebSocket communication** — handling the full order lifecycle from restaurant discovery to doorstep delivery.

> Built with: `Node.js` · `TypeScript` · `React 19` · `MongoDB` · `RabbitMQ` · `Socket.io` · `Docker` · `Razorpay` · `Stripe` · `Cloudinary`

---

## 🎯 Project Overview

ServeBites is a full-stack, event-driven food delivery application where six independently deployable microservices collaborate over RabbitMQ queues and real-time WebSocket channels to deliver a seamless ordering experience.

**Who uses it:**

| Role | What they do |
|---|---|
| 🧑‍💻 Customer | Browse nearby restaurants by GPS, manage cart, place orders, track delivery on a live map |
| 🍽️ Seller | Manage restaurant profile, menu items, and incoming orders; update order status in real time |
| 🛵 Rider | Receive order alerts via WebSocket, toggle availability, accept deliveries, share live GPS |
| 🔐 Admin | Verify new restaurants and riders before they go live on the platform |

---

## 🏗️ System Architecture

### Microservices Topology

```
                            ┌─────────────────────────────────┐
                            │         React 19 Frontend         │
                            │  Vite · Tailwind · Socket.io-client│
                            │  Leaflet Maps · React Router v7   │
                            └──────────────┬──────────────────┘
                                           │ HTTPS
          ┌────────────────────────────────┼────────────────────────────────┐
          │                                │                                │
    ┌─────▼──────┐                  ┌──────▼──────┐                ┌────────▼────────┐
    │  Auth :5000 │                 │ Restaurant  │                │   Utils :5002   │
    │             │                 │   :5001     │                │                 │
    │ Google OAuth│                 │             │                │ Cloudinary CDN  │
    │ JWT (15 day)│                 │ MongoDB     │                │ Razorpay        │
    └─────────────┘                 │ $geoNear    │                │ Stripe          │
                                    │ 2dsphere    │                └────────┬────────┘
                                    └──────┬──────┘                        │
                                           │                                │
                              ┌────────────▼─────────────┐                 │
                              │        RabbitMQ Broker    │◄────────────────┘
                              │                           │    payment_event queue
                              │  • payment_event          │
                              │  • order_ready_queue      │
                              └────────────┬─────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                       │
              ┌─────▼──────┐       ┌───────▼─────┐       ┌───────▼──────┐
              │ Rider :5005 │       │ Realtime    │       │ Admin :5006  │
              │             │       │   :5004     │       │              │
              │ $near 500m  │       │             │       │ MongoDB      │
              │ GPS stream  │       │ Socket.io   │       │ native driver│
              └─────────────┘       │ WebSocket   │       └──────────────┘
                                    │ fan-out hub │
                                    └─────────────┘
```

### Event-Driven Order Flow

```
  Customer                 Restaurant              RabbitMQ              Rider               Socket.io
     │                         │                      │                    │                     │
     │──POST /order/place──────►│                      │                    │                     │
     │                         │──publish(payment_evt)─►                    │                     │
     │                         │                      │                    │                     │
     │◄─redirect Razorpay/Stripe│                      │                    │                     │
     │                         │                      │                    │                     │
     │──payment callback───────►│ (Utils verifies sig) │                    │                     │
     │                         │◄──consume(payment_evt)│                    │                     │
     │                         │  status = "placed"    │                    │                     │
     │                         │──POST /internal/emit──────────────────────────────────────────►│
     │◄────────────────────────────────────────────────────── order:new (room: user:<id>) ───────│
     │                         │                      │                    │                     │
     │                         │ Seller accepts order  │                    │                     │
     │                         │──status="ready_for_rider"──publish(order_ready)─►               │
     │                         │                      │──consume(order_rdy)─►                    │
     │                         │                      │                    │──POST /internal/emit─►│
     │◄──────────────────────────────────────────────── order:available (room: restaurant:<id>)──│
     │                         │                      │                    │                     │
     │                         │                      │                    │ Rider accepts        │
     │                         │                      │                    │──POST /internal/emit─►│
     │◄─────────────────────────────────────────────────── order:rider_assigned (room: user:<id>)│
     │                         │                      │                    │                     │
     │◄─── rider:location (live GPS every N seconds, room: user:<id>) ─────────────────────────-│
```

---

## ⚡ Technical Highlights

| Area | What's Under the Hood |
|---|---|
| **Microservices** | 6 independently deployable Express.js 5 services, each with its own MongoDB connection, Docker image, and responsibility boundary |
| **RabbitMQ (Event Streaming)** | `payment_event` queue (Utils → Restaurant) triggers order confirmation; `order_ready_queue` (Restaurant → Rider) triggers rider dispatch — fully async, no polling |
| **WebSockets (Socket.io 4)** | Realtime service acts as a centralized fan-out hub; other services POST to `/internal/emit` via `x-internal-key`; clients subscribe to rooms `user:<id>` and `restaurant:<id>` |
| **Geospatial MongoDB** | `$geoNear` aggregation to find restaurants within radius; `$near` query to find available riders within 500 m of order address — backed by 2dsphere indexes |
| **Dual Payment Gateways** | Razorpay (HMAC-SHA256 signature verification) and Stripe (Checkout session redirect) — customer picks either at checkout |
| **Google OAuth 2.0** | Auth-code flow (`googleapis` library) — frontend receives auth code, passes to backend, backend exchanges for tokens and fetches user profile |
| **JWT Architecture** | Single shared `JWT_SEC` across all 5 backend services; 15-day expiry; full user object embedded in payload |
| **Cloudinary Pipeline** | All images (restaurants, menu items, rider profiles) converted to DataURI at frontend, uploaded through Utils service, stored on Cloudinary v2 |
| **Live Routing Maps** | Leaflet + Leaflet-Routing-Machine using OSRM API; rider GPS coordinates emitted over WebSocket and rendered on customer's live map |
| **Docker Multi-stage** | `node:22-alpine` base; build stage compiles TypeScript, production stage copies only `dist/` + production deps — minimal image size |

---

## 🗄️ Data Architecture

All services share a single **`ServeBites`** MongoDB database. Services access only the collections they own.

| Collection | Service | Key Fields & Indexes |
|---|---|---|
| `users` | Auth | `email` (unique), `googleId`, `role` (`customer`/`seller`/`rider`/`admin`) |
| `restaurants` | Restaurant | `owner` (ObjectId), `autoLocation` **(2dsphere)**, `isVerified`, `cuisines[]` |
| `menuitems` | Restaurant | `restaurant` (ObjectId), `name`, `price`, `image` (Cloudinary URL) |
| `carts` | Restaurant | `user` (ObjectId), `items[{menuItem, quantity}]`, `restaurant` |
| `orders` | Restaurant | `status` (9-stage enum), `paymentMethod`, `deliveryFee`, `platformFee`, `expiresAt` **(TTL 15 min)** |
| `addresses` | Restaurant | `user` (ObjectId), `location` **(2dsphere)**, `houseNo`, `area`, `city` |
| `riders` | Rider | `user` (ObjectId), `location` **(2dsphere)**, `isAvailable`, `isVerified`, `currentOrder` |

**Order status lifecycle:**
```
placed → accepted → preparing → ready_for_rider → rider_assigned → picked_up → delivered
                                                                             └──► cancelled
```

**Fee calculation (from source):**
- `deliveryFee` = `subtotal < 250 ? ₹49 : ₹0`
- `platformFee` = `₹7` (flat)
- `riderAmount` = `Math.ceil(distanceKm) × ₹17`

---

## 🛠️ Tech Stack

### Frontend

| Concern | Technology |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 |
| Routing | React Router DOM v7 |
| HTTP | Axios |
| Real-time | Socket.io-client 4 |
| Maps | Leaflet 1.9 · React-Leaflet 5 · Leaflet-Routing-Machine (OSRM) |
| Auth | `@react-oauth/google` (OAuth2 auth-code flow) |
| Payments | `@stripe/stripe-js` (Checkout redirect) |
| Geocoding | Nominatim / OpenStreetMap (no API key required) |
| Deployment | Vercel (SPA rewrites via `vercel.json`) |

### Backend (all services)

| Concern | Technology |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express.js 5 |
| Language | TypeScript 5.9 |
| Database | MongoDB + Mongoose ODM (native driver for Admin) |
| Message Queue | RabbitMQ via `amqplib` 0.10 |
| Auth Tokens | JWT (`jsonwebtoken` 9, 15-day, HS256) |
| File Storage | Cloudinary v2 |
| Payments | Razorpay + Stripe |
| OAuth | `googleapis` 170 |
| Containerisation | Docker (multi-stage, `node:22-alpine`) |

---

## 📋 Prerequisites

- **Node.js** v22
- **MongoDB** — local or Atlas (free tier)
- **RabbitMQ** — local or CloudAMQP (free tier)
- **API Keys:**

| Service | Keys Required |
|---|---|
| Google Cloud Console | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Cloudinary | `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_SECRET_KEY` |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| Stripe | `STRIPE_SECRET_KEY` (server), `VITE_STRIPE_PUBLISHABLE_KEY` (client) |

---

## 🚀 Getting Started

**1. Clone the repository**

```bash
git clone <repo-url>
cd tomato-code        # root folder name
```

**2. Install dependencies**

```bash
# Frontend
cd frontend && npm install && cd ..

# All 6 backend services
for svc in auth restaurant utils realtime rider admin; do
  cd services/$svc && npm install && cd ../..
done
```

**3. Configure environment variables**

Create `.env` files in each service directory (see [Environment Variables](#-environment-variables) below).

> `JWT_SEC` and `INTERNAL_SERVICE_KEY` must be **identical** across all services that reference them.

**4. Start infrastructure**

```bash
# MongoDB (local)
mongod --dbpath /data/db

# RabbitMQ (Docker)
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=admin \
  -e RABBITMQ_DEFAULT_PASS=admin123 \
  rabbitmq:3-management
```

**5. Start all services** (separate terminals)

```bash
cd services/auth      && npm run dev    # :5000
cd services/restaurant && npm run dev   # :5001
cd services/utils      && npm run dev   # :5002
cd services/realtime   && npm run dev   # :5004
cd services/rider      && npm run dev   # :5005
cd services/admin      && npm run dev   # :5006
cd frontend            && npm run dev   # :5173
```

**6. Open** `http://localhost:5173`

---

## 🔧 Environment Variables

| Variable | Service | Description |
|---|---|---|
| `PORT` | all | Service port (5000–5006) |
| `MONGO_URI` | auth, restaurant, rider | MongoDB connection string |
| `JWT_SEC` | auth, restaurant, utils, realtime, rider, admin | Shared JWT signing secret |
| `GOOGLE_CLIENT_ID` | auth | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | auth | Google OAuth client secret |
| `UTILS_SERVICE` | restaurant, rider | Base URL of utils service |
| `REALTIME_SERVICE` | restaurant, rider | Base URL of realtime service |
| `RESTAURANT_SERVICE` | utils, rider | Base URL of restaurant service |
| `INTERNAL_SERVICE_KEY` | restaurant, utils, realtime, rider | Shared key for inter-service calls |
| `RABBITMQ_URL` | restaurant, utils, rider | RabbitMQ connection string |
| `PAYMENT_QUEUE` | restaurant, utils | Queue name: `payment_event` |
| `ORDER_READY_QUEUE` | restaurant, rider | Queue name: `order_ready_queue` |
| `RIDER_QUEUE` | restaurant, rider | Queue name: `rider_queue` |
| `CLOUD_NAME` | utils | Cloudinary cloud name |
| `CLOUD_API_KEY` | utils | Cloudinary API key |
| `CLOUD_SECRET_KEY` | utils | Cloudinary API secret |
| `RAZORPAY_KEY_ID` | utils | Razorpay key ID |
| `RAZORPAY_KEY_SECRET` | utils | Razorpay key secret |
| `STRIPE_SECRET_KEY` | utils | Stripe secret key |
| `FRONTEND_URL` | utils | Frontend origin for Stripe redirect |
| `DB_NAME` | admin | MongoDB database name (`ServeBites`) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | frontend | Stripe publishable key |
| `VITE_INTERNAL_SERVICE_KEY` | frontend | Internal service key (dev only) |

---

## 📡 API Reference

### Auth Service `:5000`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/auth/google` | Exchange Google auth code for JWT |
| `GET` | `/api/v1/auth/me` | Get current authenticated user |
| `PUT` | `/api/v1/auth/update-role` | Assign role to user (customer/seller/rider) |
| `GET` | `/api/v1/auth/logout` | Clear auth session |

### Restaurant Service `:5001`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/restaurant/new` | Create restaurant profile |
| `GET` | `/api/v1/restaurant/nearby` | Get restaurants near user's GPS coordinates (`$geoNear`) |
| `GET` | `/api/v1/restaurant/:id` | Get restaurant details + menu |
| `POST` | `/api/v1/menu/add` | Add menu item (with Cloudinary image) |
| `POST` | `/api/v1/cart/add` | Add item to cart |
| `POST` | `/api/v1/order/place` | Place order → publishes to RabbitMQ |
| `PUT` | `/api/v1/order/status` | Update order status (seller) |
| `GET` | `/api/v1/order/restaurant` | Get all orders for a restaurant |
| `GET` | `/api/v1/order/user` | Get all orders for a customer |

### Utils Service `:5002`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload image to Cloudinary (DataURI body) |
| `POST` | `/api/v1/payment/razorpay` | Create Razorpay order |
| `POST` | `/api/v1/payment/razorpay/verify` | Verify Razorpay signature |
| `POST` | `/api/v1/payment/stripe` | Create Stripe Checkout session |
| `GET` | `/api/v1/payment/stripe/success` | Stripe success redirect handler |

### Rider Service `:5005`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/rider/register` | Register as rider |
| `PUT` | `/api/v1/rider/availability` | Toggle rider availability |
| `PUT` | `/api/v1/rider/location` | Update rider GPS coordinates |
| `POST` | `/api/v1/rider/accept` | Accept a delivery order |
| `PUT` | `/api/v1/rider/status` | Update delivery status (picked_up / delivered) |

### Admin Service `:5006`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/restaurants` | List pending restaurants |
| `PUT` | `/api/v1/admin/restaurant/verify` | Verify a restaurant |
| `GET` | `/api/v1/admin/riders` | List pending riders |
| `PUT` | `/api/v1/admin/rider/verify` | Verify a rider |

### Realtime Service `:5004` (internal only)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/internal/emit` | Emit Socket.io event to a room (requires `x-internal-key`) |

---

## 📋 Scripts

| Script | Command | Description |
|---|---|---|
| Dev (backend) | `npm run dev` | TypeScript watch + Node hot-reload via `concurrently` |
| Build (backend) | `npm run build` | Compile TypeScript → `dist/` |
| Start (backend) | `npm start` | Run compiled `dist/index.js` (production / Docker) |
| Dev (frontend) | `npm run dev` | Vite dev server at `:5173` |
| Build (frontend) | `npm run build` | Type-check + Vite production build → `dist/` |
| Preview (frontend) | `npm run preview` | Serve production build locally |
| Lint (frontend) | `npm run lint` | ESLint across all source files |

---

## 🐳 Deployment

### Frontend → Vercel

`frontend/vercel.json` rewrites all routes to `index.html` for client-side routing:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

### Backend → Docker

Each service has a multi-stage Dockerfile (`node:22-alpine`):

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

### Service Port Reference

| Service | Port |
|---|---|
| Auth | 5000 |
| Restaurant | 5001 |
| Utils | 5002 |
| Realtime | 5004 |
| Rider | 5005 |
| Admin | 5006 |
| Frontend (dev) | 5173 |

---

## 🏁 Project Structure

```
tomato-code/
├── README.md
├── SPEC.md                          # Full architectural specification
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── vercel.json                  # SPA routing rewrites
│   └── src/
│       ├── App.tsx                  # Route definitions (React Router v7)
│       ├── types.ts                 # Shared TypeScript interfaces
│       ├── context/
│       │   ├── AppContext.tsx        # Global auth + cart state
│       │   └── SocketContext.tsx     # Socket.io connection + event listeners
│       ├── pages/
│       │   ├── Home.tsx             # Restaurant discovery (GPS + $geoNear)
│       │   ├── Restaurant.tsx       # Menu browsing + add to cart
│       │   ├── Cart.tsx             # Cart management
│       │   ├── Checkout.tsx         # Razorpay / Stripe payment
│       │   ├── OrderPage.tsx        # Live order tracking
│       │   ├── UserOrderMap.tsx     # Leaflet map with OSRM rider route
│       │   ├── RiderDashboard.tsx   # Rider availability + order list
│       │   ├── Admin.tsx            # Admin verification panel
│       │   └── ...
│       └── components/
│           ├── RiderOrderMap.tsx    # Rider's live map view
│           ├── RiderOrderRequest.tsx # Incoming delivery alert
│           └── ...
└── services/
    ├── auth/                        # Google OAuth + JWT issuing
    │   └── src/
    │       ├── controllers/auth.ts
    │       └── model/User.ts
    ├── restaurant/                  # Core domain service
    │   └── src/
    │       ├── controllers/         # orders, cart, menu, address, restaurant
    │       ├── models/              # Order, Cart, MenuItem, Restaurant, Address
    │       └── config/
    │           ├── rabbitmq.ts      # Channel setup
    │           ├── order.publisher.ts   # Publishes to payment_event
    │           └── payment.consumer.ts  # Consumes payment_event
    ├── utils/                       # Cloudinary + Payments
    │   └── src/
    │       └── controllers/
    │           ├── upload.ts        # Cloudinary DataURI upload
    │           └── payment.ts       # Razorpay + Stripe handlers
    ├── realtime/                    # Socket.io hub
    │   └── src/
    │       ├── socket.ts            # io setup + room management
    │       └── routes/internal.ts  # POST /internal/emit
    ├── rider/                       # Rider lifecycle
    │   └── src/
    │       ├── controllers/         # register, accept, location, status
    │       └── model/Rider.ts       # 2dsphere location index
    └── admin/                       # Verification-only service
        └── src/
            └── controllers/admin.ts
```

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

*Built with Node.js · TypeScript · React 19 · MongoDB · RabbitMQ · Socket.io · Docker · Razorpay · Stripe · Cloudinary · Leaflet*
