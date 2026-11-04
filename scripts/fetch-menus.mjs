// Fetches today's menus for Reaktori, Hertsi and Newton and writes menus.json.
// Runs in GitHub Actions (Node 20+, built-in fetch). Usage: node scripts/fetch-menus.mjs [YYYY-MM-DD]
import { writeFile } from "node:fs/promises";

const UA = { "User-Agent": "hervanta-lunch-vote (GitHub Action)" };

function helsinkiDate() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const date = process.argv[2] || helsinkiDate();
const compact = date.replaceAll("-", "");

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const dietStr = (s) => clean(s).replace(/^,|,$/g, "").replace(/\s*,\s*/g, ", ").replace(/(^, )|(, $)/g, "");

async function get(url, type = "json") {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return type === "json" ? res.json() : res.text();
}

// Hertsi (Sodexo, restaurant id 111)
async function hertsi() {
  const data = await get(`https://www.sodexo.fi/en/ruokalistat/output/daily_json/111/${date}`);
  const courses = Object.values(data.courses || {});
  return courses
    .map(c => ({
      title: clean(c.category),
      price: clean(c.price),
      items: [{ name: clean(c.title_en || c.title_fi), diets: dietStr(c.dietcodes) }],
    }))
    .filter(s => s.items[0].name && !/closed/i.test(s.items[0].name));
}

// Reaktori (Compass Group / Food & Co, cost center 0812)
async function reaktori() {
  // First choice: the schema.org menu embedded in the English restaurant page.
  try {
    const html = await get("https://www.compass-group.fi/en/ravintolat-ja-ruokalistat/food--co/kaupungit/tampere/reaktori/", "text");
    const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    for (const b of blocks) {
      let json; try { json = JSON.parse(b); } catch { continue; }
      const menu = [json].flat().find(j => j && j.hasMenu)?.hasMenu;
      const day = (menu?.hasMenuSection || []).find(d => String(d.validFrom || "").startsWith(date));
      if (day) {
        return (day.hasMenuSection || []).map(sec => ({
          title: clean(sec.name),
          price: clean(sec.offers?.price || sec.description || ""),
          items: (sec.hasMenuItem || []).map(it => ({ name: clean(it.name), diets: dietStr(it.description) })),
        })).filter(s => s.items.length);
      }
    }
  } catch (e) { console.warn("Reaktori page:", e.message); }

  // Fallback: Compass menu feed.
  const data = await get("https://www.compass-group.fi/menuapi/feed/json?costNumber=0812&language=en");
  const day = (data.MenusForDays || []).find(d => String(d.Date || "").startsWith(date));
  return (day?.SetMenus || []).map(m => ({
    title: clean(m.Name),
    price: clean(m.Price),
    items: (m.Components || []).map(c => {
      const match = String(c).match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      return match ? { name: clean(match[1]), diets: dietStr(match[2]) } : { name: clean(c), diets: "" };
    }),
  })).filter(s => s.items.length);
}

// Newton (Juvenes, Jamix customer 93077, kitchen 6)
async function newton() {
  let data;
  for (const lang of ["en", "fi"]) {
    try {
      data = await get(`https://fi.jamix.cloud/apps/menuservice/rest/haku/menu/93077/6?lang=${lang}&date=${compact}&date2=${compact}`);
      if (Array.isArray(data) && data.length) break;
    } catch (e) { console.warn(`Newton (${lang}):`, e.message); }
  }
  const sections = [];
  for (const customer of [data].flat().filter(Boolean)) {
    for (const kitchen of customer.kitchens || []) {
      for (const type of kitchen.menuTypes || []) {
        for (const menu of type.menus || []) {
          for (const day of menu.days || []) {
            if (String(day.date) !== compact) continue;
            for (const opt of day.mealoptions || []) {
              const items = (opt.menuItems || []).map(it => ({ name: clean(it.name), diets: dietStr(it.diets) })).filter(i => i.name);
              if (items.length) sections.push({ title: clean(opt.name), price: "", items });
            }
          }
        }
      }
    }
  }
  return sections;
}

const sources = { reaktori, hertsi, newton };
const out = { date, updated: new Date().toISOString(), restaurants: {}, errors: {} };
for (const [id, fn] of Object.entries(sources)) {
  try {
    out.restaurants[id] = { sections: await fn() };
    console.log(`${id}: ${out.restaurants[id].sections.length} sections`);
  } catch (e) {
    out.restaurants[id] = { sections: [] };
    out.errors[id] = e.message;
    console.error(`${id} failed:`, e.message);
  }
}
await writeFile("menus.json", JSON.stringify(out, null, 2) + "\n");
