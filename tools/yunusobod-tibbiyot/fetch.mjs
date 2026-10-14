#!/usr/bin/env node
// Yunusobod tumani (Toshkent) dagi barcha shifoxona, tug'ruqxona, poliklinika
// va klinikalarni OpenStreetMap (Overpass API) dan yig'ib, joylashuvi bilan chiqaradi.
//
// Ishga tushirish (Node 18+, qo'shimcha paket kerak emas):
//   node tools/yunusobod-tibbiyot/fetch.mjs
//
// Natija shu papkaga yoziladi:
//   natija.csv      - Excel'da ochish uchun
//   natija.geojson  - xaritaga (geojson.io, Google My Maps) yuklash uchun
//   natija.md       - Google/Yandex xarita havolalari bilan ro'yxat

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Tuman chegarasi nomi bo'yicha topiladi; topilmasa taxminiy bbox ishlatiladi.
const AREA_FILTER =
  '["boundary"="administrative"]["name"~"Yunusobod|Yunusabad|Юнусабад|Юнусобод",i]';
const FALLBACK_BBOX = "41.325,69.250,41.410,69.340"; // janub,g'arb,shimol,sharq

const MATERNITY_RE = "tug.?ruq|tugruq|роддом|родильн|перинатал|maternity|perinatal";

function buildQuery(scope) {
  return `[out:json][timeout:120];
${scope.startsWith("area") ? scope + "\n" : ""}(
  nwr${scopeSel(scope)}["amenity"~"^(hospital|clinic|doctors)$"];
  nwr${scopeSel(scope)}["healthcare"~"^(hospital|clinic|centre|birthing_centre|midwife|doctor)$"];
  nwr${scopeSel(scope)}["name"~"${MATERNITY_RE}|shifoxona|kasalxona|poliklinika|больниц|поликлиник|клиник|госпитал",i];
);
out center tags;`;
}

function scopeSel(scope) {
  return scope.startsWith("area") ? "(area.a)" : `(${scope})`;
}

async function overpass(query) {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.error(`! ${err.message} - keyingi serverga o'tilmoqda`);
    }
  }
  throw lastErr;
}

export function classify(tags) {
  const name = Object.entries(tags)
    .filter(([k]) => k === "name" || k.startsWith("name:") || k === "official_name")
    .map(([, v]) => v)
    .join(" ");
  if (
    new RegExp(MATERNITY_RE, "i").test(name) ||
    tags.healthcare === "birthing_centre" ||
    tags.healthcare === "midwife" ||
    /obstetric|gynaecolog/.test(tags["healthcare:speciality"] || "")
  ) {
    return "Tug'ruqxona / perinatal markaz";
  }
  if (tags.amenity === "hospital" || tags.healthcare === "hospital") return "Shifoxona (kasalxona)";
  if (/poliklinika|поликлиник|oilaviy|семейн/i.test(name)) return "Poliklinika / oilaviy poliklinika";
  if (tags.amenity === "clinic" || tags.healthcare === "clinic" || tags.healthcare === "centre") {
    return "Klinika / tibbiyot markazi";
  }
  if (tags.amenity === "doctors" || tags.healthcare === "doctor") return "Shifokor xonasi";
  return "Boshqa tibbiyot muassasasi";
}

export function toRows(elements) {
  const seen = new Set();
  const rows = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    if (lat == null || lon == null) continue;
    // Dorixona, veterinariya va h.k. ism bo'yicha tushib qolsa - chiqarib tashlaymiz.
    if (["pharmacy", "veterinary", "dentist"].includes(tags.amenity) && !tags.healthcare) continue;
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = tags["name:uz"] || tags.name || tags["name:ru"] || tags["name:en"] || "(nomsiz)";
    const address = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(", ");
    rows.push({
      turi: classify(tags),
      nomi: name,
      nomi_ru: tags["name:ru"] && tags["name:ru"] !== name ? tags["name:ru"] : "",
      manzil: address,
      telefon: tags.phone || tags["contact:phone"] || "",
      ish_vaqti: tags.opening_hours || "",
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      google: `https://www.google.com/maps?q=${lat},${lon}`,
      yandex: `https://yandex.uz/maps/?pt=${lon},${lat}&z=17&l=map`,
      osm: `https://www.openstreetmap.org/${key}`,
    });
  }
  const order = [
    "Tug'ruqxona / perinatal markaz",
    "Shifoxona (kasalxona)",
    "Poliklinika / oilaviy poliklinika",
    "Klinika / tibbiyot markazi",
    "Shifokor xonasi",
    "Boshqa tibbiyot muassasasi",
  ];
  rows.sort((a, b) => order.indexOf(a.turi) - order.indexOf(b.turi) || a.nomi.localeCompare(b.nomi));
  return rows;
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

export function writeOutputs(rows, scopeNote) {
  const cols = Object.keys(rows[0] || { turi: "", nomi: "" });
  const csv = "﻿" + [cols, ...rows.map((r) => cols.map((c) => r[c]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\n");
  writeFileSync(join(OUT_DIR, "natija.csv"), csv);

  const geojson = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: r,
    })),
  };
  writeFileSync(join(OUT_DIR, "natija.geojson"), JSON.stringify(geojson, null, 2));

  const counts = {};
  for (const r of rows) counts[r.turi] = (counts[r.turi] || 0) + 1;
  let md = `# Yunusobod tumani - tibbiyot muassasalari\n\nManba: OpenStreetMap (${scopeNote}), ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `## Jami: ${rows.length}\n\n`;
  for (const [t, n] of Object.entries(counts)) md += `- ${t}: **${n}**\n`;
  let current = "";
  let i = 0;
  for (const r of rows) {
    if (r.turi !== current) {
      current = r.turi;
      i = 0;
      md += `\n## ${current}\n\n| # | Nomi | Manzil | Koordinata | Xarita |\n|---|---|---|---|---|\n`;
    }
    i++;
    const nm = r.nomi_ru ? `${r.nomi} (${r.nomi_ru})` : r.nomi;
    md += `| ${i} | ${nm} | ${r.manzil || "-"} | ${r.lat}, ${r.lon} | [Google](${r.google}) · [Yandex](${r.yandex}) |\n`;
  }
  writeFileSync(join(OUT_DIR, "natija.md"), md);
  return counts;
}

async function main() {
  let data = await overpass(buildQuery(`area${AREA_FILTER}->.a;`));
  let scopeNote = "Yunusobod tumani chegarasi";
  if (!data.elements?.length) {
    console.error("! Tuman chegarasi topilmadi, taxminiy hudud (bbox) ishlatilmoqda");
    data = await overpass(buildQuery(FALLBACK_BBOX));
    scopeNote = `taxminiy hudud ${FALLBACK_BBOX}`;
  }
  const rows = toRows(data.elements);
  const counts = writeOutputs(rows, scopeNote);
  console.log(`Jami ${rows.length} ta muassasa topildi:`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
  console.log(`Fayllar: ${OUT_DIR}/natija.{csv,geojson,md}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Xato:", err.message);
    process.exit(1);
  });
}
