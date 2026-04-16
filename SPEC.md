# SPEC.md — Technical Specification: ServeBites Food Delivery Platform

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Technology Choices and Rationale](#2-technology-choices-and-rationale)
3. [Data Architecture](#3-data-architecture)
4. [Authentication and Authorization](#4-authentication-and-authorization)
5. [API Design](#5-api-design)
6. [Key User Flows](#6-key-user-flows)
7. [Third-Party Integrations](#7-third-party-integrations)
8. [Security Decisions](#8-security-decisions)
9. [Infrastructure and Deployment](#9-infrastructure-and-deployment)
10. [Known Gaps and TODOs](#10-known-gaps-and-todos)

---

## 1. System Architecture

### High-Level Overview

ServeBites is a **microservices monorepo**. Six independent backend services and one React SPA communicate via HTTP (REST), RabbitMQ message queues, and Socket.io.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (React SPA)                                 │
│  • Axios HTTP calls to each service directly (hardcoded localhost URLs)      │
│  • Socket.io WebSocket to Realtime service                                  │
└─────┬────────┬──────────┬──────────┬──────────┬───────────┬────────────────┘
      │        │          │          │          │           │
      ▼        ▼          ▼          ▼          ▼           ▼
  Auth(5000) Restaurant(5001) Utils(5002) Realtime(5004) Rider(5005) Admin(5006)
      │        │    │    │       │  │          │              │
      │        │    │    │       │  │     Socket.io           │
      │        │    │    │       │  │     rooms               │
      │        │    │    │       └──┼─── HTTP POST /emit ─────┤
      │        │    │    │          │    (x-internal-key)     │
      │        │    │    │          │                         │
      │        │    └────┼──────────┼── HTTP (PAYMENT_QUEUE)  │
      │        │         │  RabbitMQ│                         │
      │        └─────────┼──────────┼── ORDER_READY_QUEUE ────┘
      │                  │          │
      ▼                  ▼          ▼
   MongoDB           MongoDB     Cloudinary
  (auth DB)       (restaurant   (image store)
                    + rider DB)
```

### Service Responsibilities

| Service | What it does | Port |
|---|---|---|
| **auth** | Google OAuth code exchange, JWT issuance, user creation, role assignment | 5000 |
| **restaurant** | Restaurant CRUD, menu item CRUD, cart management, address management, order lifecycle (create → status updates → rider assignment) | 5001 |
| **utils** | Receives base64 images and uploads to Cloudinary; creates and verifies Razorpay and Stripe payments; publishes PAYMENT_SUCCESS events to RabbitMQ | 5002 |
| **realtime** | Hosts Socket.io server; exposes a single internal HTTP endpoint `/api/v1/internal/emit` that other services call to push events to connected clients | 5004 |
| **rider** | Rider profile management, availability toggle (with geolocation), order acceptance (proxies to restaurant service), order status updates (proxies to restaurant service); consumes ORDER_READY_FOR_RIDER from RabbitMQ | 5005 |
| **admin** | Reads pending (unverified) restaurants and riders from MongoDB; marks them as verified; JWT + role guard (`admin` role required) | 5006 |

### Inter-Service Communication

| From | To | Channel | Purpose |
|---|---|---|---|
| `restaurant` | `realtime` | HTTP POST with `x-internal-key` | Emit `order:new` to restaurant room when payment confirmed |
| `restaurant` | `realtime` | HTTP POST with `x-internal-key` | Emit `order:update` to user room when restaurant changes order status |
| `restaurant` | `realtime` | HTTP POST with `x-internal-key` | Emit `order:rider_assigned` / `order:rider_assigned` to user and restaurant rooms on status change |
| `restaurant` | `utils` | HTTP POST | Upload image via `/api/upload` |
| `restaurant` → RabbitMQ | `rider` | `order_ready_queue` | Notify rider service when restaurant marks order `ready_for_rider` |
| `rider` | `realtime` | HTTP POST with `x-internal-key` | Emit `order:available` to nearby rider socket rooms |
| `rider` | `restaurant` | HTTP PUT with `x-internal-key` | Assign rider to order |
| `rider` | `restaurant` | HTTP GET with `x-internal-key` | Fetch rider's current active order |
| `rider` | `restaurant` | HTTP PUT with `x-internal-key` | Update order to `picked_up` or `delivered` |
| `utils` → RabbitMQ | `restaurant` | `payment_event` | Signal payment success after Razorpay/Stripe verification |
| `utils` | `restaurant` | HTTP GET with `x-internal-key` | Retrieve order amount for payment initiation |
| `rider` | `utils` | HTTP POST | Upload rider profile image |
| Frontend | `realtime` | Socket.io WebSocket | Receive real-time order updates and rider location |
| Frontend (rider) | `realtime` | HTTP POST with `VITE_INTERNAL_SERVICE_KEY` | Emit rider GPS location to customer's socket room |

### RabbitMQ Queues

| Queue name | Producer | Consumer | Message type |
|---|---|---|---|
| `payment_event` | `utils` | `restaurant` | `{ type: "PAYMENT_SUCCESS", data: { orderId, paymentId, provider } }` |
| `order_ready_queue` | `restaurant` | `rider` | `{ type: "ORDER_READY_FOR_RIDER", data: { orderId, restaurantId, location } }` |
| `rider_queue` | Declared by `restaurant` and `rider` | — | Not consumed in current code (see [Known Gaps](#10-known-gaps-and-todos)) |

### Socket.io Rooms

| Room name | Joined by | Events received |
|---|---|---|
| `user:<userId>` | Every authenticated frontend client | `order:new`, `order:update`, `order:rider_assigned`, `order:available` (riders), `rider:location` (customers) |
| `restaurant:<restaurantId>` | Seller client (when `restaurantId` is present in JWT) | `order:new`, `order:rider_assigned` |

---

## 2. Technology Choices and Rationale

### Express.js 5

Used as the HTTP framework for all six backend services. *Inferred rationale:* lightweight, familiar, and sufficient for the scale of this project. Each service is a standalone Express app.

### MongoDB + Mongoose

Chosen as the primary database. GeoJSON-based geospatial queries (`$geoNear`, `$near`) are used heavily for restaurant discovery and rider matching, which MongoDB supports natively with 2dsphere indexes. Mongoose ODM is used in `auth`, `restaurant`, and `rider` services.

The `admin` service uses the **native MongoDB driver** directly (not Mongoose). *Inferred rationale:* the admin service only needs simple collection reads and updates without the schema validation overhead of Mongoose.

### RabbitMQ (amqplib)

Used as a message broker for two asynchronous flows:
1. Payment confirmation → restaurant service
2. Order ready → rider service

*Inferred rationale:* decouples payment processing from order management, and decouples rider dispatch from restaurant logic, so each can fail independently without blocking the request cycle.

### Socket.io

Chosen for real-time bidirectional communication between the backend and the React frontend. Used for: live order status updates, rider assignment notifications, and real-time rider GPS location sharing with customers.

The realtime service acts as a **fan-out hub**: other backend services POST to its internal `/emit` endpoint rather than managing Socket.io connections themselves. This centralises real-time logic.

### Cloudinary

Used for all image uploads (restaurant banners, menu item images, rider profile photos). Images are converted to base64 data URIs using `datauri` + `multer`, then sent to the `utils` service which uploads them via Cloudinary's Node SDK.

### Razorpay

Indian payment gateway used for card/UPI/netbanking payments in INR. The flow is: create Razorpay order → open Razorpay checkout popup in browser → verify server-side with HMAC SHA256 signature.

### Stripe

International card payment gateway, used as an alternative to Razorpay. Uses Stripe Checkout hosted session (redirect flow). The frontend redirects to Stripe, which redirects back to `/ordersuccess?session_id=...`.

### Google OAuth 2.0 (googleapis)

Used exclusively for user authentication. The **auth-code flow** is used (`flow: "auth-code"` in the frontend). The backend exchanges the code for tokens via `oauth2client.getToken()`, then fetches the user's Google profile.

### Leaflet + React-Leaflet + Leaflet-Routing-Machine

Map library used for:
- Customer: interactive address picker (click on map to set delivery location)
- Customer: live order tracking map (shows rider location + delivery destination)
- Rider: delivery map with routing overlay (shows route from current location to delivery address)

OSRM (`https://router.project-osrm.org/route/v1`) is used for turn-by-turn routing. This is a public free endpoint.

### Nominatim (OpenStreetMap)

Free reverse geocoding API. Used to convert GPS coordinates to human-readable addresses (`https://nominatim.openstreetmap.org/reverse`). No API key required.

### Tailwind CSS 4

Utility-first CSS framework. Used throughout the frontend for all styling.

### Vite 7

Frontend build tool. TypeScript compilation via `tsc -b` + Vite bundling for production builds.

### Docker (multi-stage builds, node:22-alpine)

Each backend service has an identical multi-stage Dockerfile: build stage compiles TypeScript; production stage runs compiled JS with only production dependencies. Base image is `node:22-alpine`.

---

## 3. Data Architecture

### Database: `ServeBites` (MongoDB)

All services that use MongoDB connect to the same database name `ServeBites`, though they use separate MongoDB connections.

---

### Collection: `users` (managed by `auth` service)

```
{
  _id: ObjectId,
  name: String (required),
  email: String (required, unique),
  image: String (required) — Cloudinary URL from Google profile picture,
  role: String | null (default: null) — one of: "customer" | "rider" | "seller" | "admin",
  createdAt: Date,
  updatedAt: Date
}
```

- `role` starts as `null` after first login; user must select a role.
- `admin` role is not selectable from the UI — must be set manually in the database.

---

### Collection: `restaurants` (managed by `restaurant` service)

```
{
  _id: ObjectId,
  name: String (required, trimmed),
  description: String (optional),
  image: String (required) — Cloudinary URL,
  ownerId: String (required) — user._id from JWT,
  phone: Number (required),
  isVerified: Boolean (required, set to false on creation),
  autoLocation: {
    type: "Point",
    coordinates: [longitude, latitude],  — GeoJSON format
    formattedAddress: String
  },
  isOpen: Boolean (default: false),
  createdAt: Date,
  updatedAt: Date
}
```

- 2dsphere index on `autoLocation` for geospatial queries.
- `isVerified` must be set to `true` by an admin before the restaurant appears in search results.

---

### Collection: `menuitems` (managed by `restaurant` service)

```
{
  _id: ObjectId,
  restaurantId: ObjectId (ref: Restaurant, required, indexed),
  name: String (required, trimmed),
  description: String (trimmed),
  price: Number (required),
  image: String (required) — Cloudinary URL,
  isAvailable: Boolean (default: true),
  createdAt: Date,
  updatedAt: Date
}
```

---

### Collection: `carts` (managed by `restaurant` service)

```
{
  _id: ObjectId,
  userId: ObjectId (ref: User, required, indexed),
  restaurantId: ObjectId (ref: Restaurant, required, indexed),
  itemId: ObjectId (ref: MenuItem, required, indexed),
  quauntity: Number (default: 1, min: 1),  — note: misspelled in schema
  createdAt: Date,
  updatedAt: Date
}
```

- Compound unique index on `{ userId, restaurantId, itemId }` — one cart row per (user, restaurant, item) tuple.
- A customer can only have cart items from one restaurant at a time (enforced in `addToCart`).

---

### Collection: `orders` (managed by `restaurant` service)

```
{
  _id: ObjectId,
  userId: String (required),
  restaurantId: String (required),
  restaurantName: String (required),
  riderId: String | null (default: null),
  riderName: String | null (default: null),
  riderPhone: Number | null (default: null),
  riderAmount: Number (required) — ₹17 × ceil(distance in km),
  distance: Number (required) — in km (Haversine formula),
  items: [{ itemId, name, price, quauntity }],  — snapshot at order time
  subtotal: Number,
  deliveryFee: Number,         — ₹49 if subtotal < ₹250, else ₹0
  platfromFee: Number,         — always ₹7 (note: misspelled field name)
  totalAmount: Number,
  addressId: String,
  deliveryAddress: {
    fromattedAddress: String,  — note: misspelled field name
    mobile: Number,
    latitude: Number,
    longitude: Number
  },
  status: "placed" | "accepted" | "preparing" | "ready_for_rider" |
          "rider_assigned" | "picked_up" | "delivered" | "cancelled",
  paymentMethod: "razorpay" | "stripe",
  paymentStatus: "pending" | "paid" | "failed",
  expiresAt: Date (TTL index, expireAfterSeconds: 0) — set to now+15min, removed on payment,
  createdAt: Date,
  updatedAt: Date
}
```

- TTL index on `expiresAt`: unpaid orders auto-delete after 15 minutes.
- On successful payment the `expiresAt` field is `$unset` to prevent deletion.

---

### Collection: `addresses` (managed by `restaurant` service)

```
{
  _id: ObjectId,
  userId: String (required),
  mobile: Number (required),
  formattedAddress: String (required),
  location: {
    type: "Point",
    coordinates: [longitude, latitude]
  },
  createdAt: Date,
  updatedAt: Date
}
```

- 2dsphere index on `location`.

---

### Collection: `riders` (managed by `rider` service)

```
{
  _id: ObjectId,
  userId: String (required, unique) — user._id from JWT,
  picture: String (required) — Cloudinary URL,
  phoneNumber: String (required, trimmed),
  aadharNumber: String (required),
  drivingLicenseNumber: String (required),
  isVerified: Boolean (default: false) — must be verified by admin,
  location: {
    type: "Point",
    coordinates: [longitude, latitude]
  },
  isAvailble: Boolean (default: false),  — note: misspelled field name
  lastActiveAt: Date (default: now),
  createdAt: Date,
  updatedAt: Date
}
```

- 2dsphere index on `location`.
- Rider is matched by proximity to restaurant (within 500m, see `orderReady.consumer.ts`).

---

### Data Flow: Order Creation

```
Customer cart (snapshot at order time)
    ↓
Order document created (status: placed, paymentStatus: pending, expiresAt: now+15min)
    ↓  [payment initiated]
Razorpay/Stripe payment completed
    ↓
utils service publishes to payment_event queue
    ↓
restaurant service consumes → sets paymentStatus: paid, $unset expiresAt
    ↓
order persists indefinitely; riders and restaurant can update status
```

---

## 4. Authentication and Authorization

### Auth Flow

1. User clicks "Continue with Google" in the browser.
2. Frontend uses `@react-oauth/google` with `flow: "auth-code"` to obtain an authorization code.
3. Frontend POSTs the code to `auth` service `/api/auth/login`.
4. `auth` service calls `oauth2client.getToken(code)` (Google OAuth2) and fetches the user profile from `https://www.googleapis.com/oauth2/v1/userinfo`.
5. User is found or created in MongoDB (`users` collection).
6. A JWT is signed with `process.env.JWT_SEC` and returned: `jwt.sign({ user }, secret, { expiresIn: "15d" })`.
7. Token is stored in `localStorage` by the frontend.

### Token Structure

```json
{
  "user": {
    "_id": "...",
    "name": "...",
    "email": "...",
    "image": "...",
    "role": "customer | seller | rider | admin | null",
    "restaurantId": "..."   // present only for sellers after first restaurant fetch
  },
  "iat": ...,
  "exp": ...   // 15 days from issuance
}
```

The `user` object is embedded directly in the JWT payload on every request. Roles are **not re-fetched from DB on each request** — they are read from the token. A new token is issued when the role changes or when a seller first fetches their restaurant (to embed `restaurantId`).

### Token Storage

`localStorage` — frontend reads it with `localStorage.getItem("token")` and sends it as `Authorization: Bearer <token>`.

### Token Expiry

15 days. No refresh token mechanism exists. When the token expires the user is silently unauthenticated (no explicit redirect on expiry in the current code).

### Role-Based Access Control

| Role | Capabilities |
|---|---|
| `null` | Forced to `/select-role` page; cannot access any protected page |
| `customer` | Browse restaurants, manage cart, add addresses, place and track orders |
| `seller` | Full seller dashboard (restaurant management, menu, orders); routed to `<Restaurant />` component, not the standard SPA |
| `rider` | Rider dashboard (profile, availability toggle, order acceptance, delivery); routed to `<RiderDashboard />`, not the standard SPA |
| `admin` | Admin dashboard (verify restaurants and riders); routed to `<Admin />` component |

**Backend guards:**

- `isAuth` middleware (present in all services): verifies JWT, attaches `req.user`.
- `isSeller` middleware (`restaurant` service): checks `req.user.role === "seller"`.
- `isAdmin` middleware (`admin` service): checks `req.user.role === "admin"`.
- No rider-specific middleware in the `rider` service — role check is done inline in controllers.

**Inter-service auth:**

Internal API calls between services (e.g., from `rider` to `restaurant`, from `restaurant` to `realtime`) use a shared `x-internal-key` header validated against `process.env.INTERNAL_SERVICE_KEY`. This bypasses JWT.

---

## 5. API Design

### Conventions

- **Base paths:** each service uses a distinct prefix; no global API gateway or URL versioning across services (the `admin` and `realtime` services use `/api/v1`; others use `/api`).
- **Auth:** protected routes use `Authorization: Bearer <JWT>` header.
- **Response format:** JSON. Success responses vary per endpoint (no strict envelope enforced). Error responses are `{ message: "..." }`.
- **HTTP methods:** POST for create, GET for fetch, PUT for update (some controllers use PATCH for specific fields), DELETE for removal.
- **Internal routes:** protected with `x-internal-key` header instead of JWT.

### Auth Service (`http://localhost:5000`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | None | Exchange Google OAuth code for JWT |
| `PUT` | `/api/auth/add/role` | Bearer JWT | Set user role (customer/rider/seller) |
| `GET` | `/api/auth/me` | Bearer JWT | Get authenticated user profile |

### Restaurant Service (`http://localhost:5001`)

**Restaurants**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/restaurant/new` | JWT + isSeller | Create a new restaurant (multipart/form-data with image) |
| `GET` | `/api/restaurant/my` | JWT + isSeller | Get the authenticated seller's restaurant |
| `PUT` | `/api/restaurant/status` | JWT + isSeller | Toggle restaurant open/closed |
| `PUT` | `/api/restaurant/edit` | JWT + isSeller | Update restaurant name/description |
| `GET` | `/api/restaurant/all` | JWT | Get nearby restaurants (`?latitude=&longitude=&radius=&search=`) |
| `GET` | `/api/restaurant/:id` | JWT | Get a single restaurant by ID |

**Menu Items**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/item/new` | JWT + isSeller | Add menu item (multipart/form-data with image) |
| `GET` | `/api/item/:id` | JWT | Get all menu items for a restaurant |
| `DELETE` | `/api/item/:id` | JWT + isSeller | Delete a menu item |

**Cart**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/cart/add` | JWT | Add item to cart (or increment if exists) |
| `GET` | `/api/cart/all` | JWT | Get cart with populated items and subtotal |
| `PUT` | `/api/cart/increment` | JWT | Increment item quantity |
| `PUT` | `/api/cart/decrement` | JWT | Decrement item quantity (or remove if reaches 0) |

**Addresses**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/address/new` | JWT | Add a delivery address |
| `GET` | `/api/address/all` | JWT | Get all addresses for the authenticated user |
| `DELETE` | `/api/address/:id` | JWT | Delete an address |

**Orders**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/order/new` | JWT | Create order from cart |
| `GET` | `/api/order/myorder` | JWT | Get all paid orders for the customer |
| `GET` | `/api/order/:id` | JWT | Get a single order (user-owned only) |
| `GET` | `/api/order/payment/:id` | `x-internal-key` | Get order amount for payment (internal) |
| `GET` | `/api/order/restaurant/:restaurantId` | JWT + isSeller | Get restaurant's paid orders |
| `PUT` | `/api/order/:orderId` | JWT + isSeller | Update order status (accepted/preparing/ready_for_rider) |
| `PUT` | `/api/order/assign/rider` | `x-internal-key` | Assign a rider to an order (internal) |
| `GET` | `/api/order/current/rider` | `x-internal-key` | Get rider's current active order (internal) |
| `PUT` | `/api/order/update/status/rider` | `x-internal-key` | Update order to picked_up or delivered (internal) |

### Utils Service (`http://localhost:5002`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/upload` | None | Upload base64 image to Cloudinary, returns `{ url }` |
| `POST` | `/api/payment/create` | None | Create Razorpay order, returns Razorpay order ID + key |
| `POST` | `/api/payment/verify` | None | Verify Razorpay signature, publish PAYMENT_SUCCESS |
| `POST` | `/api/payment/stripe/create` | None | Create Stripe Checkout session, returns redirect URL |
| `POST` | `/api/payment/stripe/verify` | None | Verify Stripe session, publish PAYMENT_SUCCESS |

### Realtime Service (`http://localhost:5004`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/internal/emit` | `x-internal-key` | Emit an event to a Socket.io room |

### Rider Service (`http://localhost:5005`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/rider/new` | JWT | Create rider profile (multipart/form-data with image) |
| `GET` | `/api/rider/myprofile` | JWT | Get authenticated rider's profile |
| `PATCH` | `/api/rider/toggle` | JWT | Toggle availability and update current location |
| `POST` | `/api/rider/accept/:orderId` | JWT | Accept an available order |
| `GET` | `/api/rider/order/current` | JWT | Get rider's current active order |
| `PUT` | `/api/rider/order/update/:orderId` | JWT | Update order to picked_up or delivered |

### Admin Service (`http://localhost:5006`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/restaurant/pending` | JWT + isAdmin | List unverified restaurants |
| `GET` | `/api/v1/admin/rider/pending` | JWT + isAdmin | List unverified riders |
| `PATCH` | `/api/v1/verify/restaurant/:id` | JWT + isAdmin | Verify a restaurant |
| `PATCH` | `/api/v1/verify/rider/:id` | JWT + isAdmin | Verify a rider |

---

## 6. Key User Flows

### 6.1 User Registration and Login

```
Browser                          Auth Service                  MongoDB (users)
  │                                   │                              │
  ├─ Click "Continue with Google" ───►│                              │
  │  (auth-code flow, flow:"auth-code")                              │
  │◄─ Google authorization code ──────│                              │
  │                                   │                              │
  ├─ POST /api/auth/login { code } ──►│                              │
  │                                   ├─ oauth2client.getToken(code) │
  │                                   ├─ GET Google userinfo ────────│
  │                                   ├─ findOne({ email }) ────────►│
  │                                   │◄── user (or null) ───────────┤
  │                                   ├─ if !user: User.create() ───►│
  │                                   ├─ jwt.sign({ user }, 15d)     │
  │◄─ { token, user } ────────────────┤                              │
  │                                   │                              │
  ├─ localStorage.setItem("token")    │                              │
  ├─ if user.role === null → /select-role                            │
  │                                   │                              │
  ├─ PUT /api/auth/add/role { role }─►│                              │
  │                                   ├─ User.findByIdAndUpdate ─────►│
  │                                   ├─ jwt.sign({ user }, 15d)     │
  │◄─ { token, user } (new token) ────┤                              │
  │                                   │                              │
  ├─ localStorage.setItem("token") (updated)                         │
  └─ navigate("/")                    │                              │
```

### 6.2 Customer: Browse, Add to Cart, Place Order

```
1. Browser geolocates user via navigator.geolocation
2. Nominatim reverse geocodes coordinates → formatted address stored in React context

3. GET /api/restaurant/all?latitude=&longitude=&radius=5000
   → MongoDB $geoNear aggregation, maxDistance 5000m, only isVerified:true
   → sorted: isOpen first, then by distance

4. Customer opens restaurant → GET /api/item/:restaurantId
   → lists all menu items

5. POST /api/cart/add { restaurantId, itemId }
   → Rejects if cart already contains items from a different restaurant
   → Upserts cart row with $inc quauntity

6. GET /api/cart/all → populates itemId and restaurantId, returns subtotal

7. GET /api/address/all → customer selects delivery address

8. POST /api/order/new { paymentMethod, addressId }
   → Validates cart is not empty, restaurant is open
   → Haversine distance between delivery address and restaurant
   → deliveryFee = subtotal < 250 ? 49 : 0
   → platfromFee = 7
   → riderAmount = ceil(distance) * 17
   → Creates order with status:placed, paymentStatus:pending, expiresAt:now+15min
   → Deletes all cart items for user
   → Returns { orderId, amount }
```

### 6.3 Payment Flow

#### Razorpay

```
Frontend                          Utils Service                Restaurant Service
  │                                   │                              │
  ├─ POST /api/payment/create         │                              │
  │  { orderId } ────────────────────►│                              │
  │                                   ├─ GET /api/order/payment/:id ─►│
  │                                   │  (x-internal-key)            │
  │                                   │◄─ { orderId, amount } ───────┤
  │                                   ├─ razorpay.orders.create()    │
  │◄─ { razorpayOrderId, key } ───────┤                              │
  │                                   │                              │
  ├─ Razorpay popup opens             │                              │
  ├─ Customer pays                    │                              │
  ├─ Handler: POST /api/payment/verify│                              │
  │  { razorpay_order_id,             │                              │
  │    razorpay_payment_id,           │                              │
  │    razorpay_signature, orderId }─►│                              │
  │                                   ├─ HMAC SHA256 verify signature│
  │                                   ├─ publishPaymentSuccess() ──────────── RabbitMQ (payment_event)
  │◄─ { message: "Payment verified" } │
  │                                   │
  ├─ navigate("/paymentsuccess/:paymentId")
```

#### Stripe

```
Frontend                        Utils Service              Restaurant Service
  │                                  │                           │
  ├─ POST /api/payment/stripe/create │                           │
  │  { orderId } ───────────────────►│                           │
  │                                  ├─ GET /api/order/payment/:id►│
  │                                  │◄─ { amount } ─────────────┤
  │                                  ├─ stripe.checkout.sessions.create()
  │                                  │  success_url: /ordersuccess?session_id={CHECKOUT_SESSION_ID}
  │◄─ { url: stripe_hosted_url } ────┤
  │                                  │
  ├─ window.location = url (redirect to Stripe)
  ├─ Customer pays on Stripe
  ├─ Stripe redirects to /ordersuccess?session_id=...
  │
  ├─ POST /api/payment/stripe/verify { sessionId } ────────────►│
  │                                  ├─ stripe.checkout.sessions.retrieve(sessionId)
  │                                  ├─ extract orderId from session.metadata
  │                                  ├─ publishPaymentSuccess() ──────── RabbitMQ
  │◄─ { message: "payment verified" }│
```

#### After Payment (Shared)

```
RabbitMQ (payment_event)
    │
    └──► Restaurant Service consumer (startPaymentConsumer)
              ├─ Order.findOneAndUpdate: paymentStatus → "paid", $unset expiresAt
              └─ POST /realtime/api/v1/internal/emit
                   { event: "order:new", room: "restaurant:<id>", payload: { orderId } }
                        │
                        └──► Socket.io to restaurant room
                                  │
                                  └──► Seller's browser receives new order notification
```

### 6.4 Restaurant Processes Order

```
Seller Dashboard (RestaurantOrders component)
  │
  ├─ Receives "order:new" event via Socket.io
  ├─ Fetches order list
  │
  ├─ PUT /api/order/:orderId { status: "accepted" }   [via restaurant service]
  │   → validates seller owns restaurant, order is paid
  │   → POST /realtime emit "order:update" to user room
  │
  ├─ PUT /api/order/:orderId { status: "preparing" }
  │   → emits "order:update" to user room
  │
  ├─ PUT /api/order/:orderId { status: "ready_for_rider" }
  │   → emits "order:update" to user room
  │   → publishEvent("ORDER_READY_FOR_RIDER", { orderId, restaurantId, location })
  │      │
  │      └──► RabbitMQ (order_ready_queue)
  │               │
  │               └──► Rider Service consumer (startOrderReadyConsumer)
  │                       ├─ Rider.find({ isAvailble: true, isVerified: true,
  │                       │              location: { $near: restaurant_location, $maxDistance: 500m }})
  │                       └─ For each nearby rider:
  │                            POST /realtime emit "order:available" to user:<rider.userId> room
```

### 6.5 Rider Accepts and Delivers Order

```
Rider Dashboard (RiderDashboard + RiderCurrentOrder + RiderOrderMap)
  │
  ├─ Receives "order:available" via Socket.io
  ├─ Audio notification plays (if unlocked)
  ├─ RiderOrderRequest popup shown for 10 seconds
  │
  ├─ POST /api/rider/accept/:orderId
  │   → Rider.find({ userId, isAvailble: true })
  │   → PUT /restaurant/api/order/assign/rider (x-internal-key)
  │       { orderId, riderId, riderName, riderPhone }
  │       → Order.findOneAndUpdate (riderId: null only — prevents double assignment)
  │       → emits "order:rider_assigned" to user and restaurant rooms
  │   → Rider.findOneAndUpdate: isAvailble → false
  │
  ├─ Rider opens map (RiderOrderMap)
  │   → navigator.geolocation polls GPS
  │   → POST /realtime/api/v1/internal/emit "rider:location" to user:<userId> room
  │   → Customer's OrderPage receives "rider:location" → shows rider on map
  │
  ├─ PUT /api/rider/order/update/:orderId  (picked_up)
  │   → PUT /restaurant/api/order/update/status/rider (x-internal-key)
  │   → order.status → "picked_up"
  │   → emits "order:rider_assigned" to restaurant and user rooms
  │
  ├─ PUT /api/rider/order/update/:orderId  (delivered)
  │   → order.status → "delivered"
  │   → emits "order:rider_assigned" to restaurant and user rooms
```

### 6.6 Admin Verification Flow

```
Admin logs in with Google → role must be "admin" (set manually in DB)
  │
  ├─ GET /api/v1/admin/restaurant/pending  → lists restaurants where isVerified: false
  ├─ GET /api/v1/admin/rider/pending       → lists riders where isVerified: false
  │
  ├─ PATCH /api/v1/verify/restaurant/:id  → sets isVerified: true
  │   (restaurant now appears in search results for customers)
  │
  └─ PATCH /api/v1/verify/rider/:id       → sets isVerified: true
      (rider can now toggle availability and pick up orders)
```

### 6.7 Rider Registration Flow

```
User logs in with Google → selects "rider" role → navigated to RiderDashboard
  │
  ├─ If no rider profile exists → shows registration form
  ├─ POST /api/rider/new (multipart)
  │   fields: phoneNumber, aadharNumber, drivingLicenseNumber, latitude, longitude, image
  │   → image uploaded to Cloudinary via utils service
  │   → Rider document created: isVerified: false, isAvailble: false
  │
  ├─ Profile exists but isVerified: false → shown "pending verification" state
  ├─ Admin verifies → isVerified: true
  │
  └─ PATCH /api/rider/toggle { isAvailble: true, latitude, longitude }
     → Rider goes online; location stored as GeoJSON Point
```

---

## 7. Third-Party Integrations

### Google OAuth 2.0

- **Used by:** `auth` service
- **Library:** `googleapis` (`google.auth.OAuth2`)
- **Config:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; redirect URI is the string `"postmessage"` (used for auth-code flow from a browser without a redirect URL)
- **Purpose:** sole authentication mechanism; no username/password auth exists

### Cloudinary

- **Used by:** `utils` service
- **Library:** `cloudinary` v2
- **Config:** `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_SECRET_KEY`
- **How it is called:** other services send a base64 data URI string to `POST /api/upload`; `utils` calls `cloudinary.v2.uploader.upload(buffer)` and returns `secure_url`
- **Stored for:** restaurant images, menu item images, rider profile photos

### Razorpay

- **Used by:** `utils` service
- **Library:** `razorpay` v2.9
- **Config:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (server); `RAZORPAY_KEY_ID` returned to frontend for SDK initialisation
- **Payment verification:** HMAC SHA256 over `orderId|paymentId` using `RAZORPAY_KEY_SECRET`
- **Currency:** INR only

### Stripe

- **Used by:** `utils` service (server) + frontend
- **Libraries:** `stripe` v20.3 (server), `@stripe/stripe-js` v8.7 (frontend)
- **Config:** `STRIPE_SECRET_KEY` (server), `VITE_STRIPE_PUBLISHABLE_KEY` (frontend)
- **Flow:** Stripe Checkout hosted session (redirect to Stripe, return to app)
- **Verification:** session retrieved server-side via `stripe.checkout.sessions.retrieve(sessionId)`, `orderId` pulled from `session.metadata`

### RabbitMQ (self-hosted)

- **Used by:** `utils`, `restaurant`, `rider` services
- **Library:** `amqplib` 0.10
- **Connection string format:** `amqp://admin:admin123@localhost:5672`
- **Queues:** `payment_event`, `order_ready_queue`, `rider_queue`
- **Message format:** `{ type: string, data: object }`

### OpenStreetMap Nominatim

- **Used by:** frontend (browser fetch)
- **Purpose:** reverse geocoding — convert GPS coordinates to human-readable address strings
- **Endpoint:** `https://nominatim.openstreetmap.org/reverse?format=json&lat=&lon=`
- **No API key required**
- **Rate limiting:** Nominatim's public endpoint has a 1 req/sec limit — no throttling is implemented in the current code

### OSRM (Open Source Routing Machine)

- **Used by:** frontend (Leaflet-Routing-Machine)
- **Purpose:** draw turn-by-turn route overlay on the rider's delivery map
- **Endpoint:** `https://router.project-osrm.org/route/v1`
- **No API key required**
- **Note:** this is a public demo server; in production it should be self-hosted

---

## 8. Security Decisions

### JWT Handling

- Tokens signed with `JWT_SEC` (HS256 algorithm — symmetric, shared secret)
- 15-day lifespan; no short-lived access tokens, no refresh tokens
- `JWT_SEC` is the same secret across `auth`, `restaurant`, `rider`, `admin`, and `realtime` services — any service can verify any token
- Stored in `localStorage` (not `httpOnly` cookies), so XSS-accessible
- Token payload embeds the full user object including role — stale role information is possible until re-login if a role is changed server-side

### Internal Service Key

- `INTERNAL_SERVICE_KEY` is a shared static secret validated with a simple string equality check (`req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY`)
- Sent as an HTTP header between backend services — never exposed to clients in the API design
- **Exception:** `VITE_INTERNAL_SERVICE_KEY` is set in `frontend/.env` and used by the rider's browser to call `POST /api/v1/internal/emit` directly. This means the internal service key is exposed to every user's browser. This is a security concern — see [Known Gaps](#10-known-gaps-and-todos).

### Razorpay Signature Verification

- HMAC SHA256 over `razorpay_order_id|razorpay_payment_id` using `RAZORPAY_KEY_SECRET`
- Verified server-side before publishing PAYMENT_SUCCESS event
- Prevents forged payment confirmations

### Stripe Verification

- Stripe session retrieved server-side via the Stripe SDK using the session ID
- `orderId` is read from `session.metadata` which was set at session creation time — not from the client request

### CORS

- All backend services use the default `cors()` options: `Access-Control-Allow-Origin: *`
- This permits requests from any origin. In production, origins should be restricted to the frontend domain

### Input Validation

- Most endpoints check for the presence of required fields and return 400 if missing
- `ObjectId` validity is checked before MongoDB queries in several controllers (`cart.ts`, `admin.ts`)
- Role validation in `addUserRole` uses an allowlist: `["customer", "rider", "seller"]`
- No schema-level input sanitisation library (e.g., Zod, Joi) is used

### Single-Restaurant Cart Enforcement

- `addToCart` queries for any cart item from a different restaurant before inserting; returns 400 if found — prevents mixing orders from multiple restaurants

### Order Assignment Race Condition Mitigation

- `assignRiderToOrder` uses `findOneAndUpdate({ _id: orderId, riderId: null }, ...)` — the `riderId: null` condition acts as an optimistic lock to prevent two riders from being assigned to the same order simultaneously

---

## 9. Infrastructure and Deployment

### Frontend

- **Platform:** Vercel
- **Config:** `frontend/vercel.json` rewrites all paths to `/index.html` for SPA routing
- **Build command:** `tsc -b && vite build`
- **Service URLs:** hardcoded as `http://localhost:*` in `frontend/src/main.tsx` — this means the production build will point to localhost unless environment variables or a rewrite proxy is configured. No `VITE_*` service URL variables exist in the `.env` file for the service base URLs (*inferred gap*)

### Backend Services

- Each service has an identical multi-stage Dockerfile:
  - Build stage: `node:22-alpine`, installs all deps, runs `tsc`
  - Production stage: `node:22-alpine`, installs only production deps, copies `dist/`
- **No `docker-compose.yml` exists** — services must be started individually or orchestrated externally
- **No CI/CD configuration** (no `.github/workflows/`, no `Jenkinsfile`, no `.gitlab-ci.yml`) — deployment pipeline not documented in codebase

### MongoDB

- All services connect to a single MongoDB instance at `MONGO_URI`, database `ServeBites`
- MongoDB Atlas or a self-hosted replica set can be used
- 2dsphere geospatial indexes required on `restaurants.autoLocation`, `addresses.location`, `riders.location`

### RabbitMQ

- Required before starting `restaurant`, `rider`, and `utils` services
- Default credentials used in `.env` examples: `admin:admin123`
- Queues are asserted (created if not exists) on service startup with `durable: true`

### Environments

No staging/production environment distinction exists in the current configuration. All `.env` files are local development configs. Environment-specific configuration is not documented in the codebase — needs input from team.

---

## 10. Known Gaps and TODOs

### Code-level issues

| Location | Issue |
|---|---|
| `services/rider/src/controllers/rider.ts` | In `acceptOrder`, `riderName` is set to `rider.picture` (the image URL), not a name. The `Rider` model has no `name` field. The `riderName` stored on the order will be a Cloudinary URL. |
| `services/restaurant/src/models/Order.ts` | Field `quauntity` is consistently misspelled as `quauntity` throughout models, controllers, types, and frontend. This is a cosmetic issue but must be preserved for data compatibility. |
| `services/restaurant/src/models/Order.ts` | Field `platfromFee` (platform fee) is misspelled. |
| `services/restaurant/src/models/Order.ts` | Field `deliveryAddress.fromattedAddress` is misspelled as `fromattedAddress` instead of `formattedAddress`. |
| `frontend/src/main.tsx` | All backend service URLs are hardcoded as `http://localhost:5001` etc. — there is no environment variable for service base URLs. The same code cannot be deployed to production without code changes. |
| `frontend/.env` | `VITE_INTERNAL_SERVICE_KEY` exposes the internal service-to-service auth key to the browser. This is used to let the rider's map emit location events directly to the realtime service. In production the realtime service endpoint for this should either be authenticated differently or proxied. |
| All services | `cors()` is configured with `origin: *`. Should be restricted to the known frontend origin in production. |
| `services/realtime/src/socket.ts` | CORS for Socket.io is also set to `origin: "*"`. |

### Architecture gaps

| Gap | Description |
|---|---|
| `rider_queue` (RIDER_QUEUE) | This queue is declared and asserted in both the `restaurant` and `rider` services, but no producer publishes to it and no consumer reads from it in the current codebase. Its intended purpose is unknown. |
| No API gateway | The frontend calls each microservice directly using hardcoded localhost ports. There is no reverse proxy, load balancer, or API gateway. |
| No rate limiting | No rate limiting is implemented on any endpoint. |
| No token refresh | JWT tokens have a 15-day lifespan with no refresh mechanism. Expired tokens require the user to log in again. |
| No health check endpoints | No `/health` or `/ping` routes exist on any service. |
| No docker-compose | Services must be started manually. A `docker-compose.yml` would simplify local setup. |
| No CI/CD | No automated pipeline for build, test, or deployment. |
| No test suite | No test files (`*.test.ts`, `*.spec.ts`) exist in the repository. |
| Nominatim rate limit | The public Nominatim API has a 1 request/second limit. No throttle or caching is implemented. Under normal use this will be exceeded. |
| OSRM public server | The routing machine in `RiderOrderMap.tsx` uses the public OSRM demo server (`router.project-osrm.org`). This is not suitable for production. |
| Admin role provisioning | There is no UI or API endpoint to grant the `admin` role to a user. It must be set directly in the MongoDB `users` collection. |
| Stripe `VITE_STRIPE_PUBLISHABLE_KEY` unused | The Stripe publishable key is in `frontend/.env` but is not imported or used anywhere in the frontend source. The Stripe checkout is a redirect flow handled entirely server-side. |
