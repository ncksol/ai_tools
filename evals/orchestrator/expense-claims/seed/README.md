# Expense claims API

A small HTTP JSON API for recording expense claims. It is written in TypeScript and run directly by Node.js 24, which strips the types. There are no npm dependencies. Data is kept in memory and is lost when the server stops.

## Run and test

- Install: nothing to install.
- Start: `npm start` runs `node src/server.ts`. The server listens on the port in the `PORT` environment variable, or on 3000 when `PORT` is not set.
- Test: `npm test` runs every `test/**/*.test.ts` file with the built-in `node:test` runner.
- CI: `.github/workflows/ci.yml` runs `npm test` on Node 24 for every pull request and every push to `main`.

## Endpoints

| Method | Path | Success | Description |
|---|---|---|---|
| GET | `/health` | 200 | Returns `{ "status": "ok" }`. |
| POST | `/expenses` | 201 | Creates an expense and returns it. |
| GET | `/expenses` | 200 | Returns `{ "expenses": [...] }`, in the order the expenses were created. Optional filters: `category`, `from`, `to`. |
| GET | `/expenses/:id` | 200 | Returns one expense. |
| PATCH | `/expenses/:id` | 200 | Changes the fields sent and returns the whole expense. |
| DELETE | `/expenses/:id` | 204 | Deletes the expense. The response has no body. |

## Expenses

| Field | Type | Rules |
|---|---|---|
| `id` | string | Set by the server. Ignored in request bodies. |
| `date` | string | Required. A real calendar date written as `YYYY-MM-DD`. |
| `merchant` | string | Required. Must contain at least one character that is not a space. |
| `category` | string | Required. One of `meals`, `travel`, `lodging`, `other`. |
| `amount` | number | Required. In minor units (pence or cents): a whole number greater than 0. |
| `currency` | string | Required. One of `GBP`, `EUR`, `USD`. |
| `description` | string | Optional. Defaults to `""`. |
| `receipt` | boolean | Optional. Defaults to `false`. |

- `POST /expenses` needs every required field. `PATCH /expenses/:id` takes any subset of the fields except `id`, and each field sent follows the same rules.
- Fields that are not in the table are ignored.
- `GET /expenses` filters: `category` (one of the categories), and `from` and `to` (dates written as `YYYY-MM-DD`; both ends are included). All filters given must match. A filter with an invalid value returns 400 `VALIDATION_ERROR`, with the filter's name as `field`.

## Conventions

- **Routes:** every route is one entry in the route table in `src/routes.ts`. Add new endpoints there. `src/router.ts` matches paths, including `:param` segments.
- **Handlers:** a handler receives a `Ctx` (from `src/router.ts`) and returns `{ status, body }`. To return an error, throw an `HttpError` from `src/http.ts`.
- **Request bodies** are JSON objects.
- **Responses** with a body are JSON, with `Content-Type: application/json; charset=utf-8`.
- **Errors:** every error response has this shape:

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Some fields are invalid",
      "details": [{ "field": "amount", "message": "Must be a whole number greater than 0" }]
    }
  }
  ```

  `details` is always present, and is `[]` when no field is involved. A validation error has one `details` entry for each invalid field. Message wording is free.

  | Status | Code | When |
  |---|---|---|
  | 400 | `INVALID_JSON` | The request body is not valid JSON, or is not a JSON object. |
  | 400 | `VALIDATION_ERROR` | A field or query parameter breaks its rules. |
  | 404 | `NOT_FOUND` | There is no such route, or no resource with that id. |
  | 500 | `INTERNAL` | An unexpected error. |

- **Money:** amounts are whole numbers in minor units. Convert between currencies only with `convert(amountMinor, from, to)` from `src/money.ts`. It uses fixed rates, given as the value of one unit in GBP: GBP 1.00, EUR 0.85, USD 0.80. It computes `amountMinor × rate(from) ÷ rate(to)` and rounds half up to a whole minor unit. For example, `convert(10, "EUR", "GBP")` is 9 (8.5 rounded up) and `convert(100, "GBP", "EUR")` is 118.
- **Data:** `src/store.ts` holds all data in memory. `createApp()` in `src/app.ts` creates a new, empty store for each app.
- **Tests:** tests live in `test/`. `test/helpers.ts` starts the app on a random port for each test file.
- **Next release:** `docs/spec-v2.md` describes v2.
