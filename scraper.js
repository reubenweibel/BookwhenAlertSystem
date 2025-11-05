import axios from "axios";
import * as cheerio from "cheerio";
import { promises as fs } from "fs";
import nodemailer from "nodemailer";

const URL = "https://bookwhen.com/kclmt";
const SNAPSHOT_FILE = "./snapshot.json";

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER, // your Gmail
        pass: process.env.EMAIL_PASS, // app password (not normal password)
    },
});

async function fetchPage() {
    const result = await axios.get(URL, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
        },
        timeout: 15000,
    });
    return result.data;
}

function parseEvents(html) {
    const $ = cheerio.load(html);
    const out = [];
    $("tr[data-hook='agenda_list_item']").each((_, el) => {
        const $el = $(el);

        const idAttr = $el.attr("data-event") || "";
        const day = $el.find(".dom").first().text().trim(); // "5"
        const dow = $el.find(".dow").first().text().trim(); // "Wed"
        const time = $el.find(".time_span").first().text().trim(); // "5pm GMT"
        const title = $el.find(".summary button").first().text().trim();

        const basketIcon = $el.find(".edit_icon .basket").length > 0;
        const soldOutIcon = $el.find(".edit_icon .sold_out").length > 0;
        let status = "Unknown";
        if (basketIcon) status = "Available";
        else if (soldOutIcon) status = "Full";

        const id = idAttr || `${title}||${dow}||${day}||${time}`;
        out.push({ id, title, dow, day, time, status });
    });
    return out;
}

async function loadSnapshot() {
    try {
        const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

async function saveSnapshot(arr) {
    await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(arr, null, 2));
}


function diffEvents(oldArr, newArr) {
    const oldById = new Map(oldArr.map((o) => [o.id, o]));
    const added = newArr.filter((n) => !oldById.has(n.id));

    const reopened = newArr.filter((n) => {
        const old = oldById.get(n.id);
        if (!old) return false;
        const wasFull = /full|sold out|waitlist|no spaces/i.test(old.status);
        const isAvailable = /available|book|spaces|join/i.test(n.status);
        return wasFull && isAvailable;
    });

    return { added, reopened };
}

async function notifyEmail(changes) {
    let text = "";

    if (changes.added.length) {
        text += "Added classes:\n";
        changes.added.forEach(c => text += `${c.title} — ${c.time}\n`);
    }
    if (changes.reopened.length) {
        text += "\nReopened classes:\n";
        changes.reopened.forEach(c => text += `${c.title} — ${c.time}\n`);
    }

    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER, // send to yourself
        subject: "Bookwhen Class Update",
        text
    });
}

async function main() {
    try {
        const html = await fetchPage();
        const parsed = parseEvents(html);
        const old = await loadSnapshot();
        const changes = diffEvents(old, parsed);

        if (changes.added.length || changes.reopened.length) {
            console.log("CHANGES DETECTED:");
            if (changes.added.length) {
                console.log(
                    "Added:",
                    changes.added.map((a) => `${a.title} — ${a.time}`)
                );
            }
            if (changes.reopened.length) {
                console.log(
                    "Reopened:",
                    changes.reopened.map((r) => `${r.title} — ${r.time}`)
                );
            }
            await notifyEmail(changes);
        } else {
            console.log("No changes detected.");
        }

        // Always save snapshot so next run has updated baseline
        await saveSnapshot(parsed);
        process.exit(0);
    } catch (err) {
        console.error("Fatal error:", err && err.message ? err.message : err);
        process.exit(1);
    }
}

main();
