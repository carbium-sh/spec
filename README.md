# Carbium spec

Machine-readable descriptions of the JSON-RPC methods served at `services.carbium.sh`.

| File | What it holds |
|---|---|
| [openrpc.json](openrpc.json) | An OpenRPC 1.4 document: every RPC, DAS and quote method, and every WebSocket subscription with its unsubscribe. Each method has its params, its result and one example. |
| [served.json](served.json) | The names of everything the services serve: methods, the REST quote route, subscriptions, Carbon Stream filters and calls, DCA and token routes. |
| [examples.json](examples.json) | One example params value per method. A value in angle brackets is a placeholder to replace. |
| [carbium.postman_collection.json](carbium.postman_collection.json) | A Postman collection: one request per RPC, DAS and quote method, one for the REST quote route, and one per account API call. |
| [openapi.json](openapi.json) | A copy of the account API description served at [carbium.sh/openapi.json](https://carbium.sh/openapi.json), which the collection is built from. |

## Use it

Point an OpenRPC tool at the raw file:

```
https://raw.githubusercontent.com/carbium-sh/spec/main/openrpc.json
```

How to read a method:

- `paramStructure` is `by-position` for the Solana methods, which take a JSON array, and `by-name` for the methods that take one object.
- `x-batch` says whether the method may share a JSON-RPC batch: `any`, `das` (only with other DAS methods) or `never`.
- `x-permit` marks the heavier reads. A batch holds at most two of them.
- A WebSocket method names its own server, `wss://services.carbium.sh`, and `x-notification` describes the frame it pushes.

In Postman, import `carbium.postman_collection.json`. Put `serviceKey` (a `c_serv_` key, for the JSON-RPC and REST folders) and `accountKey` (a `c_acct_` key, for the account API folder) in a Postman environment as current values, or in the Postman Vault, so a key does not leave with an exported collection. The file ships with both empty. Each JSON-RPC request has a test that reads the answer, because an unknown method also answers 200. The REST folder holds the quote's REST form, `GET /cq1/quote`, which has no schema in `openrpc.json` because OpenRPC describes JSON-RPC only. Values in angle brackets are placeholders. Do not run the whole collection: the folder "Changes the account" creates and removes keys and webhooks, and some JSON-RPC calls cost many credits. The WebSocket subscriptions are in `openrpc.json` only.

Carbon Stream is Yellowstone gRPC: use the upstream Yellowstone proto, and see `served.json` for the filters and calls it serves. The full reference is [carbium.sh/docs](https://carbium.sh/docs).

## Build it

`openrpc.json` is generated from the types of the TypeScript SDK. Rebuild it when they change. `pnpm build` reads them from a carbium-js checkout at `../carbium-js` and records that checkout's commit in `info.x-sdk-commit`, so the checkout must be at the commit you mean to name.

```bash
pnpm install --ignore-scripts
pnpm build        # openrpc.json from ../carbium-js, then the Postman collection
node --test
```

The tests check that the document is valid OpenRPC, that it lists exactly the names in `served.json`, that each method's example params fit their schemas, that no schema name depends on where the build ran, and one wording rule for our own text. For the collection they check that it is exactly what the builder writes, that it has one request per served method, per REST route and per account API operation, that every call that changes the account sits in its own folder, that no key ships in it, and that every JSON-RPC and REST request passes in the Postman runtime against a local stand-in server.

CI also rebuilds both files from the SDK commit named in `info.x-sdk-commit` and fails if they differ from the committed ones.

The live check calls each HTTPS method in `openrpc.json` once and checks the answer against that method's result schema, and calls the REST quote route once for a `destAmountOut` string. It skips five methods that send, need a transaction or scan heavily, and the swap call only builds an unsigned transaction for a public address. Run it with `CARBIUM_KEY=<your c_serv_ key> node scripts/live-check.mjs`: it makes one call a second and prints a line for each call that did not match. It exits 0 only when every call matched, 1 on a mismatch or a method the services do not serve, and 3 when any call is still UNREAD after its one retry. UNREAD means the call was refused (a rate limit, no credits, a server error or a JSON-RPC error), timed out, or waited on a value an earlier call did not give, so its shape was not checked.

## License

MIT
