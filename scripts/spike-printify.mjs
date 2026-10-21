// ---------------------------------------------------------------------------
// Printify contract test.
//
// Proves, against a live Printify shop, that the assumptions the bulk-listing
// feature is built on still hold. Run it after any Printify change:
//
//   npm run spike:printify
//
// It creates one unpublished product, checks the response, and DELETES it.
// Use --keep to leave it behind for inspection.
//
// The key is read from PRINTIFY_API_KEY, or from a `.dev.vars` file in the
// project root (git-ignored) so it never has to be passed on the command line.
// Without a key the script exits 0 with a "skipped" message, so it is safe to
// wire into a test runner.
//
// The contract being verified (see AGENTS.md for the full write-up):
//   1. A product's colour selection is expressed as VARIANT IDS. There is no
//      `colors` field on the create payload.
//   2. `print_areas` groups may each carry different artwork.
//   3. `print_areas` is REQUIRED - omitting it fails with code 8150.
//   4. The groups MUST form a complete partition of every variant, otherwise
//      Printify rewrites the last group and the wrong artwork is rendered.
//   5. x/y are centre-based; scale is image-width / placeholder-width.
//   6. Colour hexes only exist on a product, never on a catalogue entry.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "https://api.printify.com/v1";
const REPORT_PATH = path.join(ROOT, "dist", "spike-printify.json");
const KEEP = process.argv.includes("--keep");

async function loadKey() {
  const fromEnv = process.env.PRINTIFY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const devVars = path.join(ROOT, ".dev.vars");
  if (!existsSync(devVars)) return "";
  const text = await readFile(devVars, "utf8");
  const match = text.match(/^\s*PRINTIFY_API_KEY\s*=\s*(.+?)\s*$/m);
  return match ? match[1].replace(/^["']|["']$/g, "") : "";
}

const KEY = await loadKey();
if (!KEY) {
  console.log("[spike] SKIPPED - no PRINTIFY_API_KEY (env or .dev.vars).");
  process.exit(0);
}

// --- png (no dependencies) ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeSolidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- client ------------------------------------------------------------------

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": "MockupStudio-Spike/0.2 (+https://mockup-studio.adityadino678.workers.dev)",
    Authorization: `Bearer ${KEY}`,
    "X-API-Key": KEY,
  };
}

async function api(method, endpoint, body) {
  const doFetch = async () => {
    const res = await fetch(`${BASE}${endpoint}`, {
      method,
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, ok: res.ok, data };
  };
  let out = await doFetch();
  if (!out.ok && [502, 503, 504].includes(out.status)) {
    await new Promise((r) => setTimeout(r, 1500));
    out = await doFetch();
  }
  return out;
}

function extractError(data, status) {
  const root = data ?? {};
  const raw = root.error;
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const nested = typeof obj.errors === "object" && obj.errors !== null ? obj.errors : {};
  const candidates = [
    nested.reason,
    nested.message,
    obj.reason,
    obj.message,
    typeof raw === "string" ? raw : undefined,
    root.message,
  ];
  const message = candidates.find((c) => typeof c === "string" && c.trim().length > 0);
  return { message: message ?? `HTTP ${status}`, code: root.code ?? nested.code ?? obj.code ?? null };
}

const results = [];
let failures = 0;

function check(id, description, ok, detail) {
  if (!ok) failures++;
  results.push({ id, description, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${description}`);
  if (detail !== undefined) {
    console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

// --- run ---------------------------------------------------------------------

async function main() {
  console.log("[spike] Printify contract test");

  const shopsRes = await api("GET", "/shops.json");
  if (!shopsRes.ok) {
    console.error("[spike] FATAL -", extractError(shopsRes.data, shopsRes.status).message);
    process.exitCode = 1;
    return;
  }
  const shop = shopsRes.data[0];
  console.log(`[spike] shop ${shop.id} "${shop.title}" (${shop.sales_channel})`);

  // Pick a blueprint + print provider that offers at least two colours.
  const blueprints = (await api("GET", "/catalog/blueprints.json")).data ?? [];
  const blueprint =
    blueprints.find((b) => /unisex.*(cotton )?tee/i.test(b.title ?? "")) ??
    blueprints.find((b) => /t-?shirt/i.test(b.title ?? "")) ??
    blueprints[0];
  const providers = (await api("GET", `/catalog/blueprints/${blueprint.id}/print_providers.json`)).data ?? [];
  if (!providers.length) {
    console.error("[spike] FATAL - no print providers.");
    process.exitCode = 1;
    return;
  }
  const provider = providers[0];
  console.log(`[spike] blueprint ${blueprint.id} "${blueprint.title}" · provider ${provider.id} "${provider.title}"`);

  const raw = (await api(
    "GET",
    `/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json?show-out-of-stock=1`,
  )).data;
  const varRaw = raw;
  const variants = Array.isArray(raw) ? raw : (raw?.variants ?? []);
  if (variants.length < 2) {
    console.error("[spike] FATAL - not enough variants to test with.");
    process.exitCode = 1;
    return;
  }

  // Group the variants by colour using the catalogue's option strings.
  const colourOf = (v) => v.options?.color ?? v.title?.split(" / ")[0] ?? "unknown";
  const byColour = new Map();
  for (const v of variants) {
    const c = colourOf(v);
    if (!byColour.has(c)) byColour.set(c, []);
    byColour.get(c).push(v);
  }
  const colours = [...byColour.keys()];
  console.log(`[spike] ${variants.length} variants · ${colours.length} colours`);

  const placeholders = variants.flatMap((v) => v.placeholders ?? []);
  const area =
    placeholders.find((p) => p.position === "front") ?? placeholders[0] ?? { width: 3000, height: 3000 };
  const artW = area.width ?? 3000;
  const artH = area.height ?? 3000;

  // Two colours, split as evenly as possible; the rest become the fallback
  // group so the partition is COMPLETE (see AGENTS.md - an incomplete
  // partition makes Printify render the wrong artwork).
  const first = colours[0];
  const second = colours.find((c) => c !== first) ?? first;
  const groupA = byColour.get(first).map((v) => v.id);
  const groupB = byColour.get(second).map((v) => v.id);
  const assigned = new Set([...groupA, ...groupB]);
  const leftover = variants.filter((v) => !assigned.has(v.id)).map((v) => v.id);
  const groupBComplete = [...groupB, ...leftover];

  console.log(`[spike] partition: A(${first})=${groupA.length} B(${second})=${groupB.length} fallback+${leftover.length}`);

  const redPng = makeSolidPng(artW, artH, [255, 0, 0]);
  const bluePng = makeSolidPng(artW, artH, [0, 0, 255]);
  const upload = async (buf, name) => {
    const res = await api("POST", "/uploads/images.json", {
      file_name: name,
      contents: buf.toString("base64"),
    });
    if (!res.ok) throw new Error(`upload failed: ${extractError(res.data, res.status).message}`);
    return String(res.data.id);
  };
  const redId = await upload(redPng, "spike-red.png");
  const blueId = await upload(bluePng, "spike-blue.png");

  const areaEntry = (imageId) => ({
    position: area.position ?? "front",
    images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
  });

  // --- the product ------------------------------------------------------------
  const enabled = [...groupA, ...groupB];
  const body = {
    title: "[SPIKE] contract test",
    description: "Temporary product created by the Mockup Studio contract test.",
    blueprint_id: blueprint.id,
    print_provider_id: provider.id,
    variants: enabled.map((id) => ({ id, price: 2499, is_enabled: true })),
    print_areas: [
      { variant_ids: groupA, placeholders: [areaEntry(redId)] },
      { variant_ids: groupBComplete, placeholders: [areaEntry(blueId)] },
    ],
  };

  const createRes = await api("POST", `/shops/${shop.id}/products.json`, body);
  if (!createRes.ok) {
    check("create", "A product with two artwork groups can be created", false, extractError(createRes.data, createRes.status));
    return;
  }
  const productId = createRes.data.id;
  check("create", "A product with two artwork groups can be created", true, { productId });

  const product = (await api("GET", `/shops/${shop.id}/products/${productId}.json`)).data ?? {};

  // 1. the partition survives verbatim
  const echoed = (product.print_areas ?? []).map((a) => ({
    variant_ids: a.variant_ids ?? [],
    image_ids: (a.placeholders ?? []).flatMap((p) => p.images ?? []).map((i) => i.id),
  }));
  const partitionOk =
    echoed.length === 2 &&
    JSON.stringify([...echoed[0].variant_ids].sort()) === JSON.stringify([...groupA].sort()) &&
    JSON.stringify([...echoed[1].variant_ids].sort()) === JSON.stringify([...groupBComplete].sort());
  check("partition", "A complete partition is stored verbatim (no silent rewrite)", partitionOk, {
    sentA: groupA.length,
    sentB: groupBComplete.length,
    gotA: echoed[0]?.variant_ids.length,
    gotB: echoed[1]?.variant_ids.length,
  });

  // 2. each group carries its own artwork
  const artOk = echoed[0]?.image_ids.includes(redId) && echoed[1]?.image_ids.includes(blueId);
  check("artwork", "Each print_areas group keeps its own image", artOk, {
    groupA: echoed[0]?.image_ids,
    groupB: echoed[1]?.image_ids,
  });

  // 3. the placement convention round-trips
  const imgs = (product.print_areas ?? []).flatMap((a) => a.placeholders ?? []).flatMap((p) => p.images ?? []);
  const placementOk = imgs.every((i) => i.x === 0.5 && i.y === 0.5 && i.scale === 1 && i.angle === 0);
  check("placement", "x/y stay centre-based (0.5) and scale round-trips", placementOk, {
    images: imgs.map((i) => ({ x: i.x, y: i.y, scale: i.scale, angle: i.angle })),
  });

  // 4. the variant flags
  const enabledIds = (product.variants ?? []).filter((v) => v.is_enabled).map((v) => v.id);
  check("variants", "Only the selected variants are enabled", enabledIds.length === enabled.length, {
    enabled: enabledIds.length,
    expected: enabled.length,
  });

  // 5. colour hexes live on the product
  const colourOption = (product.options ?? []).find((o) => /colou?r/i.test(o.type ?? o.name ?? ""));
  const hexes = (colourOption?.values ?? []).flatMap((v) => v.colors ?? []);
  check("hexes", "The product carries real colour hexes (the catalogue does not)", hexes.length > 0, {
    option: colourOption?.name,
    display_in_preview: colourOption?.display_in_preview,
    sample: (colourOption?.values ?? []).slice(0, 4),
  });

  // 6. the shapes the app actually depends on
  const variantList = Array.isArray(varRaw) ? varRaw : (varRaw?.variants ?? []);
  const withColour = variantList.filter((v) => typeof v.options?.color === "string");
  const withSize = variantList.filter((v) => typeof v.options?.size === "string");
  check(
    "variant-options",
    "Every catalogue variant carries options.color and options.size",
    withColour.length === variantList.length && withSize.length === variantList.length,
    {
      total: variantList.length,
      withColor: withColour.length,
      withSize: withSize.length,
      note: "The app groups variants by these strings; a rename would silently merge every colour.",
    },
  );

  const withArea = variantList.filter(
    (v) =>
      (v.placeholders ?? []).length > 0 &&
      (v.placeholders ?? []).every((p) => Number.isFinite(p.width) && Number.isFinite(p.height)),
  );
  check(
    "placeholder-size",
    "Every variant's placeholders report a width and a height",
    withArea.length === variantList.length,
    {
      total: variantList.length,
      withSize: withArea.length,
      note: "The print area size comes from here; without it the upload cannot be sized.",
    },
  );

  // 7. the shop product list shape (the template lookup depends on it)
  const shopProductsRaw = await api("GET", `/shops/${shop.id}/products.json?limit=50`);
  const shopProductsBody = shopProductsRaw.data ?? null;
  const shopProducts = shopProductsBody?.data;
  check(
    "product-list",
    "The shop product list returns { current_page, data: [...] }",
    Array.isArray(shopProducts),
    {
      keys: shopProductsBody && typeof shopProductsBody === "object" ? Object.keys(shopProductsBody) : null,
      count: Array.isArray(shopProducts) ? shopProducts.length : null,
      note: "The template lookup reads this; a different shape silently falls back to the colour table.",
    },
  );

  // 8. the catalogue is a SUBSET of the product's variants. The extra
  //    variants belong to colours the catalogue does not list, so the user
  //    can never select them - they are disabled in the product and only
  //    matter because they land in the last print area.
  const catalogueIds = new Set(variantList.map((v) => v.id));
  const productIds = new Set((product.variants ?? []).map((v) => v.id));
  const onlyInProduct = [...productIds].filter((id) => !catalogueIds.has(id));
  const onlyInCatalogue = [...catalogueIds].filter((id) => !productIds.has(id));
  const extraEnabled = (product.variants ?? []).filter(
    (v) => v.is_enabled && onlyInProduct.includes(v.id),
  );
  check(
    "catalogue-subset",
    "The catalogue lists a SUBSET of the product's variants, and the extras are disabled",
    onlyInCatalogue.length === 0 && extraEnabled.length === 0,
    {
      catalogue: catalogueIds.size,
      product: productIds.size,
      onlyInProduct: onlyInProduct.length,
      onlyInCatalogue: onlyInCatalogue.length,
      extraEnabled: extraEnabled.length,
      note: "The extras belong to colours the catalogue hides, so they are unreachable and disabled.",
    },
  );

  // 9. print_areas really is required
  const noAreas = await api("POST", `/shops/${shop.id}/products.json`, {
    title: "[SPIKE] no print areas",
    blueprint_id: blueprint.id,
    print_provider_id: provider.id,
    variants: enabled.slice(0, 1).map((id) => ({ id, price: 2499, is_enabled: true })),
  });
  let noAreasProductId = null;
  if (noAreas.ok) {
    noAreasProductId = noAreas.data?.id;
    check("required", "print_areas is required on create", false, {
      result: "ACCEPTED without print_areas - the assumption in AGENTS.md is wrong",
    });
  } else {
    const err = extractError(noAreas.data, noAreas.status);
    check("required", "print_areas is required on create", err.code === 8150, err);
  }

  // 7. products are created as unpublished drafts
  const unpub = await api("POST", `/shops/${shop.id}/products/${productId}/unpublish.json`);
  check("draft", "API-created products are drafts, not published", unpub.status === 400, {
    unpublishStatus: unpub.status,
    message: extractError(unpub.data, unpub.status).message,
  });

  // --- clean up ---------------------------------------------------------------
  if (!KEEP) {
    for (const id of [productId, noAreasProductId].filter(Boolean)) {
      const del = await api("DELETE", `/shops/${shop.id}/products/${id}.json`);
      console.log(`[spike] deleted ${id} (${del.status})`);
    }
  } else {
    console.log(`[spike] kept ${productId}${noAreasProductId ? ` and ${noAreasProductId}` : ""}`);
  }

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify({ at: new Date().toISOString(), results }, null, 2), "utf8");

  console.log(`\n[spike] ${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) {
    console.error("[spike] CONTRACT CHANGED - update AGENTS.md and the feature before shipping.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[spike] FATAL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
