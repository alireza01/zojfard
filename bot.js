// main.js
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { DateTime } from "https://esm.sh/luxon@3.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import { default as autoTable } from 'https://esm.sh/jspdf-autotable@3.8.2';

// --- Configuration ---
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "YOUR_BOT_TOKEN"; // REQUIRED
const ADMIN_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID") || "YOUR_ADMIN_CHAT_ID"; // REQUIRED
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "YOUR_SUPABASE_URL"; // REQUIRED
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY") || "YOUR_SUPABASE_KEY"; // REQUIRED (Service Role Key)
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TEHRAN_TIMEZONE = "Asia/Tehran";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Reference Point for Week Calculation ---
const REFERENCE_PERSIAN_YEAR = 1403;
const REFERENCE_PERSIAN_MONTH = 11; // بهمن
const REFERENCE_PERSIAN_DAY = 20;
const REFERENCE_STATUS = "فرد"; // "فرد" (odd) or "زوج" (even)

// --- Constants ---
const PERSIAN_WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه"]; // Relevant weekdays
const PERSIAN_WEEKDAYS_FULL = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنج‌شنبه", "جمعه"];
const ENGLISH_WEEKDAYS = ["saturday", "sunday", "monday", "tuesday", "wednesday"];
const SCHEDULE_TIME_REGEX = /^(?:[01]\d|2[0-3]|[89]):[0-5]\d$/; // HH:MM or H:MM
const LUNCH_START_MINUTES = 12 * 60;
const LUNCH_END_MINUTES = 13 * 60;

// --- Supabase Setup ---
if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.error("CRITICAL ERROR: Required environment variables (BOT_TOKEN, ADMIN_CHAT_ID, SUPABASE_URL, SUPABASE_KEY) are missing.");
    throw new Error("Essential configuration is incomplete.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    }
});

// --- Deno KV Setup ---
const kv = await Deno.openKv();

// --- Pre-calculate Gregorian Reference Date ---
let REFERENCE_DATE_GREGORIAN;
try {
    const refGregorianArray = jalaliToGregorian(REFERENCE_PERSIAN_YEAR, REFERENCE_PERSIAN_MONTH, REFERENCE_PERSIAN_DAY);
    if (!refGregorianArray || refGregorianArray.length !== 3) throw new Error("jalaliToGregorian returned invalid data.");
    REFERENCE_DATE_GREGORIAN = new Date(Date.UTC(refGregorianArray[0], refGregorianArray[1] - 1, refGregorianArray[2]));
    REFERENCE_DATE_GREGORIAN.setUTCHours(0, 0, 0, 0);
    if (isNaN(REFERENCE_DATE_GREGORIAN.getTime())) throw new Error("Calculated Gregorian reference date is invalid.");
    console.log(`Reference Gregorian Date (UTC): ${REFERENCE_DATE_GREGORIAN.toISOString()} for Persian ${REFERENCE_PERSIAN_YEAR}/${REFERENCE_PERSIAN_MONTH}/${REFERENCE_PERSIAN_DAY} (${REFERENCE_STATUS})`);
} catch (e) {
    console.error(`CRITICAL ERROR: Failed to calculate reference Gregorian date: ${e.stack}`);
    // Attempt to notify admin, but don't let it block startup
    sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL INIT ERROR: Failed to calculate reference Gregorian date: ${e.message}`).catch(err => console.error("Failed to send admin notification on startup date error:", err));
    throw new Error(`Failed to initialize reference date. Bot cannot function. Error: ${e.message}`);
}

// --- Font Cache ---
let vazirFontArrayBuffer = null;

// --- Utility Functions ---

function isValidPersianDate(year, month, day) {
    try {
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
        if (year < 1300 || year > 1500 || month < 1 || month > 12 || day < 1) return false;
        if (month <= 6 && day > 31) return false;
        if (month >= 7 && month <= 11 && day > 30) return false;
        if (month == 12) {
            const rem = year % 33;
            const isLeapYear = [1, 5, 9, 13, 17, 22, 26, 30].includes(rem);
            if (day > (isLeapYear ? 30 : 29)) return false;
        }
        return true;
    } catch (e) {
        console.error(`Error in isValidPersianDate: ${e}`);
        return false;
    }
}

function parsePersianDate(dateStr) {
    try {
        if (!dateStr) return null;
        dateStr = String(dateStr).trim();
        const persianArabicDigits = /[۰-۹٠-٩]/g;
        const digitMap = {
            '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9,
            '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9
        };
        dateStr = dateStr.replace(persianArabicDigits, d => digitMap[d]);
        dateStr = dateStr.replace(/[^\d\/\-\.]/g, ''); // Keep only digits and separators

        let parts = [];
        if (dateStr.includes('/')) parts = dateStr.split('/');
        else if (dateStr.includes('-')) parts = dateStr.split('-');
        else if (dateStr.includes('.')) parts = dateStr.split('.');
        else if (dateStr.length === 8 && /^\d{8}$/.test(dateStr)) {
            parts = [dateStr.substring(0, 4), dateStr.substring(4, 6), dateStr.substring(6, 8)];
        }
        else if (dateStr.length === 6 && /^\d{6}$/.test(dateStr)) {
            parts = ["14" + dateStr.substring(0, 2), dateStr.substring(2, 4), dateStr.substring(4, 6)];
        }
        else return null;

        if (parts.length !== 3) return null;

        let p1 = parseInt(parts[0], 10);
        let p2 = parseInt(parts[1], 10);
        let p3 = parseInt(parts[2], 10);
        if (isNaN(p1) || isNaN(p2) || isNaN(p3)) return null;

        let year, month, day;
        // YYYY/MM/DD
        if (p1 >= 1300 && p1 <= 1500 && p2 >= 1 && p2 <= 12 && p3 >= 1 && p3 <= 31) {
            year = p1; month = p2; day = p3;
        }
        // DD/MM/YYYY
        else if (p3 >= 1300 && p3 <= 1500 && p2 >= 1 && p2 <= 12 && p1 >= 1 && p1 <= 31) {
            year = p3; month = p2; day = p1;
        }
        // YYYY/DD/MM
        else if (p1 >= 1300 && p1 <= 1500 && p3 >= 1 && p3 <= 12 && p2 >= 1 && p2 <= 31) {
            year = p1; month = p3; day = p2;
        }
        // YY/MM/DD (Assume 14YY)
        else if (p1 >= 0 && p1 <= 99 && p2 >= 1 && p2 <= 12 && p3 >= 1 && p3 <= 31) {
            year = 1400 + p1; month = p2; day = p3;
        }
        else return null;

        if (!isValidPersianDate(year, month, day)) return null;
        return { year, month, day };
    } catch (e) {
        console.error(`Date parse exception: ${e}`);
        return null;
    }
}

function getPersianMonthName(monthNumber) {
    const persianMonths = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
    monthNumber = parseInt(monthNumber);
    return (monthNumber >= 1 && monthNumber <= 12) ? persianMonths[monthNumber - 1] : "نامعتبر";
}

function jalaliToGregorian(jy, jm, jd) {
  try {
    jy = parseInt(jy);
    jm = parseInt(jm);
    jd = parseInt(jd);
    if (isNaN(jy) || isNaN(jm) || isNaN(jd)) {
      throw new Error("Invalid input to jalaliToGregorian");
    }
    let gy = jy <= 979 ? 621 : 1600;
    jy -= jy <= 979 ? 0 : 979;
    let days =
      365 * jy +
      Math.floor(jy / 33) * 8 +
      Math.floor(((jy % 33) + 3) / 4) +
      78 +
      jd +
      (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    gy += 400 * Math.floor(days / 146097);
    days %= 146097;
    if (days > 36524) {
      gy += 100 * Math.floor(--days / 36524);
      days %= 36524;
      if (days >= 365) days++;
    }
    gy += 4 * Math.floor(days / 1461);
    days %= 1461;
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
    let gd = days + 1;
    const sal_a = [
      0,
      31,
      (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    let gm;
    for (gm = 0; gm < 13 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
    return [gy, gm, gd];
  } catch (e) {
    console.error(`Error in jalaliToGregorian(${jy},${jm},${jd}): ${e}`);
    return null;
  }
}
// Function to get start of Persian week (Saturday) UTC
function getStartOfWeekPersian(date) {
    const targetDate = new Date(date.getTime());
    const dayOfWeekUTC = targetDate.getUTCDay(); // Sunday = 0, Saturday = 6
    const daysToSubtract = (dayOfWeekUTC + 1) % 7;
    targetDate.setUTCDate(targetDate.getUTCDate() - daysToSubtract);
    targetDate.setUTCHours(0, 0, 0, 0);
    return targetDate;
}

function getPersianDate() {
    try {
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        // Ensure correct locale for numbers and day/month names
        const weekday = now.setLocale("fa-IR").toLocaleString({ weekday: "long" });
        const day = now.setLocale("fa-IR-u-nu-latn").toLocaleString({ day: "numeric" }); // Use Latin numerals for day
        const month = now.setLocale("fa-IR").toLocaleString({ month: "long" });
        const year = now.setLocale("fa-IR-u-nu-latn").toLocaleString({ year: "numeric" }); // Use Latin numerals for year
        if (!weekday || !day || !month || !year) {
            throw new Error("One or more Persian date components could not be retrieved.");
        }
        return `📅 امروز ${weekday} ${day} ${month} سال ${year} است`;
    } catch (e) {
        console.error(`[Util] Error generating Persian date: ${e.stack}`);
        const fallbackDate = DateTime.now().setZone(TEHRAN_TIMEZONE).toLocaleString(DateTime.DATE_FULL, { locale: "en-US" });
        return `📅 Date (Gregorian): ${fallbackDate} (Error displaying Persian date)`;
    }
}

function getWeekStatus() {
    try {
        if (!REFERENCE_DATE_GREGORIAN || isNaN(REFERENCE_DATE_GREGORIAN.getTime())) {
            console.error("CRITICAL ERROR: REFERENCE_DATE_GREGORIAN is not valid in getWeekStatus.");
            return "نامشخص (خطای تنظیمات)";
        }

        // Get current time in Tehran timezone
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        console.log(`[WeekStatus] Current Tehran time: ${now.toISO()}`);
        
        // Create a Date object representing midnight UTC on the day it currently is in Tehran
        const todayTehranAsUTC = new Date(Date.UTC(
            now.year,
            now.month - 1, // DateTime months are 1-based, Date months are 0-based
            now.day
        ));
        todayTehranAsUTC.setUTCHours(0, 0, 0, 0);
        console.log(`[WeekStatus] Today Tehran as UTC: ${todayTehranAsUTC.toISOString()}`);

        // Find the Saturday start date (UTC) of the week containing this Tehran day
        const currentWeekStartDate = getStartOfWeekPersian(todayTehranAsUTC);
        // Find the Saturday start date (UTC) of the reference week
        const referenceWeekStartDate = getStartOfWeekPersian(REFERENCE_DATE_GREGORIAN);

        console.log(`[WeekStatus] Current week start (UTC): ${currentWeekStartDate.toISOString()}`);
        console.log(`[WeekStatus] Reference week start (UTC): ${referenceWeekStartDate.toISOString()}`);

        if (isNaN(currentWeekStartDate.getTime()) || isNaN(referenceWeekStartDate.getTime())) {
            console.error(`Error: Invalid date calculation. CurrentStart: ${currentWeekStartDate}, ReferenceStart: ${referenceWeekStartDate}`);
            return "نامشخص (خطای محاسبه تاریخ)";
        }

        // Calculate weeks passed since reference start week
        const timeDifference = currentWeekStartDate.getTime() - referenceWeekStartDate.getTime();
        const daysDifference = Math.floor(timeDifference / MS_PER_DAY);
        const weeksPassed = Math.floor(daysDifference / 7);

        // Determine current status based on weeksPassed and REFERENCE_STATUS
        const currentStatus = weeksPassed % 2 === 0 
            ? REFERENCE_STATUS 
            : REFERENCE_STATUS === "زوج" ? "فرد" : "زوج";

        // Log for debugging
        console.log(`[WeekStatus] Reference: ${REFERENCE_STATUS}, WeeksPassed: ${weeksPassed}, Result: ${currentStatus}`);
        
        return currentStatus;
    } catch (e) {
        console.error(`[WeekStatus] Error in getWeekStatus: ${e.stack}`);
        return "نامشخص (خطا)";
    }
}

async function getVazirFont() {
    if (vazirFontArrayBuffer) return vazirFontArrayBuffer;
    try {
        console.log("[PDF] Fetching Vazir font...");
        // Using jsDelivr CDN for reliable access
        const fontUrl = "https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/ttf/Vazirmatn-Regular.ttf";
        const fontResponse = await fetch(fontUrl, {
            headers: {
                'Accept': 'application/octet-stream'
            }
        });
        if (!fontResponse.ok) {
            throw new Error(`Failed to fetch Vazir font TTF (${fontResponse.status}): ${await fontResponse.text()}`);
        }
        // Ensure we get the raw binary data
        vazirFontArrayBuffer = await fontResponse.arrayBuffer();
        if (!vazirFontArrayBuffer || vazirFontArrayBuffer.byteLength === 0) {
            throw new Error("Received empty font data");
        }
        console.log(`[PDF] Vazir font fetched successfully (${vazirFontArrayBuffer.byteLength} bytes)`);
        return vazirFontArrayBuffer;
    } catch (e) {
        console.error(`[PDF] Error fetching Vazir font: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `⚠️ Critical Error: Failed to fetch Vazir font for PDF generation. PDFs might fail. Error: ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        return null; // Indicate failure
    }
}

function parseTime(timeStr) {
    if (!timeStr || !SCHEDULE_TIME_REGEX.test(timeStr)) {
        console.warn(`[Util] Invalid time format for parsing: ${timeStr}`);
        return null;
    }
    try {
        const parts = timeStr.split(":");
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            console.warn(`[Util] Invalid time values after parsing: ${timeStr}`);
            return null;
        }
        return hours * 60 + minutes;
    } catch (e) {
        console.error(`[Util] Error parsing time string ${timeStr}:`, e);
        return null;
    }
}

function formatDuration(totalMinutes) {
    if (totalMinutes <= 0) return "-";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    let result = [];
    if (hours > 0) result.push(`${hours} ساعت`);
    if (minutes > 0) result.push(`${minutes} دقیقه`);
    return result.join(" و ") || "-"; // Handle case where duration might be exactly 0 after calculations
}

function calculateIdleTime(prevLesson, currLesson) {
    try {
        const prevEnd = parseTime(prevLesson?.end_time);
        const currStart = parseTime(currLesson?.start_time);

        // Basic checks
        if (prevEnd === null || currStart === null || prevEnd >= currStart) return "-";

        let idleMinutes = 0;

        // Calculate idle time considering lunch break
        if (prevEnd < LUNCH_END_MINUTES && currStart > LUNCH_START_MINUTES) {
            // Interval spans the lunch break
            const idleBeforeLunch = Math.max(0, LUNCH_START_MINUTES - prevEnd);
            const idleAfterLunch = Math.max(0, currStart - LUNCH_END_MINUTES);
            idleMinutes = idleBeforeLunch + idleAfterLunch;
        } else {
            // Interval is entirely before or entirely after lunch
            idleMinutes = currStart - prevEnd;
        }

        return idleMinutes > 0 ? formatDuration(idleMinutes) : "-";
    } catch (e) {
        console.error("[Util] Error calculating idle time:", e);
        return "خطا";
    }
}

// --- Telegram API Functions ---
async function telegramApiCall(method, payload = {}) {
    const url = `${TELEGRAM_URL}/${method}`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const responseData = await response.json();
        if (!responseData.ok) {
            console.error(`[TelegramAPI:${method}] Error: ${responseData.error_code} - ${responseData.description}. Payload: ${JSON.stringify(payload)}`);
        }
        return responseData;
    } catch (error) {
        console.error(`[TelegramAPI:${method}] Network/Fetch Error: ${error.message}`);
        return { ok: false, description: `Network/Fetch Error: ${error.message}` };
    }
}

async function sendMessage(chatId, text, replyMarkup = null, replyToMessageId = null) {
    const payload = {
        chat_id: String(chatId),
        text: text,
        parse_mode: "Markdown",
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    return await telegramApiCall("sendMessage", payload);
}

async function editMessageText(chatId, messageId, text, replyMarkup = null) {
    const payload = {
        chat_id: String(chatId),
        message_id: messageId,
        text: text,
        parse_mode: "Markdown",
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const response = await telegramApiCall("editMessageText", payload);
    if (!response.ok && !response.description?.includes("message is not modified")) {
       // Error already logged in telegramApiCall
    }
    return response;
}

async function answerCallbackQuery(queryId, text = "", showAlert = false) {
    const payload = {
        callback_query_id: queryId,
        text: text ? text.substring(0, 200) : undefined,
        show_alert: showAlert,
    };
    const response = await telegramApiCall("answerCallbackQuery", payload);
    if (!response.ok && !response.description?.includes("query is too old") && !response.description?.includes("QUERY_ID_INVALID")) {
       // Error logged in telegramApiCall
    }
    return response;
}

async function sendDocument(chatId, documentBuffer, filename, caption = null, replyMarkup = null) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([documentBuffer], { type: "application/pdf" }), filename);
  if (caption) form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));

  try {
    const response = await fetch(`${TELEGRAM_URL}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const responseData = await response.json();
    if (!responseData.ok) {
      console.error(`[sendDocument] Error to ${chatId}: ${responseData.description}`);
    }
    return responseData;
  } catch (e) {
    console.error(`[sendDocument] Network/Fetch error to ${chatId}: ${e.stack}`);
    return { ok: false, description: `Network/Fetch Error: ${e.message}` };
  }
}

async function forwardMessage(toChatId, fromChatId, messageId) {
    const payload = {
        chat_id: String(toChatId),
        from_chat_id: String(fromChatId),
        message_id: messageId,
        disable_notification: true, // Often preferred for broadcasts
    };
    // Use telegramApiCall for consistency and error logging
    return await telegramApiCall("forwardMessage", payload);
}

async function getBotInfo(forceUpdate = false) {
    let botInfo = (await kv.get(["botInfo"])).value;
    if (!botInfo || forceUpdate) {
        console.log("[Startup/Info] Fetching bot info from Telegram API...");
        const responseData = await telegramApiCall("getMe");
        if (responseData.ok && responseData.result) {
            botInfo = {
                id: responseData.result.id.toString(),
                username: responseData.result.username || "UnknownBot",
                first_name: responseData.result.first_name,
            };
            await kv.set(["botInfo"], botInfo);
            console.log(`[Startup/Info] Bot info fetched and saved: ID=${botInfo.id}, Username=${botInfo.username}`);
        } else {
            console.error("[Startup/Info] Error fetching bot info:", responseData);
            // Attempt to load previous info if available, otherwise use fallback
            botInfo = (await kv.get(["botInfo"])).value || { id: null, username: "this_bot", first_name:"Bot" };
            if(!botInfo.id) await sendMessage(ADMIN_CHAT_ID, `[Startup] Error fetching bot ID: ${responseData.description}`).catch(ne=>console.error("Failed admin notify", ne));
        }
    }
    return botInfo;
}

// --- Supabase Interaction Functions ---

async function logUsage(user, chat, command) {
    if (!user || !chat) {
        console.warn("[Log] Skipping usage log due to missing user or chat info.");
        return;
    }
    try {
        const payload = {
            user_id: user.id,
            first_name: user.first_name?.substring(0, 255), // Add length limits
            last_name: user.last_name?.substring(0, 255),
            username: user.username?.substring(0, 255),
            command: command?.substring(0, 255) || "unknown_action",
            chat_type: chat.type?.substring(0, 50),
            chat_id: chat.id,
            chat_title: (chat.title || "").substring(0, 255),
            // timestamp is handled by DB default
        };
        // Fire and forget
        supabase.from("bot_usage").insert(payload).then(({ error }) => {
            if (error) console.error(`[Log] Supabase usage log error for user ${user.id}: ${error.message} - Payload: ${JSON.stringify(payload)}`);
        });
    } catch (e) {
        console.error(`[Log] Exception preparing usage log: ${e.stack}`);
    }
}

async function addUser(user, chat) { // Need chat for chat_id
    if (!user || !user.id || !chat || !chat.id) {
        console.error(`[Data] Invalid user or chat object in addUser`);
        return { success: false, error: "Invalid user or chat data" };
    }
    try {
        const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "کاربر تلگرام";
        const { error } = await supabase.from("users").upsert({
            user_id: user.id,
            chat_id: chat.id, // Store chat_id on upsert
            full_name: fullName.substring(0, 255),
            username: user.username?.substring(0, 255),
            last_seen_at: new Date().toISOString(), // Update last seen
        }, { onConflict: "user_id" }); // Assuming user_id is PK

        if (error) {
            // Handle potential constraint violation if chat_id unique constraint exists and another user has it (unlikely for private)
            if (error.code === '23505' && error.details?.includes('chat_id')) {
                console.warn(`[Data] Chat ID ${chat.id} already exists for a different user. Ignoring upsert for user ${user.id}.`);
                return { success: true, warning: "Chat ID conflict ignored" }; // Still consider it success
            } else {
                console.error(`[Data] Error upserting user ${user.id} / chat ${chat.id}: ${error.message}`);
                return { success: false, error: error.message };
            }
        }
        console.log(`[Data] User ${user.id} (${fullName}) added/updated.`);
        return { success: true };
    } catch (e) {
        console.error(`[Data] Exception in addUser for ${user.id}: ${e.stack}`);
        return { success: false, error: e.message };
    }
}

async function addGroup(chat) {
    if (!chat || !chat.id || (chat.type !== "group" && chat.type !== "supergroup")) return;
    try {
        const { error } = await supabase.from("groups").upsert({
            group_id: chat.id,
            group_name: (chat.title || `گروه ${chat.id}`).substring(0, 255),
            last_seen_at: new Date().toISOString(),
        }, { onConflict: "group_id" });

        if (error) {
            console.error(`[Data] Error upserting group ${chat.id}: ${error.message}`);
        } else {
            console.log(`[Data] Group ${chat.title || chat.id} added/updated.`);
        }
    } catch (e) {
        console.error(`[Data] Exception in addGroup for ${chat.id}: ${e.stack}`);
    }
}

async function getUserSchedule(userId) {
    try {
        const { data, error } = await supabase
            .from("user_schedules")
            .select("odd_week_schedule, even_week_schedule")
            .eq("user_id", userId)
            .maybeSingle();

        if (error) throw error;

        // Ensure schedule fields are always objects, even if null/malformed in DB
        const oddSchedule = (data?.odd_week_schedule && typeof data.odd_week_schedule === 'object' && !Array.isArray(data.odd_week_schedule))
                            ? data.odd_week_schedule : {};
        const evenSchedule = (data?.even_week_schedule && typeof data.even_week_schedule === 'object' && !Array.isArray(data.even_week_schedule))
                            ? data.even_week_schedule : {};

        // Basic validation/cleanup of schedule data (optional but good)
        const cleanSchedule = (schedule) => {
             const cleaned = {};
             for (const day of ENGLISH_WEEKDAYS) {
                 if(Array.isArray(schedule[day])) {
                     cleaned[day] = schedule[day].filter(lesson =>
                         lesson && typeof lesson.lesson === 'string' &&
                         typeof lesson.start_time === 'string' && SCHEDULE_TIME_REGEX.test(lesson.start_time) &&
                         typeof lesson.end_time === 'string' && SCHEDULE_TIME_REGEX.test(lesson.end_time) &&
                         typeof lesson.location === 'string'
                     ).sort((a, b) => (parseTime(a.start_time) ?? 9999) - (parseTime(b.start_time) ?? 9999));
                 }
             }
             return cleaned;
        };

        return {
            odd_week_schedule: cleanSchedule(oddSchedule),
            even_week_schedule: cleanSchedule(evenSchedule)
        };
    } catch (e) {
        console.error(`[Schedule] Error fetching schedule for user ${userId}: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `🆘 DB Error fetching schedule for user ${userId}: ${e.message}`);
        return { odd_week_schedule: {}, even_week_schedule: {} }; // Return empty on error
    }
}

async function saveUserSchedule(userId, weekType, day, lesson) {
    try {
        const currentSchedules = await getUserSchedule(userId); // Fetch validated schedules
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";

        // Get the existing schedule for the specific day or initialize if not present
        const daySchedule = currentSchedules[scheduleField]?.[day] || [];

        // Add the new lesson
        const updatedDaySchedule = [...daySchedule, lesson];

        // Sort lessons by start time (using parseTime for accurate comparison)
        updatedDaySchedule.sort((a, b) => (parseTime(a.start_time) ?? 9999) - (parseTime(b.start_time) ?? 9999));

        // Construct the final schedule object for the specific week type
        const finalWeekSchedule = {
            ...(currentSchedules[scheduleField] || {}),
            [day]: updatedDaySchedule // Add/update the current day
        };

        // Prepare the update payload, ensuring the other week's schedule is included
        const updatePayload = {
            user_id: userId,
            [scheduleField]: finalWeekSchedule,
            // Ensure the other schedule is also present in the update/upsert
            [weekType === "odd" ? "even_week_schedule" : "odd_week_schedule"]: currentSchedules[weekType === "odd" ? "even_week_schedule" : "odd_week_schedule"],
            updated_at: new Date().toISOString(),
        };

        const { error } = await supabase
            .from("user_schedules")
            .upsert(updatePayload, { onConflict: "user_id" });

        if (error) throw error;
        console.log(`[Schedule] Saved lesson for user ${userId}, week ${weekType}, day ${day}`);

    } catch (e) {
        console.error(`[Schedule] Error saving schedule for user ${userId}: ${e.stack}`);
        throw e; // Re-throw to be handled by caller
    }
}

async function deleteUserScheduleLesson(userId, weekType, day, lessonIndex) {
    try {
        const currentSchedules = await getUserSchedule(userId);
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";

        if (!currentSchedules[scheduleField]?.[day] || !currentSchedules[scheduleField][day][lessonIndex]) {
            console.warn(`[Schedule] Lesson index ${lessonIndex} not found for deletion: user ${userId}, week ${weekType}, day ${day}`);
            return false; // Indicate no change
        }

        // Create a mutable copy of the day's schedule
        const updatedDaySchedule = [...currentSchedules[scheduleField][day]];
        const deletedLesson = updatedDaySchedule.splice(lessonIndex, 1)[0]; // Remove the lesson

        // Construct the updated week schedule
        const finalWeekSchedule = {
            ...currentSchedules[scheduleField],
            [day]: updatedDaySchedule // Update the day's schedule
        };

        // Remove the day key if the schedule becomes empty
        if (updatedDaySchedule.length === 0) {
            delete finalWeekSchedule[day];
        }

        // Update only the modified schedule field in the database
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: finalWeekSchedule,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (error) throw error;
        console.log(`[Schedule] Lesson '${deletedLesson.lesson}' deleted for user ${userId}, week ${weekType}, day ${day}`);
        return true; // Indicate success

    } catch (e) {
        console.error(`[Schedule] Error deleting schedule lesson for user ${userId}: ${e.stack}`);
        throw e; // Re-throw
    }
}

async function deleteUserScheduleDay(userId, weekType, day) {
    try {
        const currentSchedules = await getUserSchedule(userId);
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";

        if (!currentSchedules[scheduleField]?.[day]) {
            console.log(`[Schedule] No lessons found to delete for user ${userId}, week ${weekType}, day ${day}`);
            return false; // No change needed
        }

        // Create a mutable copy and remove the day's key
        const finalWeekSchedule = { ...currentSchedules[scheduleField] };
        delete finalWeekSchedule[day];

        // Update the database
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: finalWeekSchedule,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (error) throw error;
        console.log(`[Schedule] All lessons deleted for user ${userId}, week ${weekType}, day ${day}`);
        return true;

    } catch (e) {
        console.error(`[Schedule] Error deleting schedule day for user ${userId}: ${e.stack}`);
        throw e;
    }
}

async function deleteEntireWeekSchedule(userId, weekType) {
    try {
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";

        // Update the specific week's schedule to an empty JSON object
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: {}, // Set to empty object
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (error) throw error;
        console.log(`[Schedule] Entire ${weekType} week schedule deleted for user ${userId}`);
        return true;

    } catch (e) {
        console.error(`[Schedule] Error deleting entire ${weekType} schedule for user ${userId}: ${e.stack}`);
        throw e;
    }
}

// --- PDF Generation (Fixed) ---
async function generateSchedulePDF(userId, fullName) {
    console.log(`[PDF] Generating schedule PDF for user ${userId} (${fullName})`);
    try {
        // Initialize PDF with landscape orientation and margins
        const doc = new jsPDF({ 
            orientation: "landscape", 
            unit: "mm", 
            format: "a4",
            putOnlyUsedFonts: true,
            floatPrecision: 16
        });

        // Get schedule data first to minimize memory pressure
        const schedule = await getUserSchedule(userId);

        // Get and add Vazir font
        const fontArrayBuffer = await getVazirFont();
        if (!fontArrayBuffer) {
            throw new Error("Failed to load Vazir font");
        }

        // Convert ArrayBuffer to base64
        const uint8Array = new Uint8Array(fontArrayBuffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < uint8Array.length; i += chunk) {
            binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunk));
        }
        const base64Font = btoa(binary);

        // Add Vazir font to the document
        doc.addFileToVFS('Vazirmatn-Regular.ttf', base64Font);
        doc.addFont('Vazirmatn-Regular.ttf', 'Vazir', 'normal');
        doc.setFont('Vazir');

        // Set RTL mode and default font size
        doc.setR2L(true);
        doc.setFontSize(12);

        // Define page dimensions and margins
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 10;

        // Define class time slots
        const timeSlots = {
            'کلاس اول': { start: '08:00', end: '10:00' },
            'کلاس دوم': { start: '10:00', end: '12:00' },
            'کلاس سوم': { start: '13:00', end: '15:00' },
            'کلاس چهارم': { start: '15:00', end: '17:00' },
            'کلاس پنجم': { start: '17:00', end: '19:00' }
        };

        // Process each week type
        const weekTypes = [
            { type: "odd", label: "فرد", emoji: "🟣", data: schedule.odd_week_schedule },
            { type: "even", label: "زوج", emoji: "🟢", data: schedule.even_week_schedule }
        ];

        for (let pageIndex = 0; pageIndex < weekTypes.length; pageIndex++) {
            if (pageIndex > 0) {
                doc.addPage();
            }

            const { type, label, emoji, data } = weekTypes[pageIndex];

            // Add title and name
            doc.setFontSize(16);
            doc.text("برنامه هفتگی", pageWidth / 2, 15, { align: "center" });
            doc.setFontSize(14);
            doc.text(`نام: ${fullName}`, pageWidth / 2, 25, { align: "center" });
            doc.text(`هفته ${label} ${emoji}`, pageWidth / 2, 35, { align: "center" });

            // Create the main schedule table
            try {
                // Prepare column headers for time slots
                const headers = [
                    'روز',
                    'کلاس اول\n08:00 - 10:00',
                    'کلاس دوم\n10:00 - 12:00',
                    'کلاس سوم\n13:00 - 15:00',
                    'کلاس چهارم\n15:00 - 17:00',
                    'کلاس پنجم\n17:00 - 19:00'
                ];

                // Prepare table data
                const tableData = [];
                
                // Process each day
                for (const day of ENGLISH_WEEKDAYS) {
                    const lessons = data[day] || [];
                    const dayName = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
                    
                    // Initialize row with empty slots
                    const row = [dayName, '-', '-', '-', '-', '-'];
                    
                    // Fill in lessons in appropriate time slots
                    for (const lesson of lessons) {
                        const startTime = lesson.start_time;
                        let slotIndex = -1;
                        
                        if (startTime >= '08:00' && startTime < '10:00') slotIndex = 1;
                        else if (startTime >= '10:00' && startTime < '12:00') slotIndex = 2;
                        else if (startTime >= '13:00' && startTime < '15:00') slotIndex = 3;
                        else if (startTime >= '15:00' && startTime < '17:00') slotIndex = 4;
                        else if (startTime >= '17:00' && startTime < '19:00') slotIndex = 5;
                        
                        if (slotIndex !== -1) {
                            row[slotIndex] = `${lesson.lesson}\n${lesson.location}`;
                        }
                    }
                    
                    tableData.push(row);
                }

                // Create the table
                autoTable(doc, {
                    startY: 45,
                    head: [headers],
                    body: tableData,
                    theme: 'grid',
                    styles: {
                        font: 'Vazir',
                        fontSize: 10,
                        cellPadding: 2,
                        overflow: 'linebreak',
                        minCellHeight: 15,
                        halign: 'center',
                        valign: 'middle',
                        lineWidth: 0.3
                    },
                    headStyles: {
                        fillColor: [200, 200, 200],
                        textColor: [0, 0, 0],
                        fontSize: 11,
                        fontStyle: 'normal',
                        minCellHeight: 20
                    },
                    columnStyles: {
                        0: { cellWidth: 25 }, // روز
                        1: { cellWidth: 50 }, // کلاس اول
                        2: { cellWidth: 50 }, // کلاس دوم
                        3: { cellWidth: 50 }, // کلاس سوم
                        4: { cellWidth: 50 }, // کلاس چهارم
                        5: { cellWidth: 50 }  // کلاس پنجم
                    },
                    margin: { left: margin, right: margin },
                    didDrawPage: function(data) {
                        // Add footer
                        doc.setFontSize(8);
                        doc.text("@WeekStatusBot", pageWidth - margin, pageHeight - 5, { align: "right" });
                    }
                });

            } catch (tableError) {
                console.error(`[PDF] Table generation error: ${tableError.stack}`);
                throw new Error(`Failed to generate table: ${tableError.message}`);
            }
        }

        // Generate PDF buffer
        console.log(`[PDF] Generation complete for user ${userId}. Outputting buffer.`);
        return new Uint8Array(doc.output('arraybuffer'));

    } catch (e) {
        console.error(`[PDF] Error generating PDF for user ${userId}: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `🆘 PDF Generation Error for user ${userId} (${fullName}): ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        throw e;
    }
}

// --- Broadcast Function (Enhanced) ---
async function broadcastMessage(fromChatId, messageId, targetType) {
    console.log(`[Broadcast] Starting broadcast. Type: ${targetType}, Msg ID: ${messageId}, From: ${fromChatId}`);
    const targetLabel = targetType === "users" ? "کاربران" : "گروه‌ها";
    const idColumn = targetType === "users" ? "user_id" : "group_id";
    const tableName = targetType; // 'users' or 'groups'
    let broadcastRecordId = null;
    let targets = [];
    let totalTargets = 0;
    const startTime = Date.now();

    // 1. Record Broadcast Intent
    try {
        const { data: broadcastData, error: insertError } = await supabase
            .from("broadcasts")
            .insert({
                from_chat_id: fromChatId,
                message_id: messageId,
                target_type: targetType,
                status: 'sending', // Mark as sending
                started_at: new Date().toISOString(),
            })
            .select("broadcast_id")
            .single();
        if (insertError) throw insertError;
        broadcastRecordId = broadcastData.broadcast_id;
        console.log(`[Broadcast:${broadcastRecordId}] Recorded broadcast intent.`);
    } catch (e) {
        console.error(`[Broadcast] Error recording broadcast in Supabase: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `خطا در ثبت رکورد اعلان: ${e.message}`);
        return { success: 0, fail: 0, report: `Failed to record broadcast: ${e.message}` };
    }

    // 2. Fetch Targets
    try {
        const selectField = targetType === 'users' ? 'chat_id' : 'group_id'; // Select CHAT_ID for users!
        const { data, error, count } = await supabase
            .from(tableName)
            .select(selectField, { count: 'exact' });

        if (error) throw error;
        // Ensure targets are strings and filter out nulls/empty values
        targets = data.map(item => item[selectField]?.toString()).filter(Boolean);
        totalTargets = count ?? targets.length; // Use count if available
        console.log(`[Broadcast:${broadcastRecordId}] Fetched ${targets.length} target IDs (${totalTargets} total in table ${tableName}).`);

        if (targets.length === 0) {
            throw new Error(`Target list (${targetLabel}) is empty.`);
        }

    } catch (e) {
        console.error(`[Broadcast:${broadcastRecordId}] Error fetching ${targetLabel}: ${e.stack}`);
        const errorMsg = `خطا در دریافت لیست ${targetLabel}: ${e.message}`;
        await supabase.from("broadcasts").update({ status: 'failed', finished_at: new Date().toISOString(), details: errorMsg }).eq("broadcast_id", broadcastRecordId);
        await sendMessage(ADMIN_CHAT_ID, errorMsg);
        return { success: 0, fail: 0, report: errorMsg };
    }

    // 3. Send Messages
    let successCount = 0, failCount = 0;
    const failedTargetsInfo = []; // Store { targetId, error }

    await sendMessage(ADMIN_CHAT_ID, `⏳ شروع ارسال اعلان ${broadcastRecordId} به ${targets.length} ${targetLabel}...`);

    const BATCH_SIZE = 25; // Max 30/sec, stay safe
    const DELAY_BETWEEN_BATCHES = 1100; // ms

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);
        console.log(`[Broadcast:${broadcastRecordId}] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)} (Size: ${batch.length})`);

        const batchPromises = batch.map(targetId =>
            forwardMessage(targetId, fromChatId, messageId)
                .then(result => ({ status: 'fulfilled', targetId, result }))
                .catch(error => ({ status: 'rejected', targetId, error })) // Catch network errors too
        );

        // Using Promise.allSettled to handle both fulfilled and rejected promises
        const results = await Promise.allSettled(batchPromises);

        results.forEach(p_result => {
             if (p_result.status === 'fulfilled') {
                 const { targetId, result } = p_result.value;
                 if (result.ok) {
                     successCount++;
                 } else {
                     failCount++;
                     const errorMsg = `${result.error_code || 'Error'}: ${result.description || 'Unknown forward error'}`;
                     failedTargetsInfo.push({ targetId, error: errorMsg });
                     console.warn(`[Broadcast:${broadcastRecordId}] Failed -> ${targetType} ${targetId}: ${errorMsg}`);
                     // Optional: Mark user/group as inactive in DB based on error code (e.g., 403)
                 }
             } else { // status === 'rejected'
                 const { targetId, reason } = p_result;
                 failCount++;
                 const errorMsg = reason instanceof Error ? reason.message : String(reason);
                 failedTargetsInfo.push({ targetId, error: `Network/Code Error: ${errorMsg}`});
                 console.warn(`[Broadcast:${broadcastRecordId}] Failed -> ${targetType} ${targetId}: Network/Code Error - ${errorMsg}`);
             }
         });


        // Optional: Update status periodically? Not strictly needed.

        // Delay before next batch
        if (i + BATCH_SIZE < targets.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
    }

    // 4. Finalize and Report
    const duration = (Date.now() - startTime) / 1000;
    console.log(`[Broadcast:${broadcastRecordId}] Finished in ${duration.toFixed(1)}s. Success: ${successCount}, Fail: ${failCount}`);

    let reportMessage = `📢 گزارش اعلان ${broadcastRecordId} (${duration.toFixed(1)} ثانیه)\n\n`;
    reportMessage += `🎯 هدف: ${targets.length} ${targetLabel}\n`;
    reportMessage += `✅ موفق: ${successCount}\n`;
    reportMessage += `❌ ناموفق: ${failCount}\n`;

    let reportDetails = "";
    if (failCount > 0) {
        reportDetails += `\n--- خطاهای نمونه (${Math.min(failCount, 10)} مورد) ---\n`;
        failedTargetsInfo.slice(0, 10).forEach(f => {
            reportDetails += `ID: ${f.targetId}, خطا: ${f.error}\n`;
        });
        if (failCount > 10) reportDetails += `... و ${failCount - 10} خطای دیگر\n`;
    }

    const finalStatus = failCount === 0 ? 'completed' : (successCount > 0 ? 'completed' : 'failed'); // 'completed' even with errors if some succeeded

    // Update broadcast record in DB
    try {
        await supabase.from("broadcasts").update({
            status: finalStatus,
            finished_at: new Date().toISOString(),
            success_count: successCount,
            fail_count: failCount,
            details: reportDetails.substring(0, 1000) // Store some details, limited length
        }).eq("broadcast_id", broadcastRecordId);
    } catch (e) {
        console.error(`[Broadcast:${broadcastRecordId}] Error updating final broadcast status: ${e.stack}`);
        reportMessage += "\n⚠️ خطا در بروزرسانی رکورد نهایی اعلان.";
    }

    // Send report to admin
    const fullReport = reportMessage + reportDetails;
    if (fullReport.length > 4000) {
        await sendMessage(ADMIN_CHAT_ID, reportMessage + "\n...(گزارش خطاها به دلیل طول زیاد کوتاه شد)");
        // Optionally send details in a separate message if needed
    } else {
        await sendMessage(ADMIN_CHAT_ID, fullReport);
    }

    return { success: successCount, fail: failCount, report: reportMessage };
}


// --- Command Handlers (Integrated with Supabase & New Features) ---

async function handleStartCommand(message) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown", first_name: "کاربر" };
    const chat = message.chat;

    await logUsage(user, chat, "/start");

    try {
        if (chat.type === "private") {
            // Add/update user in Supabase
            await addUser(user, chat);

            const welcomeMessage = `سلام ${user.first_name}! 👋\n\nبه ربات مدیریت برنامه هفتگی و وضعیت دانشگاه خوش آمدید. 🎓\n\n*امکانات اصلی:*\n🔄 *وضعیت هفته:* نمایش زوج/فرد بودن هفته و برنامه امروز شما.\n📅 *برنامه شما:* مشاهده و مدیریت کامل برنامه هفتگی.\n⚙️ *تنظیم برنامه:* افزودن، ویرایش و حذف کلاس‌ها.\n📤 *خروجی PDF:* دریافت فایل PDF زیبا از برنامه.\n\n👇 از دکمه‌های زیر استفاده کنید:`;
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "🔄 وضعیت هفته و برنامه امروز", callback_data: "menu:week_status" },
                    ],
                    [
                        { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                        { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                    ],
                    [
                        { text: "📤 دریافت PDF برنامه", callback_data: "pdf:export" },
                        { text: "ℹ️ راهنما", callback_data: "menu:help" }
                    ]
                ],
            };
            await sendMessage(chatId, welcomeMessage, replyMarkup);
        } else if (chat.type === "group" || chat.type === "supergroup") {
            // Ensure group is tracked
            await addGroup(chat);
            // Optional: Send a brief message in the group
            const botInfo = await getBotInfo();
            await sendMessage(chatId, `سلام! 👋 من ربات وضعیت هفته هستم.\nبرای دیدن وضعیت از /week استفاده کنید.\nبرای تنظیم برنامه شخصی، لطفاً در چت خصوصی با من (@${botInfo.username}) صحبت کنید.`, null, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/start] Error for chat ${chatId}: ${error.stack}`);
        await sendMessage(chatId, "⚠️ متاسفانه مشکلی در اجرای دستور /start پیش آمد.");
    }
}

async function handleHelpCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:help" : "/help");

    try {
        const isAdmin = String(user.id) === ADMIN_CHAT_ID;
        let helpMessage = `🔰 *راهنمای ربات برنامه هفتگی* 🔰\n\n`;
        helpMessage += `*دستورات و دکمه‌ها:*\n`;
        helpMessage += `🔄 */week* یا دکمه *وضعیت هفته*: نمایش زوج/فرد بودن هفته فعلی/بعدی + برنامه امروز شما (در خصوصی).\n`;
        helpMessage += `📅 */schedule* یا دکمه *تنظیم برنامه*: ورود به منوی مدیریت برنامه (تنظیم، مشاهده، حذف).\n`;
        helpMessage += `📤 دکمه *دریافت PDF*: ساخت و ارسال فایل PDF برنامه شما.\n`;
        helpMessage += `🔮 */teleport <تاریخ>* : بررسی وضعیت هفته در تاریخ آینده (مثال: \`/teleport 1403/08/25\`).\n`;
        helpMessage += `ℹ️ */help* یا دکمه *راهنما*: نمایش همین پیام.\n\n`;

        if (isAdmin && chat.type === "private") {
            helpMessage += `*دستورات ادمین (فقط خصوصی):*\n`;
            helpMessage += `👑 */admin* یا دکمه *پنل مدیریت*: نمایش پنل.\n`;
            helpMessage += `📊 */stats* یا دکمه *آمار*: نمایش آمار ربات.\n\n`;
        }

        helpMessage += `*نکات:*\n`;
        helpMessage += `• ربات را می‌توانید به گروه‌های درسی اضافه کنید.\n`;
        helpMessage += `• تمام امکانات مدیریت برنامه و PDF فقط در چت خصوصی در دسترس هستند.\n`;
        helpMessage += `• تاریخ‌ها را به فرمت شمسی \`سال/ماه/روز\` وارد کنید.\n`;
        helpMessage += `• محاسبه هفته بر اساس تاریخ مرجع ${REFERENCE_PERSIAN_DAY} ${getPersianMonthName(REFERENCE_PERSIAN_MONTH)} ${REFERENCE_PERSIAN_YEAR} (هفته *${REFERENCE_STATUS}*) است.\n\n`;
        helpMessage += `ساخته شده با ❤️ توسط @alirezamozii`;

        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "🔄 وضعیت هفته و برنامه امروز", callback_data: "menu:week_status" },
                ],
                [
                    { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                    { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                ],
                [
                    { text: "📤 دریافت PDF برنامه", callback_data: "pdf:export" },
                    { text: "🔮 تلپورت", callback_data: "teleport:ask_date" }
                ],
                (isAdmin && chat.type === "private") ? [{ text: "👑 پنل مدیریت", callback_data: "admin:panel" }] : [],
            ].filter(row => row.length > 0)
        };

        if (fromCallback) {
            await editMessageText(chatId, message.message_id, helpMessage, replyMarkup);
        } else {
            await sendMessage(chatId, helpMessage, replyMarkup, message.message_id);
        }

    } catch (error) {
        console.error(`[Command:/help] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در نمایش راهنما.";
        if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}

async function handleWeekCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:week_status" : "/week");

    try {
        const currentWeekStatus = getWeekStatus();
        const persianDate = getPersianDate();

        if (currentWeekStatus.includes("خطا") || currentWeekStatus.includes("نامشخص")) {
            const errorMsg = `❌ ${persianDate}\n\nخطا در محاسبه وضعیت هفته: ${currentWeekStatus}`;
            if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
            else await sendMessage(chatId, errorMsg, null, message.message_id);
            return;
        }

        const currentWeekEmoji = currentWeekStatus === "زوج" ? "🟢" : "🟣";
        const nextWeekStatus = currentWeekStatus === "زوج" ? "فرد" : "زوج";
        const nextWeekEmoji = nextWeekStatus === "زوج" ? "🟢" : "🟣";

        let weekMessage = `${persianDate}\n\n`;
        weekMessage += `${currentWeekEmoji} هفته فعلی: *${currentWeekStatus}* است\n`;
        weekMessage += `${nextWeekEmoji} هفته بعدی: *${nextWeekStatus}* خواهد بود\n\n`;

        let replyMarkup = {};

        if (chat.type === "private") {
            const schedule = await getUserSchedule(user.id);
            const todayLuxon = DateTime.now().setZone(TEHRAN_TIMEZONE);
            // Adjust index for Luxon weekday (Monday=1, Sunday=7) to Persian week (Saturday=0)
            const todayIndex = (todayLuxon.weekday + 1) % 7; // Saturday = 0, ..., Friday = 6
            const todayDayKey = ENGLISH_WEEKDAYS[todayIndex]; // Get the key like 'saturday'
            const todayPersianDay = PERSIAN_WEEKDAYS_FULL[todayIndex];

            const todaySchedule = currentWeekStatus === "زوج"
                                   ? (schedule.even_week_schedule[todayDayKey] || [])
                                   : (schedule.odd_week_schedule[todayDayKey] || []);

            if (todayIndex < 5 && todaySchedule.length > 0) { // Weekday with schedule
                weekMessage += `📅 *برنامه امروز (${todayPersianDay}):*\n\n`;
                todaySchedule.forEach((lesson, idx) => {
                    // Map time slots to class numbers
                    const startMins = parseTime(lesson.start_time);
                    let classNum = "";
                    if (startMins >= 8*60 && startMins < 10*60) classNum = "(کلاس اول) ";
                    else if (startMins >= 10*60 && startMins < 12*60) classNum = "(کلاس دوم) ";
                    else if (startMins >= 13*60 && startMins < 15*60) classNum = "(کلاس سوم) ";
                    else if (startMins >= 15*60 && startMins < 17*60) classNum = "(کلاس چهارم) ";
                    else if (startMins >= 17*60 && startMins < 19*60) classNum = "(کلاس پنجم) ";

                    weekMessage += `${idx + 1}. ${classNum}*${lesson.lesson}*\n`;
                    weekMessage += `   ⏰ ${lesson.start_time}-${lesson.end_time} | 📍 ${lesson.location || '-'}\n`;
                });
            } else if (todayIndex < 5) { // Weekday, no schedule
                 weekMessage += `🗓️ شما برای امروز (${todayPersianDay}) در هفته *${currentWeekStatus}* برنامه‌ای تنظیم نکرده‌اید.\n`;
            } else { // Weekend
                 weekMessage += `🥳 امروز ${todayPersianDay} است! آخر هفته خوبی داشته باشید.\n`;
            }

            replyMarkup = { // Buttons for private chat
                inline_keyboard: [
                     [
                        { text: "🔄 بروزرسانی", callback_data: "menu:week_status" },
                    ],
                    [
                        { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                        { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                    ],
                     [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]
                ],
            };
        } else { // Group chat - only show week status
            replyMarkup = {
                inline_keyboard: [
                  [{ text: "🔄 بروزرسانی وضعیت", callback_data: "menu:week_status" }],
                ],
            };
        }

        if (fromCallback) {
            await editMessageText(chatId, message.message_id, weekMessage, replyMarkup);
        } else {
            await sendMessage(chatId, weekMessage, replyMarkup, message.message_id);
        }

    } catch (error) {
        console.error(`[Command:/week] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در پردازش دستور /week.";
         if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}

async function handleScheduleCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:schedule" : "/schedule");

    try {
        if (chat.type !== "private") {
            const botInfo = await getBotInfo();
            await sendMessage(chatId, `⚠️ مدیریت برنامه هفتگی فقط در چت خصوصی با من (@${botInfo.username}) امکان‌پذیر است.`, null, message.message_id);
            return;
        }
        await addUser(user, chat); // Ensure user exists

        const scheduleMessage = `📅 *مدیریت برنامه هفتگی*\n\nاز دکمه‌های زیر برای تنظیم، مشاهده، حذف یا گرفتن خروجی PDF برنامه خود استفاده کنید:`;
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "⚙️ تنظیم / افزودن درس", callback_data: "schedule:set:select_week" }, // Start setting flow
                    { text: "🗑️ حذف درس / روز / هفته", callback_data: "schedule:delete:main" }, // Start deletion flow
                ],
                 [
                     { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                    { text: "📤 خروجی PDF برنامه", callback_data: "pdf:export" }
                ],
                [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }], // Back to main help/menu
            ],
        };

        if (fromCallback) {
            await editMessageText(chatId, message.message_id, scheduleMessage, replyMarkup);
        } else {
            await sendMessage(chatId, scheduleMessage, replyMarkup, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/schedule] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در پردازش دستور /schedule.";
        if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}

// --- Add other command handlers (/admin, /broadcast, /stats, /teleport) here ---
// --- Make sure they use Supabase and new structures where appropriate ---
// --- Include the new callback query handler `handleCallbackQuery` ---
// --- Include the `handleMessage` function to route messages ---
// --- Include the `handleRequest` function ---
// --- Include the server startup logic ---

// Placeholder for other handlers (reuse relevant parts from your original code, adapting to Supabase)
async function handleAdminCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from;
    const isAdmin = String(user?.id) === ADMIN_CHAT_ID;
    await logUsage(user, message.chat, fromCallback ? "callback: admin:panel" : "/admin");

    if (!isAdmin || message.chat.type !== "private") {
        await sendMessage(chatId, "⛔️ این دستور مخصوص ادمین و فقط در چت خصوصی قابل استفاده است.", null, message.message_id);
        return;
    }

    let adminMessage = `👑 *پنل مدیریت ربات*\n\n`;
    adminMessage += `وضعیت هفته فعلی: *${getWeekStatus()}*\n`;

    const replyMarkup = {
      inline_keyboard: [
        [ // Row 2: Stats
          { text: "📊 آمار ربات", callback_data: "admin:stats" },
        ],
         [ // Row 3: Back
           { text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" },
         ]
      ],
    };

     if (fromCallback) {
        await editMessageText(chatId, message.message_id, adminMessage, replyMarkup);
    } else {
        await sendMessage(chatId, adminMessage, replyMarkup, message.message_id);
    }
}

async function handleStatsCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from;
    const isAdmin = String(user?.id) === ADMIN_CHAT_ID;
    await logUsage(user, message.chat, fromCallback ? "callback: admin:stats" : "/stats");

     if (!isAdmin || message.chat.type !== "private") {
        await sendMessage(chatId, "⛔️ این دستور مخصوص ادمین و فقط در چت خصوصی قابل استفاده است.", null, message.message_id);
        return;
    }

    if (fromCallback) await answerCallbackQuery(message.callback_query_id, "📊 در حال دریافت آمار...");

    try {
        // Fetch stats concurrently
        const [usersResult, groupsResult, usageResult, scheduleResult, broadcastResult] = await Promise.all([
            supabase.from("users").select('user_id', { count: 'exact', head: true }),
            supabase.from("groups").select('group_id', { count: 'exact', head: true }),
            // Get usage count more efficiently
            supabase.from("bot_usage").select('*', { count: 'exact', head: true }),
            supabase.from("user_schedules").select('user_id', { count: 'exact', head: true }),
            supabase.from("broadcasts").select('broadcast_id', { count: 'exact', head: true })
        ]);

        // Fetch last 10 commands separately if needed
        const { data: recentCommands, error: cmdError } = await supabase
            .from("bot_usage")
            .select("command")
            .order('timestamp', { ascending: false })
            .limit(50); // Fetch more to analyze top commands

        const userCount = usersResult.count ?? 'خطا';
        const groupCount = groupsResult.count ?? 'خطا';
        const usageCount = usageResult.count ?? 'خطا';
        const scheduleCount = scheduleResult.count ?? 'خطا';
        const broadcastCount = broadcastResult.count ?? 'خطا';
        const currentStatus = getWeekStatus();

        // Process command usage
        let commandUsage = {};
        if (recentCommands && !cmdError) {
            commandUsage = recentCommands.reduce((acc, row) => {
              const cmd = row.command || 'نامشخص';
              // Normalize callback data slightly
              const cleanCmd = cmd.startsWith('callback:') ? cmd.split(':')[0]+':'+cmd.split(':')[1] : cmd;
              acc[cleanCmd] = (acc[cleanCmd] || 0) + 1;
              return acc;
            }, {});
        }
        const sortedCommands = Object.entries(commandUsage)
                                    .sort(([,a], [,b]) => b - a)
                                    .slice(0, 7); // Top 7

        let statsMessage = `📊 *آمار ربات (Supabase)*\n\n`;
        statsMessage += `📅 وضعیت هفته فعلی: *${currentStatus}*\n`;
        statsMessage += `👤 کاربران ثبت شده: ${userCount}\n`;
        statsMessage += `👥 گروه‌های ثبت شده: ${groupCount}\n`;
        statsMessage += `🗓️ کاربران با برنامه: ${scheduleCount}\n`;
        statsMessage += `📢 رکوردهای اعلان: ${broadcastCount}\n`;
        statsMessage += `📈 کل استفاده ثبت شده: ${usageCount}\n\n`;

        if (sortedCommands.length > 0) {
          statsMessage += `📈 دستورات پراستفاده (نمونه ${recentCommands?.length || 0} لاگ اخیر):\n`;
          sortedCommands.forEach(([command, count]) => {
            statsMessage += ` - \`${command.substring(0, 30)}\`: ${count} بار\n`; // Truncate long commands
          });
        } else if(cmdError) {
           statsMessage += `📈 خطا در دریافت آمار دستورات: ${cmdError.message}\n`;
        } else {
          statsMessage += "📈 اطلاعات استفاده از دستورات در دسترس نیست.\n";
        }

        const statsReplyMarkup = {
            inline_keyboard: [
              [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
              [{ text: "↩️ بازگشت به پنل ادمین", callback_data: "admin:panel" }],
            ],
        };

        if (fromCallback) {
             await editMessageText(chatId, message.message_id, statsMessage, statsReplyMarkup);
             await answerCallbackQuery(message.callback_query_id); // Clear loading state
        } else {
             await sendMessage(chatId, statsMessage, statsReplyMarkup, message.message_id);
        }

    } catch (e) {
        console.error(`[Command:/stats] Error: ${e.stack}`);
         const errorMsg = "خطا در دریافت آمار از Supabase.";
         if (fromCallback) {
            await answerCallbackQuery(message.callback_query_id, errorMsg, true);
            await editMessageText(chatId, message.message_id, errorMsg, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "admin:panel" }]] }).catch(()=>{});
         } else {
            await sendMessage(chatId, errorMsg, null, message.message_id);
         }
    }
}

async function calculateFutureWeekStatus(persianDateStr) {
    try {
        const parsedDate = parsePersianDate(persianDateStr);
        if (!parsedDate) {
            return "⚠️ تاریخ وارد شده نامعتبر است.\nفرمت: `سال/ماه/روز` (مثال: `/teleport 1404/02/10`)";
        }

        console.log(`[Teleport] Parsed Persian date: ${JSON.stringify(parsedDate)}`);

        const gregorianArray = jalaliToGregorian(parsedDate.year, parsedDate.month, parsedDate.day);
        if (!gregorianArray) {
            throw new Error("Failed to convert Persian date to Gregorian.");
        }
        const futureDateUTC = new Date(Date.UTC(gregorianArray[0], gregorianArray[1] - 1, gregorianArray[2]));
        futureDateUTC.setUTCHours(0, 0, 0, 0);
        console.log(`[Teleport] Future date UTC: ${futureDateUTC.toISOString()}`);

        if (isNaN(futureDateUTC.getTime())) {
            throw new Error("Calculated future Gregorian date is invalid.");
        }

        // Get current date in Tehran timezone
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        console.log(`[Teleport] Current Tehran time: ${now.toISO()}`);
        
        const todayTehranAsUTC = new Date(Date.UTC(now.year, now.month - 1, now.day));
        todayTehranAsUTC.setUTCHours(0, 0, 0, 0);
        console.log(`[Teleport] Today Tehran as UTC: ${todayTehranAsUTC.toISOString()}`);

        if (futureDateUTC.getTime() < todayTehranAsUTC.getTime()) {
            return "🕰 این تاریخ در گذشته است. لطفاً تاریخی در آینده وارد کنید.";
        }

        if (!REFERENCE_DATE_GREGORIAN || isNaN(REFERENCE_DATE_GREGORIAN.getTime())) {
            console.error("CRITICAL ERROR: REFERENCE_DATE_GREGORIAN is not valid in calculateFutureWeekStatus.");
            return "❌ خطا: تنظیمات تاریخ مرجع نامعتبر است.";
        }

        const targetWeekStartDateUTC = getStartOfWeekPersian(futureDateUTC);
        const referenceWeekStartDateUTC = getStartOfWeekPersian(REFERENCE_DATE_GREGORIAN);
        console.log(`[Teleport] Target week start UTC: ${targetWeekStartDateUTC.toISOString()}`);
        console.log(`[Teleport] Reference week start UTC: ${referenceWeekStartDateUTC.toISOString()}`);

        if (isNaN(targetWeekStartDateUTC.getTime()) || isNaN(referenceWeekStartDateUTC.getTime())) {
            console.error(`Error: Invalid date calculation in future status. TargetStart: ${targetWeekStartDateUTC}, ReferenceStart: ${referenceWeekStartDateUTC}`);
            return "❌ خطا در محاسبه تاریخ هفته.";
        }

        const timeDifference = targetWeekStartDateUTC.getTime() - referenceWeekStartDateUTC.getTime();
        const daysDifferenceFromReference = Math.floor(timeDifference / MS_PER_DAY);
        const weeksPassedSinceReference = Math.floor(daysDifferenceFromReference / 7);
        
        // Calculate future status using same logic as getWeekStatus
        const futureStatus = weeksPassedSinceReference % 2 === 0 
            ? REFERENCE_STATUS 
            : REFERENCE_STATUS === "زوج" ? "فرد" : "زوج";

        const futureNextWeekStatus = futureStatus === "زوج" ? "فرد" : "زوج";
        const futureStatusEmoji = futureStatus === "زوج" ? "🟢" : "🟣";
        const nextWeekStatusEmoji = futureStatus === "زوج" ? "🟣" : "🟢";

        const persianDaysOfWeek = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
        const persianDayIndexCorrect = (futureDateUTC.getUTCDay() + 1) % 7;
        const persianDayOfWeek = persianDaysOfWeek[persianDayIndexCorrect];

        const currentWeekStartDateUTC = getStartOfWeekPersian(todayTehranAsUTC);
        const weeksTimeDiff = targetWeekStartDateUTC.getTime() - currentWeekStartDateUTC.getTime();
        const weeksDifferenceFromToday = Math.round(weeksTimeDiff / (7 * MS_PER_DAY));
        console.log(`[Teleport] Weeks difference: ${weeksDifferenceFromToday} (${weeksTimeDiff / (7 * MS_PER_DAY)})`);

        let weeksFromTodayText = "";
        if (weeksDifferenceFromToday === 0) weeksFromTodayText = "(هفته جاری)";
        else if (weeksDifferenceFromToday === 1) weeksFromTodayText = "(هفته آینده)";
        else if (weeksDifferenceFromToday > 1) weeksFromTodayText = `(${weeksDifferenceFromToday} هفته از امروز)`;
        else if (weeksDifferenceFromToday < 0) weeksFromTodayText = `(${Math.abs(weeksDifferenceFromToday)} هفته قبل)`;

        const monthName = getPersianMonthName(parsedDate.month);

        return `🔮 نتیجه تلپورت به آینده\n📅 تاریخ: ${persianDayOfWeek} ${parsedDate.day} ${monthName} ${parsedDate.year} ${weeksFromTodayText}\n\n${futureStatusEmoji} هفته مورد نظر: هفته *${futureStatus}* خواهد بود\n${nextWeekStatusEmoji} هفته بعد آن: هفته *${futureNextWeekStatus}* خواهد بود\n\nمی‌توانید تاریخ دیگری را با دستور /teleport بررسی کنید.`;

    } catch (e) {
        console.error(`Error calculating future week status for input "${persianDateStr}": ${e.stack}`);
        return `❌ خطا در محاسبه وضعیت هفته آینده. (${e.message})`;
    }
}

async function handleTeleportCommand(message) {
     const chatId = message.chat.id;
     const text = message.text || "";
     const user = message.from || { id: "unknown" };
     await logUsage(user, message.chat, `/teleport ${text}`);

     try {
        const parts = text.split(/[\s]+/);
        let dateString = "";
        if (parts.length > 1 && parts[1]) {
            dateString = parts.slice(1).join(" ").trim();
        }

        if (!dateString) {
            // Instead of sending help, trigger the "ask_date" flow
            await kv.set([`state:${user.id}`], JSON.stringify({ name: "awaiting_teleport_date" }), { expireIn: 5 * 60 * 1000 });
            await sendMessage(chatId, "🔮 لطفاً تاریخ شمسی مورد نظر را به فرمت `سال/ماه/روز` ارسال کنید (مثال: `1403/08/25`).", {
                inline_keyboard: [[{ text: "❌ لغو", callback_data: "cancel_action" }]]
            }, message.message_id);
        } else {
            const response = await calculateFutureWeekStatus(dateString);
            const replyMarkup = {
                inline_keyboard: [
                    [{ text: "🔮 تلپورت دوباره", callback_data: "teleport:ask_date" }],
                    [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }],
                ],
            };
            await sendMessage(chatId, response, replyMarkup, message.message_id);
        }
     } catch (error) {
        console.error(`[Command:/teleport] Error for chat ${chatId}: ${error.stack}`);
        await sendMessage(chatId, "⚠️ خطا در پردازش دستور /teleport.", null, message.message_id);
     }
}


// --- Main Callback Query Handler ---
async function handleCallbackQuery(query) {
    const handlerStartTime = Date.now();
    if (!query || !query.id || !query.from || !query.message) {
        console.error("[Callback] Received invalid callback query structure");
        if (query?.id) await answerCallbackQuery(query.id);
        return;
    }

    const queryId = query.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const data = query.data;
    const user = query.from; // Contains user info
    const chat = query.message.chat; // Contains chat info

    console.log(`[Callback:${queryId}] User:${userId} Chat:${chatId} Msg:${messageId} Data: ${data}`);
    await logUsage(user, chat, `callback:${data}`); // Log callback action

    const isAdmin = String(userId) === ADMIN_CHAT_ID;
    const isPrivate = chat.type === "private";

    try {
        const parts = data.split(':');
        const command = parts[0];
        const action = parts[1];
        const params = parts.slice(2); // Remaining parts as parameters

        // --- Generic Actions ---
        if (command === 'cancel_action') {
            await kv.delete([`state:${userId}`]); // Clear any pending state
            await editMessageText(chatId, messageId, "عملیات لغو شد.", { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]] });
            await answerCallbackQuery(queryId, "لغو شد");
            return;
        }
        if (command === 'back') {
             const prevCallbackData = params.join(':'); // Reconstruct previous data
             console.log(`[Callback:${queryId}] Back action triggered. Returning to: ${prevCallbackData}`);
             // Simulate a new callback with the previous data
             // Note: Need to pass the original query object for context if needed by handlers
             query.data = prevCallbackData; // Modify the query object for the next handler
             await handleCallbackQuery(query); // Re-call the handler with modified data
             // No answerCallbackQuery here, it will be handled by the new handler
             return;
        }

        // --- Menu Navigation ---
        if (command === 'menu') {
            if (action === 'help') {
                await handleHelpCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                await answerCallbackQuery(queryId);
            } else if (action === 'week_status') {
                 await handleWeekCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                await answerCallbackQuery(queryId); // Answered inside handler likely
            } else if (action === 'schedule') {
                 if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
                 await handleScheduleCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                 await answerCallbackQuery(queryId);
            }
        }

        // --- PDF Export ---
        else if (command === 'pdf' && action === 'export') {
             if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             await answerCallbackQuery(queryId, "⏳ در حال آماده‌سازی PDF برنامه شما...");
             try {
                 const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim() || `کاربر ${user.id}`;
                 const pdfBuffer = await generateSchedulePDF(user.id, fullName);
                 const fileName = `schedule_${fullName.replace(/[^a-zA-Z0-9]/g, '_')}_${user.id}.pdf`;
                 console.log(`[Callback:${queryId}] PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB), sending: ${fileName}`);
                 await sendDocument(chatId, pdfBuffer, fileName, `📅 برنامه هفتگی شما - ${fullName}`, {
                     inline_keyboard: [
                        [{ text: "↩️ بازگشت به منوی برنامه", callback_data: "menu:schedule" }]
                    ]
                 });
             } catch (pdfError) {
                 console.error(`!!! [Callback:${queryId}] Error during PDF generation/sending:`, pdfError.stack);
                 await answerCallbackQuery(queryId, "⚠️ خطا در تولید یا ارسال PDF.", true);
                 await editMessageText(chatId, messageId, "⚠️ متاسفانه در تولید PDF خطایی رخ داد.", { 
                     inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "menu:schedule" }]] 
                 }).catch(()=>{});
             }
        }

        // --- Teleport ---
        else if (command === 'teleport') {
            if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             if (action === 'ask_date') {
                await kv.set([`state:${userId}`], JSON.stringify({ name: "awaiting_teleport_date" }), { expireIn: 5 * 60 * 1000 });
                await editMessageText(chatId, messageId, "🔮 لطفاً تاریخ شمسی مورد نظر را به فرمت `سال/ماه/روز` ارسال کنید (مثال: `1403/08/25`).", {
                    inline_keyboard: [[{ text: "❌ لغو", callback_data: "cancel_action" }]]
                });
                await answerCallbackQuery(queryId, "منتظر دریافت تاریخ...");
            }
        }

        // --- Schedule Management ---
        else if (command === 'schedule') {
             if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             await handleScheduleCallback(query, action, params); // Delegate to separate handler
             // answerCallbackQuery will be handled within handleScheduleCallback
        }

        // --- Admin Actions ---
        else if (command === 'admin') {
            if (!isAdmin || !isPrivate) { await answerCallbackQuery(queryId, "⛔️ فقط ادمین در چت خصوصی", true); return; }
            await handleAdminCallback(query, action, params); // Delegate
             // answerCallbackQuery handled within handleAdminCallback
        }

        // --- Fallback ---
        else {
            console.warn(`[Callback:${queryId}] Unhandled callback command: ${command}`);
            await answerCallbackQuery(queryId); // Acknowledge silently
        }

        // --- Performance Logging ---
        const handlerDuration = Date.now() - handlerStartTime;
        if (handlerDuration > 1500) { // Log if handler takes longer than 1.5 seconds
            console.warn(`[Callback:${queryId}] Slow Handler (${handlerDuration}ms) for Data: ${data}`);
        } else {
             console.log(`[Callback:${queryId}] END (${handlerDuration}ms)`);
        }

    } catch (error) {
        const handlerDuration = Date.now() - handlerStartTime;
        console.error(`!!! [Callback:${query?.id}] Top-level error processing query (took ${handlerDuration}ms), data ${query?.data} User ${query?.from?.id}:`, error.stack);
        try { await answerCallbackQuery(query?.id, "خطا در پردازش درخواست.", true); }
        catch (answerError) { console.error("!! Failed to answer callback query after error:", answerError); }
        await sendMessage(ADMIN_CHAT_ID, `🆘 Error in handleCallbackQuery for data ${query?.data} User ${query?.from?.id}: ${error.message}`).catch(ne => console.error("Failed admin notify", ne));
    }
}

// --- Dedicated Handler for Schedule Callbacks ---
async function handleScheduleCallback(query, action, params) {
    const { id: queryId, from: user, message } = query;
    const { chat: { id: chatId }, message_id: messageId } = message;
    const userId = user.id;

    // Ensure user exists before schedule actions
    await addUser(user, message.chat);

    const weekType = params[0]; // e.g., 'odd', 'even'
    const day = params[1]; // e.g., 'monday'
    const lessonIndex = params[2] ? parseInt(params[2]) : null;

    console.log(`[ScheduleCallback] Action: ${action}, Params: ${params}`);

    // --- Viewing ---
    if (action === 'view' && params[0] === 'full') {
        const schedule = await getUserSchedule(userId);
        let scheduleMessage = `📅 *برنامه کامل هفتگی شما*\n\n`;
        let hasAnySchedule = false;

        const formatWeek = (type, scheduleData) => {
            const label = type === 'odd' ? 'فرد 🟣' : 'زوج 🟢';
            let weekText = `*--- هفته ${label} ---*\n`;
            let hasScheduleThisWeek = false;
            ENGLISH_WEEKDAYS.forEach((dKey, index) => {
                const lessons = scheduleData[dKey] || [];
                if (lessons.length > 0) {
                    hasScheduleThisWeek = true; hasAnySchedule = true;
                    weekText += `\n*${PERSIAN_WEEKDAYS[index]}:*\n`;
                    lessons.forEach((l, idx) => { // Add index for potential delete later
                        weekText += ` ${idx + 1}. *${l.lesson}*\n    ⏰ ${l.start_time}-${l.end_time} | 📍 ${l.location || '-'}\n`;
                    });
                }
            });
            if (!hasScheduleThisWeek) weekText += "_برنامه‌ای برای این هفته تنظیم نشده است._\n";
            return weekText + "\n";
        };

        scheduleMessage += formatWeek("odd", schedule.odd_week_schedule);
        scheduleMessage += formatWeek("even", schedule.even_week_schedule);

        if (!hasAnySchedule) scheduleMessage = "📅 *برنامه هفتگی شما*\n\n_هنوز هیچ درسی برای هیچ هفته‌ای تنظیم نکرده‌اید._";

        const replyMarkup = {
             inline_keyboard: [
                [{ text: "⚙️ تنظیم / افزودن درس", callback_data: "schedule:set:select_week" }],
                [{ text: "🗑️ حذف درس / روز / هفته", callback_data: "schedule:delete:main" }],
                [{ text: "📤 خروجی PDF", callback_data: "pdf:export" }],
                [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]
             ]
        };
        await editMessageText(chatId, messageId, scheduleMessage, replyMarkup);
        await answerCallbackQuery(queryId);
    }

    // --- Setting Flow ---
    else if (action === 'set') {
        if (params[0] === 'select_week') {
             const scheduleMessage = `📅 *تنظیم برنامه هفتگی*\n\nبرنامه کدام هفته را می‌خواهید تنظیم یا ویرایش کنید؟`;
             const replyMarkup = {
                  inline_keyboard: [
                      [{ text: "هفته فرد 🟣", callback_data: "schedule:set:select_day:odd" }, { text: "هفته زوج 🟢", callback_data: "schedule:set:select_day:even" }],
                      [{ text: "↩️ بازگشت (منو برنامه)", callback_data: "menu:schedule" }]
                    ]
             };
             await editMessageText(chatId, messageId, scheduleMessage, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'select_day') {
             const weekType = params[1]; // 'odd' or 'even'
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayButtons = ENGLISH_WEEKDAYS.map((dayKey, index) => ({
                text: PERSIAN_WEEKDAYS[index],
                callback_data: `schedule:set:show_day:${weekType}:${dayKey}`
             }));
             // Group buttons in rows of 2
             const rows = [];
             for (let i = 0; i < dayButtons.length; i += 2) {
                rows.push(dayButtons.slice(i, i + 2));
             }
             const replyMarkup = {
                  inline_keyboard: [
                      ...rows,
                      [{ text: "↩️ بازگشت (انتخاب هفته)", callback_data: "schedule:set:select_week" }]
                  ]
             };
             await editMessageText(chatId, messageId, `📅 *تنظیم برنامه هفته ${weekLabel}*\n\nلطفاً روز مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
         else if (params[0] === 'show_day') {
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];

             const schedule = await getUserSchedule(userId);
             const lessons = (weekType === "odd" ? schedule.odd_week_schedule[day] : schedule.even_week_schedule[day]) || [];

             let messageText = `🗓️ *برنامه روز ${dayLabel} - هفته ${weekLabel}*\n\n`;
             if (lessons.length === 0) {
                messageText += "_هنوز درسی برای این روز ثبت نشده است._\n";
             } else {
                 lessons.forEach((l, idx) => {
                    messageText += ` ${idx + 1}. *${l.lesson}* ( ${l.start_time} - ${l.end_time} | ${l.location || '-'} )\n`;
                 });
             }
              messageText += "\nمی‌توانید درس جدیدی اضافه کنید:";

             const replyMarkup = {
                  inline_keyboard: [
                    [{ text: "➕ افزودن درس جدید", callback_data: `schedule:set:ask_details:${weekType}:${day}` }],
                    // Add delete buttons if needed later or handle via delete flow
                    [{ text: `↩️ بازگشت (انتخاب روز ${weekLabel})`, callback_data: `schedule:set:select_day:${weekType}` }]
                  ]
             };
             await editMessageText(chatId, messageId, messageText, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'ask_details') {
            const weekType = params[1];
            const day = params[2];
            const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
            const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];

            // Set KV state to await lesson details
             await kv.set([`state:${userId}`], JSON.stringify({
                name: "awaiting_lesson_details",
                weekType: weekType,
                day: day
             }), { expireIn: 10 * 60 * 1000 }); // 10 min expiry

            const messageText = `➕ *افزودن درس به ${dayLabel} (هفته ${weekLabel})*\n\n` +
                                "لطفاً اطلاعات درس را در یک پیام و با فرمت زیر ارسال کنید:\n" +
                                "`نام کامل درس` - `ساعت شروع` - `ساعت پایان` - `محل برگزاری`\n\n" +
                                "*مثال:*\n" +
                                "`برنامه سازی پیشرفته` - `8:00` - `10:00` - `کلاس 309 ابریشم چیان`\n\n" +
                                "*نکات:*\n" +
                                "• از خط تیره (-) برای جدا کردن بخش‌ها استفاده کنید.\n" +
                                "• ساعت‌ها را به فرمت `HH:MM` (مانند `13:30` یا `08:00`) وارد کنید.";

            const replyMarkup = { inline_keyboard: [[{ text: "❌ لغو و بازگشت", callback_data: `schedule:set:show_day:${weekType}:${day}` }]] };
            await editMessageText(chatId, messageId, messageText, replyMarkup);
            await answerCallbackQuery(queryId, "لطفاً اطلاعات درس را وارد کنید...");
        }
    }

    // --- Deleting Flow ---
    else if (action === 'delete') {
         if (params[0] === 'main') {
            const replyMarkup = {
                 inline_keyboard: [
                     [{ text: "🟣 حذف کل هفته فرد", callback_data: "schedule:delete:confirm_week:odd" }],
                     [{ text: "🟢 حذف کل هفته زوج", callback_data: "schedule:delete:confirm_week:even" }],
                     [{ text: "🗑️ حذف دروس یک روز خاص", callback_data: "schedule:delete:select_week:day" }],
                     [{ text: "❌ حذف یک درس خاص", callback_data: "schedule:delete:select_week:lesson" }],
                     [{ text: "↩️ بازگشت (منو برنامه)", callback_data: "menu:schedule" }]
                 ]
            };
            await editMessageText(chatId, messageId, "🗑️ *حذف برنامه*\n\nکدام بخش از برنامه را می‌خواهید حذف کنید؟\n*توجه:* این عملیات غیرقابل بازگشت است.", replyMarkup);
            await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'confirm_week') { // Confirmation for deleting whole week
             const weekType = params[1];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن هفته ${weekLabel}`, callback_data: `schedule:delete:execute_week:${weekType}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: "schedule:delete:main" }]
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف کل هفته ${weekLabel}*\n\nآیا مطمئن هستید که می‌خواهید تمام دروس ثبت شده برای هفته ${weekLabel} را حذف کنید؟`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
         else if (params[0] === 'execute_week') { // Execute delete whole week
             const weekType = params[1];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             try {
                 await deleteEntireWeekSchedule(userId, weekType);
                 await editMessageText(chatId, messageId, `✅ تمام دروس هفته ${weekLabel} با موفقیت حذف شدند.`, { inline_keyboard: [[{ text: "↩️ بازگشت به منوی حذف", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, `هفته ${weekLabel} حذف شد`);
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف هفته ${weekLabel}: ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }
         else if (params[0] === 'select_week') { // Select week for deleting day or lesson
             const deleteType = params[1]; // 'day' or 'lesson'
             const typeLabel = deleteType === 'day' ? 'روز' : 'درس';
             const nextAction = `schedule:delete:select_day:${deleteType}`;
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: "هفته فرد 🟣", callback_data: `${nextAction}:odd` }, { text: "هفته زوج 🟢", callback_data: `${nextAction}:even` }],
                    [{ text: "↩️ بازگشت (منو حذف)", callback_data: "schedule:delete:main" }]
                 ]
             };
             await editMessageText(chatId, messageId, `🗑️ *حذف ${typeLabel}*\n\nلطفاً هفته مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'select_day') { // Select day for deleting day or lesson
             const deleteType = params[1]; // 'day' or 'lesson'
             const weekType = params[2]; // 'odd' or 'even'
             const typeLabel = deleteType === 'day' ? 'روز' : 'درس';
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const schedule = await getUserSchedule(userId);
             const weekSchedule = weekType === 'odd' ? schedule.odd_week_schedule : schedule.even_week_schedule;

             const dayButtons = ENGLISH_WEEKDAYS
                 .filter(dayKey => weekSchedule[dayKey] && weekSchedule[dayKey].length > 0) // Only show days with lessons
                 .map((dayKey, index) => ({
                     text: PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(dayKey)], // Get correct Persian name
                     callback_data: deleteType === 'day'
                                     ? `schedule:delete:confirm_day:${weekType}:${dayKey}` // Confirm day delete
                                     : `schedule:delete:select_lesson:${weekType}:${dayKey}` // Select lesson to delete
                 }));

             if (dayButtons.length === 0) {
                 await editMessageText(chatId, messageId, `⚠️ در هفته ${weekLabel} هیچ روزی با برنامه ثبت شده یافت نشد.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_week:${deleteType}` }]] });
                 await answerCallbackQuery(queryId, "برنامه‌ای یافت نشد");
                 return;
             }

             const rows = []; for (let i = 0; i < dayButtons.length; i += 2) { rows.push(dayButtons.slice(i, i + 2)); }
             const replyMarkup = {
                  inline_keyboard: [
                      ...rows,
                      [{ text: "↩️ بازگشت (انتخاب هفته)", callback_data: `schedule:delete:select_week:${deleteType}` }]
                  ]
             };
             await editMessageText(chatId, messageId, `🗑️ *حذف ${typeLabel} (هفته ${weekLabel})*\n\nلطفاً روز مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
          else if (params[0] === 'confirm_day') { // Confirm delete day
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن ${dayLabel} (${weekLabel})`, callback_data: `schedule:delete:execute_day:${weekType}:${day}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: `schedule:delete:select_day:day:${weekType}` }] // Back to day selection for this week
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف روز ${dayLabel} (هفته ${weekLabel})*\n\nآیا مطمئن هستید که می‌خواهید تمام دروس ثبت شده برای این روز را حذف کنید؟`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'execute_day') { // Execute delete day
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             try {
                 await deleteUserScheduleDay(userId, weekType, day);
                 await editMessageText(chatId, messageId, `✅ تمام دروس روز ${dayLabel} (${weekLabel}) حذف شدند.`, { inline_keyboard: [[{ text: "↩️ بازگشت به منوی حذف", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, `روز ${dayLabel} حذف شد`);
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف روز ${dayLabel} (${weekLabel}): ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }
         else if (params[0] === 'select_lesson') { // Show lessons of a day to select one for deletion
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];

             const schedule = await getUserSchedule(userId);
             const lessons = (weekType === "odd" ? schedule.odd_week_schedule[day] : schedule.even_week_schedule[day]) || [];

              if (lessons.length === 0) {
                 await editMessageText(chatId, messageId, `⚠️ در روز ${dayLabel} (${weekLabel}) درسی برای حذف یافت نشد.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_day:lesson:${weekType}` }]] });
                 await answerCallbackQuery(queryId, "درسی یافت نشد");
                 return;
             }

             let messageText = `🗑️ *حذف درس خاص*\nروز: ${dayLabel} | هفته: ${weekLabel}\n\nکدام درس را می‌خواهید حذف کنید؟\n`;
             const lessonButtons = lessons.map((l, idx) => ([{
                text: `❌ ${idx + 1}. ${l.lesson} (${l.start_time}-${l.end_time})`,
                callback_data: `schedule:delete:confirm_lesson:${weekType}:${day}:${idx}`
             }]));

             const replyMarkup = {
                 inline_keyboard: [
                     ...lessonButtons,
                     [{ text: "↩️ بازگشت (انتخاب روز)", callback_data: `schedule:delete:select_day:lesson:${weekType}` }]
                 ]
             };
             await editMessageText(chatId, messageId, messageText, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'confirm_lesson') { // Confirm delete specific lesson
             const weekType = params[1];
             const day = params[2];
             const lessonIndex = parseInt(params[3]);
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];

             const schedule = await getUserSchedule(userId);
             const lesson = (weekType === "odd" ? schedule.odd_week_schedule[day]?.[lessonIndex] : schedule.even_week_schedule[day]?.[lessonIndex]);

             if (!lesson) {
                await editMessageText(chatId, messageId, "⚠️ خطا: درس مورد نظر یافت نشد.", { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                await answerCallbackQuery(queryId, "درس یافت نشد", true);
                return;
             }

             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن`, callback_data: `schedule:delete:execute_lesson:${weekType}:${day}:${lessonIndex}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف درس*\n\nآیا مطمئن هستید می‌خواهید درس زیر را حذف کنید؟\n\n*درس:* ${lesson.lesson}\n*زمان:* ${lesson.start_time} - ${lesson.end_time}\n*روز:* ${dayLabel} (${weekLabel})`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'execute_lesson') { // Execute delete lesson
             const weekType = params[1];
             const day = params[2];
             const lessonIndex = parseInt(params[3]);
             try {
                 const success = await deleteUserScheduleLesson(userId, weekType, day, lessonIndex);
                 if (success) {
                    // Go back to the lesson selection view for that day to show updated list
                     query.data = `schedule:delete:select_lesson:${weekType}:${day}`;
                     await handleCallbackQuery(query); // Re-call handler to refresh view
                     await answerCallbackQuery(queryId, `درس حذف شد`);
                 } else {
                      await editMessageText(chatId, messageId, `⚠️ درس مورد نظر یافت نشد یا قبلاً حذف شده است.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                      await answerCallbackQuery(queryId, "درس یافت نشد");
                 }
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف درس: ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }

    } // End delete actions

    else {
         console.warn(`[ScheduleCallback] Unhandled action: ${action} with params: ${params}`);
         await answerCallbackQuery(queryId); // Acknowledge silently
    }
}

// --- Dedicated Handler for Admin Callbacks ---
async function handleAdminCallback(query, action, params) {
     const { id: queryId, from: user, message } = query;
     const { chat: { id: chatId }, message_id: messageId } = message;
     const userId = user.id;

     if (action === 'panel') {
        await handleAdminCommand({ ...message, from: user, callback_query_id: queryId }, true);
        await answerCallbackQuery(queryId);
     }
     else if (action === 'stats') {
        await handleStatsCommand({ ...message, from: user, callback_query_id: queryId }, true);
     }
     else {
        console.warn(`[AdminCallback] Unhandled action: ${action} with params: ${params}`);
        await answerCallbackQuery(queryId);
    }
}


// --- Main Message Handler ---
async function handleMessage(message) {
    const handlerStartTime = Date.now();
    if (!message || !message.chat || !message.from) {
        console.warn(`[handleMessage] Ignoring message with missing info`);
        return;
    }
    const messageId = message.message_id;
    const chatId = message.chat.id;
    const user = message.from;
    const chat = message.chat;
    const text = message.text || "";
    const chatType = message.chat.type;
    const isAdmin = String(user.id) === ADMIN_CHAT_ID;

    console.log(`[handleMessage:${messageId}] START User:${user.id} Chat:${chatId} Type:${chatType}`);

    // --- Group Management & Bot Add/Remove ---
    if (chatType === "group" || chatType === "supergroup") {
        const botInfo = await getBotInfo();
        if (botInfo.id && message.new_chat_members?.some(member => String(member.id) === botInfo.id)) {
            console.log(`[handleMessage:${messageId}] Bot added to group ${chatId} (${chat.title})`);
            await addGroup(chat); // Add/Update group in Supabase
            await logUsage(user, chat, "bot_added_to_group");
            const welcomeMessage = `سلام! 👋 من ربات وضعیت هفته و برنامه درسی هستم.\nدستورات اصلی:\n/week - نمایش وضعیت هفته\n/help - راهنما\n\nبرای تنظیم برنامه شخصی، در چت خصوصی با من (@${botInfo.username}) صحبت کنید.`;
            await sendMessage(chatId, welcomeMessage);
            return;
        }
        if (botInfo.id && message.left_chat_member && String(message.left_chat_member.id) === botInfo.id) {
            console.log(`[handleMessage:${messageId}] Bot removed/left group: ${chatId} (${chat.title})`);
            await logUsage(user, chat, "bot_removed_from_group");
            // Optional: Delete group from Supabase 'groups' table if needed
            // await supabase.from("groups").delete().eq("group_id", chatId);
            return;
        }
    }

    // Ignore messages from other bots
    if (user.is_bot) {
        console.log(`[handleMessage:${messageId}] Ignoring message from bot ${user.id}`);
        return;
    }

    // Log usage for non-bot messages
    // Decide action type later based on command/state

    // --- Handle Pending States (Private Chat Only) ---
    if (chatType === "private") {
        const stateResult = await kv.get([`state:${user.id}`]);
        if (stateResult.value) {
            let state;
            try { state = JSON.parse(stateResult.value); } catch (e) { /* Invalid state */ await kv.delete([`state:${user.id}`]); return; }

            console.log(`[handleMessage:${messageId}] User ${user.id} has state: ${state.name}`);

            if (state.name === "awaiting_teleport_date") {
                 await kv.delete([`state:${user.id}`]); // Clear state
                 await logUsage(user, chat, `input:teleport_date`);
                 const response = await calculateFutureWeekStatus(text); // Reuse the function
                 const replyMarkup = { inline_keyboard: [ [{ text: "🔮 تلپورت دوباره", callback_data: "teleport:ask_date" }], [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }] ] };
                 await sendMessage(chatId, response, replyMarkup, messageId);
                 return;
            }
             else if (state.name === "awaiting_lesson_details") {
                 await kv.delete([`state:${user.id}`]); // Clear state immediately
                 await logUsage(user, chat, `input:lesson_details`);
                 
                 // Parse lesson details from text
                 const parts = text.split('-').map(p => p.trim());
                 if (parts.length !== 4) {
                     await sendMessage(chatId, "⚠️ فرمت وارد شده صحیح نیست. لطفاً با فرمت زیر وارد کنید:\n`نام درس` - `ساعت شروع` - `ساعت پایان` - `محل برگزاری`", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }

                 const [lesson, startTime, endTime, location] = parts;
                 
                 // Validate times
                 if (!SCHEDULE_TIME_REGEX.test(startTime) || !SCHEDULE_TIME_REGEX.test(endTime)) {
                     await sendMessage(chatId, "⚠️ فرمت ساعت باید به صورت `HH:MM` باشد. مثال: `08:30` یا `13:45`", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }

                 // Validate start time is before end time
                 const startMinutes = parseTime(startTime);
                 const endMinutes = parseTime(endTime);
                 if (startMinutes >= endMinutes) {
                     await sendMessage(chatId, "⚠️ ساعت شروع باید قبل از ساعت پایان باشد.", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }

                 try {
                     // Add the lesson
                     await saveUserSchedule(user.id, state.weekType, state.day, {
                         lesson: lesson,
                         start_time: startTime,
                         end_time: endTime,
                         location: location
                     });

                     const weekLabel = state.weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
                     const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(state.day)];

                     // Send success message
                     await sendMessage(chatId, `✅ درس *${lesson}* با موفقیت به برنامه روز ${dayLabel} (هفته ${weekLabel}) اضافه شد.`);

                     // Show updated schedule
                     const schedule = await getUserSchedule(user.id);
                     const lessons = (state.weekType === "odd" ? schedule.odd_week_schedule[state.day] : schedule.even_week_schedule[state.day]) || [];

                     let messageText = `🗓️ *برنامه روز ${dayLabel} - هفته ${weekLabel}*\n\n`;
                     lessons.forEach((l, idx) => {
                         messageText += `${idx + 1}. *${l.lesson}*\n   ⏰ ${l.start_time} - ${l.end_time}\n   📍 ${l.location || '-'}\n`;
                     });

                     const replyMarkup = {
                         inline_keyboard: [
                             [{ text: "➕ افزودن درس دیگر", callback_data: `schedule:set:ask_details:${state.weekType}:${state.day}` }],
                             [{ text: "↩️ بازگشت به انتخاب روز", callback_data: `schedule:set:select_day:${state.weekType}` }],
                             [{ text: "🏠 منوی اصلی", callback_data: "menu:help" }]
                         ]
                     };

                     await sendMessage(chatId, messageText, replyMarkup);

                 } catch (e) {
                     console.error(`[Schedule] Error saving lesson for user ${user.id}:`, e.stack);
                     await sendMessage(chatId, `⚠️ خطا در ذخیره درس: ${e.message}`, {
                         inline_keyboard: [[{ text: "↩️ تلاش مجدد", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                 }
                 return;
            }
            // Add other state handlers here if needed

             console.warn(`[Message] User ${user.id} had unhandled state: ${state.name}. Clearing state.`);
             await kv.delete([`state:${user.id}`]); // Clear unhandled state
        } // End if state exists

        // --- Handle Broadcast Input (Admin Only, Private Chat, No State) ---
        const isBroadcasting = (await kv.get(["broadcastMode"])).value === "true";
        if (isAdmin && isBroadcasting && !text.startsWith("/")) {
            await logUsage(user, chat, `input:broadcast_confirm`);
            const targetType = (await kv.get(["broadcastTarget"])).value || "users";
            const targetLabel = targetType === "users" ? "کاربران" : "گروه‌ها";

            // Fetch count (can be slightly delayed, but okay for confirmation)
             const { count, error } = await supabase
                .from(targetType)
                .select(targetType === 'users' ? 'chat_id' : 'group_id', { count: 'exact', head: true });
             const targetCount = error ? '؟' : (count ?? 0);

            const confirmMessage = `📢 *تأیید ارسال اعلان*\n\nپیام زیر به حدود ${targetCount} ${targetLabel} فوروارد خواهد شد. آیا مطمئن هستید؟\n\n*(برای دیدن پیش‌نمایش، پیام اصلی بالا را ببینید)*`;
            const replyMarkup = {
                 inline_keyboard: [
                    [{ text: "✅ بله، ارسال کن", callback_data: `admin:broadcast:confirm:${messageId}` }], // Include original message ID
                    [{ text: "❌ لغو", callback_data: "admin:broadcast:cancel" }]
                ]
            };
            // Send confirmation as a NEW message, referencing the original implicitly
            await sendMessage(chatId, confirmMessage, replyMarkup);
            return; // Handled broadcast confirmation trigger
        }
    } // End private chat specific handlers

    // --- Handle Commands ---
    if (text.startsWith("/")) {
        const commandStartTime = Date.now();
        const commandPart = text.split(/[\s@]/)[0].toLowerCase(); // Extract command like /start
        const botInfo = await getBotInfo();

        // Ignore command if it contains @ and it's not this bot's username (in groups)
        if (chatType !== 'private' && text.includes("@") && botInfo.username && !text.toLowerCase().includes(`@${botInfo.username.toLowerCase()}`)) {
            console.log(`[handleMessage:${messageId}] Ignoring command ${commandPart} intended for another bot.`);
            return;
        }

        let logAction = commandPart; // Log the command itself
        console.log(`[handleMessage:${messageId}] Processing command: ${commandPart}`);

        try {
            switch (commandPart) {
              case "/start": await handleStartCommand(message); break;
              case "/help": await handleHelpCommand(message); break;
              case "/week": await handleWeekCommand(message); break;
              case "/schedule": await handleScheduleCommand(message); break;
              case "/admin": await handleAdminCommand(message); break;
              case "/stats": await handleStatsCommand(message); break;
              case "/teleport": await handleTeleportCommand(message); break;
              // Add other commands if any
              default:
                logAction = `unknown_command: ${commandPart}`;
                if (chatType === "private") {
                    await sendMessage(chatId, `❓ دستور \`${commandPart}\` را متوجه نشدم. لطفاً از /help استفاده کنید.`, null, messageId);
                } // Silently ignore unknown commands in groups
            }
            const commandDuration = Date.now() - commandStartTime;
            console.log(`[handleMessage:${messageId}] Command ${commandPart} processed in ${commandDuration}ms`);
        } catch (commandError) {
             logAction = `command_error: ${commandPart}`;
             console.error(`!!! [handleMessage:${messageId}] Error executing command ${commandPart}:`, commandError.stack);
             await sendMessage(ADMIN_CHAT_ID, `🆘 Error executing ${commandPart} for user ${user.id}: ${commandError.message}`).catch(ne=>console.error("Failed admin notify", ne));
             await sendMessage(chatId, "⚠️ متاسفانه در پردازش دستور شما خطایی رخ داد.", null, messageId).catch(()=>{}); // Notify user
        }
        // Log usage *after* command processing attempt
        await logUsage(user, chat, logAction);

    } else if (chatType === "private") {
        // Handle non-command, non-state messages in private chat (e.g., casual text)
        await logUsage(user, chat, "non_command_private");
        console.log(`[handleMessage:${messageId}] Non-command/state message in private chat`);
        // Optional: Send a default reply or help prompt
        // await sendMessage(chatId, `سلام ${user.first_name}! اگر به راهنمایی نیاز دارید، از /help استفاده کنید.`, null, messageId);
    } else {
        // Ignore non-command messages in groups silently
        // await logUsage(user, chat, "non_command_group_ignored");
    }

    // --- Performance Logging ---
    const handlerDuration = Date.now() - handlerStartTime;
     if (handlerDuration > 2000) { // Log if handler takes longer than 2 seconds
        console.warn(`[handleMessage:${messageId}] Slow Handler (${handlerDuration}ms) for Type: ${chatType}, Text: ${text.substring(0,50)}`);
    } else {
        console.log(`[handleMessage:${messageId}] END (${handlerDuration}ms)`);
    }

}


// --- Webhook Request Handler ---
async function handleRequest(request) {
    const requestStartTime = Date.now();
    const url = new URL(request.url);
    console.log(`[Webhook] >>> ${request.method} ${url.pathname}`);

    if (request.method !== "POST" || url.pathname !== "/") {
        console.log(`[Webhook] Invalid method/path. Returning 405/404.`);
        return new Response("Not Found or Method Not Allowed", { status: url.pathname === "/" ? 405 : 404 });
    }

    let update;
    try {
        const contentType = request.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            console.error("[Webhook] Invalid content-type:", contentType);
            return new Response("Invalid Content-Type", { status: 415 });
        }
        update = await request.json();

        if (update && update.update_id) {
            Promise.resolve().then(() => {
                if (update.message) {
                    console.log(`[Webhook] Update ${update.update_id} -> handleMessage`);
                    handleMessage(update.message).catch(e => {
                         console.error(`!!! [Webhook] Uncaught error in handleMessage for update ${update.update_id}:`, e.stack);
                         sendMessage(ADMIN_CHAT_ID, `🆘 Uncaught handleMessage Error: ${e.message}`).catch(()=>{});
                    });
                } else if (update.callback_query) {
                    console.log(`[Webhook] Update ${update.update_id} -> handleCallbackQuery`);
                    handleCallbackQuery(update.callback_query).catch(e => {
                         console.error(`!!! [Webhook] Uncaught error in handleCallbackQuery for update ${update.update_id}:`, e.stack);
                         sendMessage(ADMIN_CHAT_ID, `🆘 Uncaught handleCallbackQuery Error: ${e.message}`).catch(()=>{});
                    });
                } else {
                    console.log(`[Webhook] Update ${update.update_id} has unhandled type:`, Object.keys(update));
                }
            }).catch(e => console.error("Error in async update processing wrapper:", e));
        } else {
             console.warn("[Webhook] Invalid update structure received:", update);
        }

        const duration = Date.now() - requestStartTime;
        console.log(`<<< [Webhook] Returning 200 OK (Processing started in ${duration}ms)`);
        return new Response("OK", { status: 200 });

    } catch (e) {
        const duration = Date.now() - requestStartTime;
        console.error(`!!! [Webhook] Error parsing/handling request (took ${duration}ms):`, e.stack);
        await sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL Error processing update request: ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        return new Response("Internal Server Error", { status: 500 });
    }
}


// --- Startup Sequence ---
(async () => {
    console.log("--- Bot Initializing ---");
    let botInfo = null;
    let startError = null;

    try {
        if (!REFERENCE_DATE_GREGORIAN) throw new Error("Reference Gregorian Date calculation failed.");

        console.log("[Startup] Getting Bot Info...");
        botInfo = await getBotInfo();
        if (!botInfo || !botInfo.id) {
             console.warn("[Startup] Could not retrieve valid Bot ID. Check token/network. Some features might be limited.");
        } else {
            console.log(`[Startup] Bot Info: ID=${botInfo.id}, Username=${botInfo.username}`);
        }

        console.log("[Startup] Pre-fetching Vazir font...");
        await getVazirFont();

        const port = 8000;
        console.log(`[Startup] Attempting to start HTTP server on port ${port}...`);

        serve(handleRequest, {
             port: port,
             onListen({ port, hostname }) {
                console.log(`[Startup] ✅ Server listening on ${hostname}:${port}`);
                const startupTime = DateTime.now().setZone(TEHRAN_TIMEZONE).toFormat("yyyy/MM/dd HH:mm:ss");
                sendMessage(ADMIN_CHAT_ID, `✅ *ربات با موفقیت راه‌اندازی شد\\!*\n🆔 \`${botInfo?.id || 'N/A'}\`\n👤 @${botInfo?.username || 'N/A'}\n⏰ \`${startupTime}\`\n💾 Supabase`)
                    .catch(e => console.error("[Startup] Failed to send startup notification:", e.stack));
             },
             onError(error) {
                console.error("!!! [Startup] SERVER LISTENING ERROR:", error);
                startError = error;
                sendMessage(ADMIN_CHAT_ID, `🆘 خطای مرگبار: سرور ربات نتوانست شروع به کار کند: ${error.message}`)
                    .catch(e => console.error("[Startup] Failed to send server start error notification:", e.stack));
             }
        });
        console.log(`[Startup] Server setup initiated. Waiting for 'onListen'...`);

    } catch (e) {
        console.error("!!! CRITICAL STARTUP ERROR:", e.stack);
        startError = e;
        try {
            await sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL BOT STARTUP ERROR: ${e.message}`).catch(ne => console.error("Failed admin notify on critical startup error", ne));
        } catch (notifyError) { /* Ignore */ }
    }

    console.log(`--- Bot Initialization ${startError ? 'FAILED' : 'Complete (Server starting)'} ---`);
})();