# Expense Splitter API

A backend service for splitting shared expenses within a group — think Splitwise. Built with Node.js, TypeScript, Express, PostgreSQL, and Prisma.

## Features

- JWT-based authentication (signup/login)
- Group creation and membership management
- Expense creation with three split types: **equal**, **exact amounts**, and **percentage**
- Cent-accurate rounding (no floating-point drift — remainders are distributed deterministically rather than lost)
- Net balance calculation per group member
- **Debt simplification** — reduces all outstanding balances into the minimum number of settle-up transactions, using a greedy largest-debtor-to-largest-creditor matching algorithm
- Integration tests covering the full auth → group → expense → balance → settle-up flow

## Tech Stack

- **Runtime:** Node.js, TypeScript
- **Framework:** Express
- **Database:** PostgreSQL
- **ORM:** Prisma 7 (with `@prisma/adapter-pg`)
- **Auth:** JWT (`jsonwebtoken`), password hashing (`bcrypt`)
- **Validation:** Zod
- **Testing:** Vitest + Supertest

## Data Model

```
User ──< GroupMember >── Group
  │                        │
  │                        └──< Expense
  │                                │
  └──< ExpenseParticipant >───────┘
```

- **User** — account with hashed password
- **Group** — a shared context for expenses (e.g. "Trip to Cluj")
- **GroupMember** — join table between User and Group (composite unique on `groupId` + `userId`)
- **Expense** — a single cost, tied to a payer (`paidById`) and a group
- **ExpenseParticipant** — one row per person owing a share of a given expense, storing that specific `shareOwed`

The payer is not automatically assumed to share the cost — they're only debited if they also appear as an `ExpenseParticipant`, which is the default behavior for equal splits but is explicit for exact/percentage splits.

## Setup

```bash
git clone <this-repo>
cd <this-repo>
npm install
```

Create a `.env` file in the project root:

```
DATABASE_URL="postgresql://user:password@localhost:5432/dbname"
JWT_SECRET="your-secret-here"
```

Run migrations:

```bash
npx prisma migrate dev
```

Start the server:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## API Overview

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/signup` | No | Create an account |
| POST | `/login` | No | Get a JWT |
| POST | `/groups` | Yes | Create a group (creator auto-joins) |
| POST | `/groups/:groupId/members` | Yes | Add an existing user to a group by email |
| POST | `/expenses` | Yes | Create an expense (`splitType`: `equal` \| `exact` \| `percentage`) |
| GET | `/groups/:groupId/balances` | Yes | Net balance per member (positive = owed money, negative = owes money) |
| GET | `/groups/:groupId/settle-up` | Yes | Minimum set of transactions to resolve all balances |

## How Debt Simplification Works

Given a group's raw expense history, the naive approach — recording every individual expense as a separate IOU between the payer and each participant — produces far more transactions than necessary. Two people who each owe each other money from different expenses should simply net out, not generate two separate payments.

The approach used here:

1. **Compute net balance per member** — sum of what they paid minus sum of what they owe, across every expense in the group. This always sums to exactly zero across the group (money moves between people, it doesn't appear or vanish), which is the core invariant the test suite checks.
2. **Split members into creditors (positive balance) and debtors (negative balance).**
3. **Greedily match the largest debtor against the largest creditor**, settling the smaller of the two amounts, and repeat. Each step guarantees at least one person reaches exactly zero and drops out — which is what keeps the total number of transactions minimal.

This is verified in tests by applying every returned transaction back onto the original balances and confirming everyone lands at zero — checking the *property* that must hold, rather than hardcoding specific expected transactions.

## Rounding

All money math is done in integer cents internally, not floating-point dollars, specifically to avoid the classic `0.1 + 0.2 !== 0.3` class of bugs. When a split doesn't divide evenly (e.g. $10 split 3 ways), the leftover cent(s) are deterministically assigned rather than silently dropped, so split amounts always sum back to exactly the original total.
