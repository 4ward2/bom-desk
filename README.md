# bom-desk · 配料台

A local web app that sources parts for a PCB BOM. It first checks 立创商城 (LCSC) stock and price for every line. Lines LCSC cannot supply are then searched on 淘宝 (Taobao) and 闲鱼 (Xianyu), and the listings are ranked by how well they match.

本地运行的 BOM 配料工具：先查每一行在立创商城的库存和价格，立创缺货的再去淘宝、闲鱼搜索，按匹配度给商品排序。

## What it does

- **BOM parsing** (`src/bom.js`): reads the CSV/TSV that 嘉立创EDA exports (UTF-16 with BOM, tab separated) or a plain pasted list. Maps Chinese and English column names, normalizes MPNs and flags passives (R/C/L/FB) so they are not chased on marketplaces.
- **LCSC lookup** (`src/lcsc.js`): the anonymous product search that 嘉立创EDA itself uses, rate-limited to one request every 400 ms with a cache.
- **Marketplace search** (`src/market.js`): one persistent, headless Edge profile driven by Playwright. You log in by scanning a QR code shown in the app's own dialog. Results come from the responses the site's own search page loads; no request signing is reproduced. It never orders, chats or pays, and risk-control challenges are reported, not worked around.
- **Listing ranking** (`src/listing_rules.js`, `src/listing_flags.js`): scores listings against the BOM line (MPN, package, quantity). Drops ads and "wanted" (求购) posts, but keeps traders who also sell. Flags placeholder prices and listings whose text says the part isn't real.
- **Screenshot / image input** (`src/extract.js`, `src/helpers/`): OCR and QR decoding of pasted screenshots (Windows OCR via PowerShell), to pull part numbers and links out of images.
- **EDA bridge** (optional): `EDA_BRIDGE` (default `http://127.0.0.1:9151`) lets the app pull the BOM straight from an open 嘉立创EDA project through an MCP bridge.
- **Favorites** (`src/favorites.js`): remember trusted shops per platform.

## Run

Requires Node 20+ and Microsoft Edge.

```sh
npm install
npm start          # http://127.0.0.1:18790
npm test           # unit tests for the listing filters
```

`test/*.mjs` are manual end-to-end checks that need a logged-in session.

Your login lives in `.profile/` (the browser profile) and is never committed. Override the location with `BOM_DESK_PROFILE`.

## Notice

This tool automates a normal logged-in browser session on 淘宝 / 闲鱼 for personal part sourcing. Use it at a human pace and within those platforms' terms of service. You are responsible for your own account.

## License

MIT
