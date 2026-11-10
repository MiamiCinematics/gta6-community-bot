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
const polls = JSON.parse(await readFile(join(DIR, "polls.json"), "utf8"));
const discussions = JSON.parse(await readFile(join(DIR, "discussions.json"), "utf8"));
const STATE_FILE = join(DIR, "state.json");
const state = existsSync(STATE_FILE)
  ? JSON.parse(await readFile(STATE_FILE, "utf8"))
  : {};
state.feeds ??= {};
state.usedMemes ??= [];
state.recentYt ??= [];
state.pending ??= [];
state.outbox ??= [];

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
  // 0 = Text, 5 = Ankuendigung, 15 = Forum
  const text = channels.filter((c) => c.type === 0 || c.type === 5 || c.type === 15);
  for (const kw of config.channels[role] ?? []) {
    const hit = text.find((c) => c.name.toLowerCase().includes(kw.toLowerCase()));
    if (hit) return hit.id;
  }
  log(`Kein Channel fuer "${role}". Vorhandene Channels:`, channels.map((c) => `${c.name} (Typ ${c.type})`).join(", "));
  return null;
}
const channelType = (channels, id) => channels.find((c) => c.id === id)?.type;

// Hoechstens ein geplanter Post pro Lauf, damit nicht alles gleichzeitig kommt
let postsLeft = 1;
const canPost = () => postsLeft > 0;
const usePost = () => { postsLeft--; };

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
// Woerter, die in fast jedem GTA-Titel stehen, zaehlen nicht
const STOP = new Set(["grand", "theft", "auto", "gta", "gta6", "the", "and", "you", "your", "for", "with", "this", "that", "now", "new", "are", "was", "has", "have"]);
function words(t = "") {
  return new Set(
    t.toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/#\w+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
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
    ["Grand Theft Auto VI: Pre-Load Now", "Grand Theft Auto VI: Pre-Load Now", true],
    ["Grand Theft Auto VI: The Festival", "Grand Theft Auto VI: Pre-Load Now", false],
    ["Grand Theft Auto VI Launch Trailer", "Grand Theft Auto VI: Trailer 2", false],
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
        // Gleicher Titel vom selben Account in den letzten 2 Tagen (z. B. Video + Short) -> nur einmal posten
        const twin = state.recentYt.find((y) => y.name === feed.name && Date.now() - y.at < 2 * 86400000 && similar(y.title, item.title));
        if (twin) { log(`Uebersprungen (gleicher Titel schon gepostet): ${feed.name} - ${item.title}`); continue; }
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

  // Neue Posts in die Warteschlange; pro Lauf geht hoechstens ein Post raus (nach und nach)
  for (const { feed, item } of posts) {
    const text = (feed.type === "own" ? config.messages.own : config.messages.rockstar)
      .replaceAll("{name}", feed.name)
      .replaceAll("{platform}", feed.platform)
      .replaceAll("{title}", item.title || "New post")
      .replaceAll("{link}", item.link);
    if (DRY) { log("[dry] wuerde posten:\n" + text); continue; }
    state.outbox.push({ type: feed.type, text, label: `${feed.name} - ${item.title}` });
  }
  if (DRY || !state.outbox.length || !canPost()) return;
  const next = state.outbox[0];
  const ch = pickChannel(channels, next.type);
  if (ch) {
    await sendMessage(ch, { content: next.text });
    usePost();
    log(`Gepostet: ${next.label}` + (state.outbox.length > 1 ? ` (noch ${state.outbox.length - 1} in der Warteschlange)` : ""));
  } else {
    log(`Kein Channel fuer "${next.type}" gefunden, Post uebersprungen.`);
  }
  state.outbox.shift();
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
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour % 24, weekday: parts.weekday };
}

const released = () => berlinNow().date >= config.releaseDate;
const fitsPhase = (x) => !x.phase || (x.phase === "post" ? released() : !released());

// Einen Eintrag waehlen, der zuletzt nicht dran war (fuer Umfragen und Diskussionen)
function pickOne(pool, usedKey) {
  state[usedKey] ??= [];
  const fits = pool.map((_, i) => i).filter((i) => fitsPhase(pool[i]));
  let free = fits.filter((i) => !state[usedKey].includes(i));
  if (!free.length) { state[usedKey] = []; free = fits; }
  const i = free[Math.floor(Math.random() * free.length)];
  state[usedKey].push(i);
  return pool[i];
}

// Taeglich/woechentlich: true, wenn heute (bzw. diese Woche) noch nicht gelaufen und die Uhrzeit erreicht ist
function due(job) {
  const { date, hour, weekday } = berlinNow();
  const s = config.schedule[job];
  state.jobs ??= {};
  if (state.jobs[job] === date || hour < s.hour) return false;
  if (s.weekday && s.weekday !== weekday) return false;
  return true;
}
const markDone = (job) => { state.jobs[job] = berlinNow().date; };

// 3 Memes waehlen, die zuletzt nicht dran waren, mit 3 verschiedenen Vorlagen
// phase "pre" = nur vor Release, "post" = nur ab Release, ohne = immer
function pickMemes(n) {
  const fits = memePool.map((_, i) => i).filter((i) => fitsPhase(memePool[i]));
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

// Memes einzeln ueber den Tag verteilt (config.memeHours, z. B. 12, 16, 20 Uhr)
async function dailyMemes(channels) {
  if (TEST_MEMES || DRY) return testMemes();
  const { date, hour } = berlinNow();
  if (state.memeDay?.date !== date) {
    if (state.memeDate === date) return; // heute schon nach altem Ablauf gepostet
    state.memeDay = { date, memes: pickMemes(config.memeHours.length), posted: 0 };
  }
  const day = state.memeDay;
  if (day.posted >= day.memes.length || hour < config.memeHours[day.posted] || !canPost()) return;
  const ch = pickChannel(channels, "memes");
  if (!ch) return;
  const m = day.memes[day.posted];
  await sendImage(ch, config.messages.memeHeader, await renderMeme(m), `gta6_meme_${date}_${day.posted + 1}.png`);
  usePost();
  day.posted++;
  log(`Meme ${day.posted}/${day.memes.length} gepostet.`);
}

async function testMemes() {
  const memes = pickMemes(config.memeHours.length);

  if (TEST_MEMES) {
    await mkdir(join(DIR, "test-output"), { recursive: true });
    for (const [i, m] of memes.entries()) {
      await writeFile(join(DIR, "test-output", `meme_${i + 1}.png`), await renderMeme(m));
      log(`test-output/meme_${i + 1}.png (${m.template}): ${m.text.join(" | ")}`);
    }
    return;
  }
  memes.forEach((m, i) => log(`[dry] Meme um ${config.memeHours[i]} Uhr:`, m.template, m.text.join(" | ")));
}

// ---------------------------------------------------------------- Umfrage, Diskussion, Clips, Meilensteine

async function dailyPoll(channels) {
  if (!DRY && (!due("poll") || !canPost())) return;
  const p = pickOne(polls, "usedPolls");
  if (DRY) { log("[dry] Umfrage:", p.q, "|", p.a.join(" / ")); return; }
  const ch = pickChannel(channels, "welcome");
  if (!ch) { log("Kein General-Channel fuer die Umfrage gefunden."); return; }
  await sendMessage(ch, {
    poll: {
      question: { text: p.q },
      answers: p.a.map((text) => ({ poll_media: { text } })),
      duration: 24,
      allow_multiselect: false,
    },
  });
  markDone("poll");
  usePost();
  log("Umfrage gepostet:", p.q);
}

// Thema des Tages: aus today.json (z. B. von der Tagesanalyse), sonst aus discussions.json
async function dailyDiscussion(channels) {
  if (!DRY && (!due("discussion") || !canPost())) return;
  let topic;
  const todayFile = join(DIR, "today.json");
  if (existsSync(todayFile)) {
    const t = JSON.parse(await readFile(todayFile, "utf8"));
    if (t.date === berlinNow().date && t.discussion?.title) topic = t.discussion;
  }
  topic ??= pickOne(discussions, "usedDiscussions");
  const text = config.messages.discussion
    .replaceAll("{title}", topic.title)
    .replaceAll("{text}", topic.text)
    + (topic.source ? `\nSource: ${topic.source}` : "");
  if (DRY) { log("[dry] Diskussion:\n" + text); return; }
  const ch = pickChannel(channels, "discussion");
  if (!ch) return;
  if (channelType(channels, ch) === 15) {
    // Forum-Channel: jedes Thema wird ein eigener Forum-Beitrag
    await discord("POST", `/channels/${ch}/threads`, {
      name: topic.title.slice(0, 100), auto_archive_duration: 1440,
      message: { content: text.replace("in the thread below", "below") },
    });
  } else {
    const msg = await sendMessage(ch, { content: text });
    try {
      await discord("POST", `/channels/${ch}/messages/${msg.id}/threads`, {
        name: topic.title.slice(0, 100), auto_archive_duration: 1440,
      });
    } catch (e) {
      log("Thread konnte nicht erstellt werden (Recht 'Create Public Threads' fehlt?):", e.status);
    }
  }
  markDone("discussion");
  usePost();
  log("Diskussion gestartet:", topic.title);
}

async function weeklyClipCall(channels) {
  if (!DRY && (!due("clipCall") || !canPost())) return;
  const text = config.messages.clipCall;
  if (DRY) { log("[dry] Clip-Aufruf:\n" + text); return; }
  const ch = pickChannel(channels, "clips");
  if (!ch) { log("Kein Clips-Channel gefunden."); return; }
  await sendMessage(ch, { content: text });
  markDone("clipCall");
  usePost();
  log("Clip-Aufruf gepostet.");
}

async function milestones(guildId, channels) {
  const g = await discord("GET", `/guilds/${guildId}?with_counts=true`);
  const count = g.approximate_member_count ?? 0;
  const reached = config.milestones.filter((m) => count >= m).pop() ?? 0;
  if (state.lastMilestone === undefined) { state.lastMilestone = reached; return; } // erster Lauf: nur merken
  if (reached <= state.lastMilestone || !canPost()) return;
  const ch = pickChannel(channels, "welcome");
  if (!ch) return;
  await sendMessage(ch, { content: config.messages.milestone.replaceAll("{count}", reached.toLocaleString("en-US")) });
  state.lastMilestone = reached;
  usePost();
  log("Meilenstein gepostet:", reached);
}

// ---------------------------------------------------------------- Ablauf

async function main() {
  if (TEST_MEMES) { await dailyMemes([]); return; }
  if (DRY) {
    await checkFeeds([]);
    await dailyMemes([]);
    await dailyPoll([]);
    await dailyDiscussion([]);
    await weeklyClipCall([]);
    return; // im Testmodus wird state.json nicht gespeichert
  }
  if (!TOKEN) throw new Error("DISCORD_TOKEN fehlt (GitHub: Settings > Secrets > Actions).");

  const guildId = await findGuild();
  const channels = await discord("GET", `/guilds/${guildId}/channels`);

  const steps = [
    ["Feeds", () => checkFeeds(channels)],
    ["Begruessung", () => welcomeMembers(guildId, channels)],
    ["Memes", () => dailyMemes(channels)],
    ["Umfrage", () => dailyPoll(channels)],
    ["Diskussion", () => dailyDiscussion(channels)],
    ["Clip-Aufruf", () => weeklyClipCall(channels)],
    ["Meilensteine", () => milestones(guildId, channels)],
  ];
  let failed = false;
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { failed = true; log(`Fehler bei ${name}:`, e.message); }
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  if (failed) process.exitCode = 1;
}

main().catch((e) => { log("Abbruch:", e.message); process.exit(1); });
