<div align="center">

# ⚙️ Woocommerce Store — Backend API

**A secure, full-featured REST API powering the [Woocommerce Store](https://github.com/mohiuddinshanto/Woocomeerce-Store) frontend.**

Built with Express 5 + Prisma + MySQL, written in TypeScript — products, orders, coupons, reviews, staff, uploads, courier sync & branded email notifications.

</div>

---

## ✨ Features

- 🔐 **Authentication & roles** — session-cookie auth, bcrypt password hashing, `ADMIN` / `STAFF` role-based access control.
- 🗂 **Catalog management** — products, categories, pricing, stock, product **variations** (generate, duplicate, bulk create), featured images with **Multer uploads**.
- 📦 **Order pipeline** — `PENDING → CONFIRMED → IN_COURIER → SHIPPED → DELIVERED / CANCELLED`, with **IP-based cooldown** to block spam.
- 🚚 **Steadfast Courier integration** — send orders, sync tracking, bulk sync, and account balance checks.
- 🎟 **Coupons & reviews** — coupon validation, review submission with admin moderation.
- 📬 **Email notifications** — beautiful branded templates via Nodemailer (SMTP): owner gets a new-order alert, customers get status updates, plus a configurable test-email route.
- 🛠 **Store configuration** — home layout (`classic` / `catalog`), theme colors, feature flags, marketing & chat (WhatsApp/Messenger/phone), checkout options — all via a single admin config endpoint.
- 🔒 **Security** — AES-256-GCM encryption for stored API secrets (`APP_ENCRYPTION_KEY`), Zod request validation, CORS allowlist, session cookies.
- 📊 **Admin dashboard** — products, orders, categories, coupons, reviews and staff statistics.

## 🧰 Tech Stack

| | |
|---|---|
| Runtime | Node.js + [Express 5](https://expressjs.com) |
| Language | [TypeScript](https://www.typescriptlang.org) (run via [tsx](https://tsx.is)) |
| Database | MySQL via [Prisma 6](https://www.prisma.io) |
| Validation | [Zod](https://zod.dev) |
| Email | [Nodemailer](https://nodemailer.com) |
| Uploads | [Multer](https://github.com/expressjs/multer) (+ AWS S3 client-ready) |
| Caching | Not required — fresh reads, fast responses |

## 🚀 Getting Started

### Prerequisites

- Node.js ≥ 18
- A running **MySQL** server

> The frontend expects this API at the URL configured in its `NEXT_PUBLIC_API_URL`.

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```dotenv
# MySQL connection string (Prisma)
DATABASE_URL="mysql://USER:PASSWORD@127.0.0.1:3306/store_db"

# HTTP port
PORT=4000

# Comma-separated allowed CORS origins (your frontend domains)
FRONTEND_URL=http://localhost:3000

# AES-256-GCM encryption key (min 32 chars) — used to protect stored secrets
APP_ENCRYPTION_KEY=replace-with-a-32-character-minimum-secret-key

# (Docker Compose / production S3 & SMTP settings — see server config)
```

### 3. Set up the database

```bash
npm run prisma:generate    # Generate the Prisma client
npm run prisma:deploy      # Apply migrations
npm run seed               # (optional) seed sample data
```

### 4. Run

```bash
npm run dev        # watch mode on http://localhost:4000
```

Run a health check:

```bash
curl http://localhost:4000/health
# {"ok":true}
```

### 5. Production build

```bash
npm run build      # tsc → dist/
npm start          # node dist/server.js
```

## 🔌 API Overview

### Storefront (public)

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `GET` | `/api/store/status` | Public store config (layout, theme, nav, chat) |
| `GET` | `/api/store/checkout-options` | District/area options for checkout |
| `GET` | `/api/categories` | Category tree |
| `GET` | `/api/products` | Products (search, filter, pagination) |
| `GET` | `/api/products/:slug` | Product detail with variations & reviews |
| `POST` | `/api/newsletter/subscribe` | Newsletter sign-up |
| `POST` | `/api/coupons/validate` | Validate a coupon code |
| `POST` | `/api/onboarding` | First-run onboarding setup |
| `POST` | `/api/orders` | Place an order (IP cooldown) |

### Auth & customer

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/auth/sign-up` / `sign-in` | Register / login |
| `GET` / `POST` | `/api/auth/me` / `sign-out` | Session info / logout |
| `GET` / `POST` | `/api/wishlist` | Wishlist management |
| `POST` | `/api/products/:productId/reviews` | Submit a review |
| `GET` | `/api/account/orders` | Customer order history |

### Admin (auth + role required)

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/admin/dashboard` | Stats overview |
| `GET/POST/PATCH/DELETE` | `/api/admin/products…` | Product CRUD, variations, images |
| `POST` | `/api/admin/upload` | Image upload (Multer) |
| `GET/POST/PATCH/DELETE` | `/api/admin/categories…` | Category management |
| `GET/PATCH` | `/api/admin/orders…` | Orders + status updates |
| `POST` | `/api/admin/orders/:id/send-steadfast` | Send to Steadfast courier |
| `POST` | `/api/admin/orders/:id/sync-steadfast` | Sync tracking status |
| `POST` | `/api/admin/orders/sync-all-steadfast` | Bulk sync all orders |
| `GET` | `/api/admin/steadfast/balance` | Courier account balance |
| `GET/POST/DELETE` | `/api/admin/coupons…` | Coupon management |
| `GET/PATCH/DELETE` | `/api/admin/reviews…` | Review moderation |
| `GET/POST/DELETE` | `/api/admin/staff…` | Staff management |
| `GET/PATCH` | `/api/admin/config` | Full store configuration |
| `POST` | `/api/admin/test-email` | Send a test email |

## 📁 Project Structure

```
src/
├─ server.ts        # Express app — routes, auth, roles, validation
├─ seed.ts          # Sample data seeder
├─ test-admin.ts    # Admin helper script
└─ lib/
   ├─ mailer.ts     # Nodemailer SMTP + branded templates
   ├─ crypto.ts     # AES-256-GCM (de)encryption for secrets
   └─ …             # Shared helpers

prisma/
├─ schema.prisma    # Data model & enums
└─ migrations/      # Versioned SQL migrations
```

## ✅ Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Watch-mode dev server |
| `npm run build` | TypeScript compile to `dist/` |
| `npm start` / `npm run start` | Run compiled server |
| `npm run seed` | Seed sample data |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Create & apply dev migration |
| `npm run prisma:deploy` | Apply migrations in production |

---

<div align="center">

Made with ❤️ · [Open an issue](https://github.com/mohiuddinshanto/Woocomeerce-Store-Backend/issues)

</div>