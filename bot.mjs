// GTA 6 Community Discord-Bot
// Laeuft bei jedem Aufruf einmal durch (GitHub Actions startet ihn alle 15 Minuten):
//   1. Neue Posts von Rockstar Games und Miami Cinematics posten (RSS/Atom-Feeds)
//   2. Neue Mitglieder im General-Chat begruessen
//   3. Einmal pro Tag 3 Memes in den Memes-Channel posten
//
// Aufruf:
//   node bot.mjs              normaler Lauf (braucht DISCORD_TOKEN)
//   node bot.mjs --dry        nur anzeigen, was gepostet wuerde (Feeds + Memes, kein Discord)
//   node bot.mjs --test-memes 3 Memes erzeugen und in test-output/ speichern

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_TOKEN;
const DRY = process.argv.includes("--dry");
const TEST_MEMES = process.argv.includes("--test-memes");

const config = JSON.parse(await readFile(join(DIR, "config.json"), "utf8"));
const memePool = JSON.parse(await readFile(join(DIR, "memes.json"), "utf8"));
const STATE_FILE = join(DIR, "state.json");
const state = existsSync(STATE_FILE)
  ? JSON.parse(await readFile(STATE_FILE, "utf8"))
  : {};
state.feeds ??= {};
state.usedMemes ??= [];
state.recentYt ??= [];
state.pending ??= [];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Discord REST

async function discord(method, path, body, isForm = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "User-Agent": "DiscordBot (https://github.com, 1.0)",
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(((j.retry_after ?? 1) + 0.5) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Discord ${method} ${path}: zu viele Rate-Limits`);
}

const sendMessage = (channelId, payload) =>
  discord("POST", `/channels/${channelId}/messages`, {
    allowed_mentions: { parse: ["users"] },
    ...payload,
  });

async function sendImage(channelId, content, buffer, filename) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content, attachments: [{ id: 0, filename }] })
  );
  form.append("files[0]", new Blob([buffer], { type: "image/png" }), filename);
  return discord("POST", `/channels/${channelId}/messages`, form, true);
}

async function findGuild() {
  if (config.guildId) return config.guildId;
  const guilds = await discord("GET", "/users/@me/guilds");
  if (!guilds.length) throw new Error("Der Bot ist auf keinem Server. Erst einladen (siehe LIESMICH.md).");
  if (guilds.length > 1) log("Bot ist auf mehreren Servern, nehme den ersten:", guilds[0].name);
  return guilds[0].id;
}

// Channel per ID (config.channelIds) oder per Namens-Stichwort (config.channels) finden
function pickChannel(channels, role) {
  const id = config.channelIds?.[role];
  if (id) return id;
  const text = channels.filter((c) => c.type === 0 || c.type === 5);
  for (const kw of config.channels[role] ?? []) {
    const hit = text.find((c) => c.name.toLowerCase().includes(kw.toLowerCase()));
    if (hit) return hit.id;
  }
  return null;
}

// ---------------------------------------------------------------- Feeds

function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

// Liest RSS (<item>) und Atom (<entry>), neueste zuerst
function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(entry|item)[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0]);
  return blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"/);
    const link = atomLink ? decode(atomLink[1]) : tag(b, "link");
    const id = tag(b, "yt:videoId") || tag(b, "id") || tag(b, "guid") || link;
    return { id, link, title: tag(b, "title") || tag(b, "media:title") };
  }).filter((e) => e.id && e.link);
}

const isYouTube = (feed) => /youtube/i.test(feed.platform);

// Titel vergleichen ohne Hashtags, Links, Emojis und Gross/Klein; aehnlich = mind. halbe Wortueberschneidung
function words(t = "") {
  return new Set(
    t.toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/#\w+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common >= 2 && common / Math.min(A.size, B.size) >= 0.5;
}

if (process.argv.includes("--selftest")) {
  const cases = [
    ["24 Years After Vice City, We're Going Back #gta6 #shorts", "24 years after Vice City, we're going back 🌴 #gta #fyp", true],
    ["GTA 6 Preload Is Live🔥Is Your Console Ready?  #gta6 #gta #shorts", "Preload is live! Is your console ready? #gta6", true],
    ["Grand Theft Auto VI Launch Trailer", "Pre-orders for the Collector's Edition are now open", false],
    ["A Night in Vice City", "GTA 6 is coming #gta", false],
  ];
  for (const [a, b, want] of cases) console.log(similar(a, b) === want ? "OK  " : "FAIL", a, "|", b);
  process.exit(0);
}

async function checkFeeds(channels) {
  const posts = [];
  for (const feed of config.feeds) {
    let items;
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0 GTA6CommunityBot" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parseFeed(await res.text());
    } catch (e) {
      log(`Feed "${feed.name} (${feed.platform})" nicht erreichbar:`, e.message);
      continue;
    }
    const seen = state.feeds[feed.url];
    if (!seen && DRY && items[0]) {
      posts.push({ feed, item: items[0] }); // Testmodus: neuesten Eintrag als Beispiel zeigen
      continue;
    }
    if (!seen) {
      // Erster Lauf: alles Vorhandene als gesehen merken, nichts posten (kein Spam)
      state.feeds[feed.url] = items.slice(0, 50).map((i) => i.id);
      log(`Feed "${feed.name} (${feed.platform})" eingerichtet, ${items.length} alte Eintraege uebersprungen.`);
      continue;
    }
    const fresh = items.filter((i) => !seen.includes(i.id)).slice(0, 3).reverse();
    for (const item of fresh) {
      if (isYouTube(feed)) {
        posts.push({ feed, item });
        state.recentYt.push({ name: feed.name, title: item.title, at: Date.now() });
      } else {
        // X/Instagram/TikTok erst merken: kommt dasselbe noch auf YouTube, wird nur YouTube gepostet
        state.pending.push({ feed, item, firstSeen: Date.now() });
      }
    }
    state.feeds[feed.url] = [...fresh.map((i) => i.id), ...seen].slice(0, 50);
  }

  // Doppelte vermeiden: YouTube hat Vorrang vor X, Instagram und TikTok
  const week = 7 * 24 * 3600 * 1000;
  state.recentYt = state.recentYt.filter((y) => Date.now() - y.at < week);
  const hold = (config.holdMinutes ?? 60) * 60 * 1000;
  const keep = [];
  for (const p of state.pending) {
    const dup = state.recentYt.find((y) => y.name === p.feed.name && similar(y.title, p.item.title));
    if (dup) { log(`Uebersprungen (gibt es auf YouTube): ${p.feed.name} ${p.feed.platform} - ${p.item.title}`); continue; }
    if (DRY || Date.now() - p.firstSeen >= hold) posts.push(p);
    else keep.push(p);
  }
  state.pending = keep;

  for (const { feed, item } of posts) {
    const text = (feed.type === "own" ? config.messages.own : config.messages.rockstar)
      .replaceAll("{name}", feed.name)
      .replaceAll("{platform}", feed.platform)
      .replaceAll("{title}", item.title || "New post")
      .replaceAll("{link}", item.link);
    if (DRY) { log("[dry] wuerde posten:\n" + text); continue; }
    const ch = pickChannel(channels, feed.type);
    if (!ch) { log(`Kein Channel fuer "${feed.type}" gefunden, Post uebersprungen.`); continue; }
    await sendMessage(ch, { content: text });
    log(`Gepostet: ${feed.name} - ${item.title}`);
  }
}

// ---------------------------------------------------------------- Begruessung

async function welcomeMembers(guildId, channels) {
  const since = state.lastMemberCheck;
  const now = new Date().toISOString();
  if (!since) { state.lastMemberCheck = now; log("Begruessung eingerichtet."); return; }

  const members = [];
  let after = "0";
  try {
    for (;;) {
      const page = await discord("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }
  } catch (e) {
    if (e.status === 403) {
      log("Mitgliederliste verboten: Im Developer Portal unter Bot den 'Server Members Intent' einschalten.");
      return;
    }
    throw e;
  }

  const fresh = members
    .filter((m) => !m.user.bot && m.joined_at > since)
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  state.lastMemberCheck = now;
  if (!fresh.length) return;

  const ch = pickChannel(channels, "welcome");
  if (!ch) { log("Kein General-Channel gefunden, Begruessung uebersprungen."); return; }
  const variants = config.messages.welcome;
  if (fresh.length > 5) {
    const list = fresh.map((m) => `<@${m.user.id}>`).join(", ");
    await sendMessage(ch, { content: config.messages.welcomeMany.replaceAll("{users}", list) });
  } else {
    for (const m of fresh) {
      const t = variants[Math.floor(Math.random() * variants.length)];
      await sendMessage(ch, { content: t.replaceAll("{user}", `<@${m.user.id}>`) });
    }
  }
  log(`${fresh.length} neue(s) Mitglied(er) begruesst.`);
}

// ---------------------------------------------------------------- Memes

function berlinNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour % 24 };
}

// 3 Memes waehlen, die zuletzt nicht dran waren, mit 3 verschiedenen Vorlagen
// phase "pre" = nur vor Release, "post" = nur ab Release, ohne = immer
function pickMemes(n) {
  const released = berlinNow().date >= config.releaseDate;
  const fits = memePool.map((_, i) => i).filter((i) => {
    const p = memePool[i].phase;
    return !p || (p === "post" ? released : !released);
  });
  let free = fits.filter((i) => !state.usedMemes.includes(i));
  if (free.length < n * 2) { state.usedMemes = []; free = fits; }
  free.sort(() => Math.random() - 0.5);
  const chosen = [];
  for (const i of free) {
    if (chosen.length === n) break;
    if (chosen.some((c) => memePool[c].template === memePool[i].template)) continue;
    chosen.push(i);
  }
  state.usedMemes.push(...chosen);
  return chosen.map((i) => memePool[i]);
}

async function renderMeme(meme) {
  const res = await fetch("https://api.memegen.link/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: meme.template, text: meme.text, extension: "png" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`memegen ${res.status}: ${await res.text()}`);
  const { url } = await res.json();
  const img = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!img.ok) throw new Error(`memegen Bild ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

async function dailyMemes(channels) {
  const { date, hour } = berlinNow();
  const due = TEST_MEMES || (state.memeDate !== date && hour >= config.memeHour);
  if (!due) return;
  const memes = pickMemes(config.memesPerDay);

  if (TEST_MEMES) {
    await mkdir(join(DIR, "test-output"), { recursive: true });
    for (const [i, m] of memes.entries()) {
      await writeFile(join(DIR, "test-output", `meme_${i + 1}.png`), await renderMeme(m));
      log(`test-output/meme_${i + 1}.png (${m.template}): ${m.text.join(" | ")}`);
    }
    return;
  }
  if (DRY) { memes.forEach((m) => log("[dry] Meme:", m.template, m.text.join(" | "))); return; }

  const ch = pickChannel(channels, "memes");
  if (!ch) { log("Kein Memes-Channel gefunden."); return; }
  for (const [i, m] of memes.entries()) {
    const buf = await renderMeme(m);
    await sendImage(ch, i === 0 ? config.messages.memeHeader : "", buf, `gta6_meme_${date}_${i + 1}.png`);
    await sleep(1500);
  }
  state.memeDate = date;
  log(`${memes.length} Memes gepostet.`);
}

// ---------------------------------------------------------------- Ablauf

async function main() {
  if (TEST_MEMES) { await dailyMemes([]); return; }
  if (DRY) {
    await checkFeeds([]);
    await dailyMemes([]);
    return; // im Testmodus wird state.json nicht gespeichert
  }
  if (!TOKEN) throw new Error("DISCORD_TOKEN fehlt (GitHub: Settings > Secrets > Actions).");

  const guildId = await findGuild();
  const channels = await discord("GET", `/guilds/${guildId}/channels`);

  const steps = [
    ["Feeds", () => checkFeeds(channels)],
    ["Begruessung", () => welcomeMembers(guildId, channels)],
    ["Memes", () => dailyMemes(channels)],
  ];
  let failed = false;
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { failed = true; log(`Fehler bei ${name}:`, e.message); }
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  if (failed) process.exitCode = 1;
}

main().catch((e) => { log("Abbruch:", e.message); process.exit(1); });
